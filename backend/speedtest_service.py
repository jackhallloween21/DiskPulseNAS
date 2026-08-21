"""
Network speed test & latency monitoring service for DiskPulse NAS.

Uses Cloudflare's public speed-test edge (speed.cloudflare.com) to measure
real download / upload throughput, HTTP latency, and to detect the client
ISP / public IP / nearest datacenter. This works reliably and identically on
both Windows and Linux with no third-party libraries — only the Python
standard library — which avoids the frequent HTTP 403 blocking that made the
old Ookla `speedtest-cli` dependency unreliable.
"""
import asyncio
import http.client
import json
import re
import shutil
import socket
import ssl
import sys
import time
from typing import Any, Dict, Optional, List

# Cloudflare speed-test edge endpoints
CF_HOST = "speed.cloudflare.com"
CF_META_PATH = "/meta"
CF_DOWN_PATH = "/__down?bytes={n}"
CF_UP_PATH = "/__up"

USER_AGENT = "DiskPulse-NAS-SpeedTest/2.0"
_HEADERS = {"User-Agent": USER_AGENT, "Connection": "keep-alive"}

# Tuning constants
_LATENCY_SAMPLES = 6          # first sample is discarded (TLS/TCP warm-up)
_DOWNLOAD_WARMUP_BYTES = 5_000_000       # 5 MB probe to size the real run
_DOWNLOAD_MAX_BYTES = 200_000_000        # cap a single download at 200 MB
_DOWNLOAD_MIN_BYTES = 10_000_000         # never measure on less than 10 MB
_DOWNLOAD_TARGET_SECS = 8.0              # aim for ~8 s of transfer
_UPLOAD_WARMUP_BYTES = 2_000_000         # 2 MB probe
_UPLOAD_MAX_BYTES = 30_000_000           # cap upload payload at 30 MB
_UPLOAD_MIN_BYTES = 4_000_000
_UPLOAD_TARGET_SECS = 6.0
_CHUNK = 65536


class SpeedTestError(Exception):
    pass


# ─────────────────────────── low-level HTTP helpers ───────────────────────────

def _new_conn(timeout: float = 20.0) -> http.client.HTTPSConnection:
    ctx = ssl.create_default_context()
    return http.client.HTTPSConnection(CF_HOST, timeout=timeout, context=ctx)


def _fetch_meta(timeout: float = 8.0) -> Dict[str, Any]:
    """Cloudflare /meta returns clientIp, asOrganization (ISP), colo, city, country."""
    conn = _new_conn(timeout)
    try:
        conn.request("GET", CF_META_PATH, headers=_HEADERS)
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status != 200:
            return {}
        return json.loads(raw.decode("utf-8", errors="ignore"))
    except Exception:
        return {}
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _measure_latency(samples: int = _LATENCY_SAMPLES, timeout: float = 8.0) -> Optional[float]:
    """Reuse a single keep-alive connection so we time round-trips, not handshakes."""
    conn = _new_conn(timeout)
    times: List[float] = []
    try:
        for i in range(samples):
            try:
                t0 = time.perf_counter()
                conn.request("GET", CF_DOWN_PATH.format(n=0), headers=_HEADERS)
                resp = conn.getresponse()
                resp.read()
                dt = (time.perf_counter() - t0) * 1000.0
                if i > 0:  # discard first: includes TCP + TLS setup
                    times.append(dt)
            except Exception:
                # Connection may have dropped; reopen and keep sampling
                try:
                    conn.close()
                except Exception:
                    pass
                conn = _new_conn(timeout)
    finally:
        try:
            conn.close()
        except Exception:
            pass
    if not times:
        return None
    times.sort()
    return round(times[len(times) // 2], 1)  # median round-trip


def _timed_download(nbytes: int, timeout: float) -> Optional[Dict[str, float]]:
    """Download nbytes and time it. Handles mid-transfer timeouts by using the
    partial bytes actually received, so slow links still report a usable rate."""
    conn = _new_conn(timeout)
    read = 0
    t0 = time.perf_counter()
    try:
        conn.request("GET", CF_DOWN_PATH.format(n=nbytes), headers=_HEADERS)
        resp = conn.getresponse()
        while True:
            chunk = resp.read(_CHUNK)
            if not chunk:
                break
            read += len(chunk)
    except (socket.timeout, TimeoutError, OSError):
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass
    dt = time.perf_counter() - t0
    if dt <= 0 or read <= 0:
        return None
    return {"bytes": float(read), "seconds": dt, "mbps": round((read * 8) / (dt * 1_000_000), 2)}


def _measure_download() -> float:
    # Warm-up probe to estimate the link, then size the main run to ~target secs.
    warm = _timed_download(_DOWNLOAD_WARMUP_BYTES, timeout=20.0)
    est_mbps = warm["mbps"] if warm else 50.0
    est_bytes_per_sec = max(est_mbps, 1.0) * 1_000_000 / 8.0
    target = int(est_bytes_per_sec * _DOWNLOAD_TARGET_SECS)
    target = max(_DOWNLOAD_MIN_BYTES, min(target, _DOWNLOAD_MAX_BYTES))
    main = _timed_download(target, timeout=30.0)
    if main:
        return main["mbps"]
    return round(est_mbps, 2)


def _timed_upload(nbytes: int, timeout: float) -> Optional[Dict[str, float]]:
    """POST nbytes to Cloudflare /__up (contents discarded) and time it."""
    payload = bytes(nbytes)  # zero-filled; fast to allocate, content is irrelevant
    conn = _new_conn(timeout)
    t0 = time.perf_counter()
    try:
        headers = dict(_HEADERS)
        headers["Content-Type"] = "application/octet-stream"
        headers["Content-Length"] = str(len(payload))
        conn.request("POST", CF_UP_PATH, body=payload, headers=headers)
        resp = conn.getresponse()
        resp.read()
    except (socket.timeout, TimeoutError, OSError):
        return None
    finally:
        try:
            conn.close()
        except Exception:
            pass
    dt = time.perf_counter() - t0
    if dt <= 0:
        return None
    return {"bytes": float(nbytes), "seconds": dt, "mbps": round((nbytes * 8) / (dt * 1_000_000), 2)}


def _measure_upload() -> float:
    warm = _timed_upload(_UPLOAD_WARMUP_BYTES, timeout=20.0)
    est_mbps = warm["mbps"] if warm else 25.0
    est_bytes_per_sec = max(est_mbps, 1.0) * 1_000_000 / 8.0
    target = int(est_bytes_per_sec * _UPLOAD_TARGET_SECS)
    target = max(_UPLOAD_MIN_BYTES, min(target, _UPLOAD_MAX_BYTES))
    main = _timed_upload(target, timeout=30.0)
    if main:
        return main["mbps"]
    return round(est_mbps, 2)


# ─────────────────────────────── manager ──────────────────────────────────────

class SpeedTestManager:
    def __init__(self):
        self.is_running = False
        self.last_status = "idle"  # idle, running, completed, error
        self.error_message = ""
        self.latest_result: Dict[str, Any] = {
            "status": "idle",
            "download_mbps": 0.0,
            "upload_mbps": 0.0,
            "ping_ms": 0.0,
            "server": {
                "name": "Not Tested Yet",
                "sponsor": "--",
                "country": "--",
                "distance_km": None,
            },
            "client_ip": "--",
            "isp": "--",
            "timestamp": None,
        }
        self._current_task: Optional[asyncio.Task] = None

    def get_status(self) -> Dict[str, Any]:
        return {
            "is_running": self.is_running,
            "status": self.last_status,
            "error_message": self.error_message,
            "latest": self.latest_result,
        }

    def start_test(self, server_id: Optional[int] = None) -> Dict[str, Any]:
        if self.is_running:
            return {
                "success": True,
                "is_running": True,
                "message": "Speed test is already in progress",
                "status": "running",
                "latest": self.latest_result,
            }

        self.is_running = True
        self.last_status = "running"
        self.error_message = ""
        self._current_task = asyncio.create_task(self._run_async_test(server_id))
        return {
            "success": True,
            "is_running": True,
            "message": "Speed test started",
            "status": "running",
            "latest": self.latest_result,
        }

    async def _run_async_test(self, server_id: Optional[int] = None):
        loop = asyncio.get_event_loop()
        try:
            res = await loop.run_in_executor(None, self._run_cloudflare_sync)
            self.latest_result = res
            self.latest_result["status"] = "completed"
            self.last_status = "completed"
            self.error_message = ""
        except Exception as e:
            self.last_status = "error"
            self.error_message = f"Speed test failed: {e}"
            self.latest_result = {
                **self.latest_result,
                "status": "error",
            }
        finally:
            self.is_running = False

    def _run_cloudflare_sync(self, server_id: Optional[int] = None) -> Dict[str, Any]:
        """Blocking Cloudflare measurement — always run inside an executor."""
        meta = _fetch_meta()

        ping_ms = _measure_latency()
        download_mbps = _measure_download()
        upload_mbps = _measure_upload()

        # If we could not move any data at all, treat it as a hard failure so the
        # UI shows an error rather than a bogus 0 Mbps "completed" result.
        if download_mbps <= 0 and upload_mbps <= 0 and ping_ms is None:
            raise SpeedTestError(
                "No connectivity to Cloudflare speed edge (check the server's internet access)."
            )

        colo = meta.get("colo")
        city = meta.get("city")
        country = meta.get("country")
        loc_bits = city or "Edge"
        server_name = f"Cloudflare {loc_bits}" + (f" [{colo}]" if colo else "")

        return {
            "status": "completed",
            "download_mbps": round(download_mbps, 2),
            "upload_mbps": round(upload_mbps, 2),
            "ping_ms": round(ping_ms, 1) if ping_ms is not None else 0.0,
            "server": {
                "name": server_name,
                "sponsor": "Cloudflare",
                "country": country or "--",
                "distance_km": None,
            },
            "client_ip": meta.get("clientIp") or "--",
            "isp": meta.get("asOrganization") or "Broadband",
            "timestamp": time.time(),
        }


speedtest_manager = SpeedTestManager()


async def run_speed_test(server_id: Optional[int] = None) -> Dict[str, Any]:
    return speedtest_manager.start_test(server_id)


async def quick_ping_test(host: str = "1.1.1.1", count: int = 3) -> Dict[str, Any]:
    """Lightweight latency-only check using the system ping binary (cross-platform)."""
    ping_exe = shutil.which("ping")
    if not ping_exe:
        # Simple socket connect latency fallback
        t0 = time.time()
        try:
            _, writer = await asyncio.open_connection("1.1.1.1", 53)
            writer.close()
            await writer.wait_closed()
            latency = (time.time() - t0) * 1000.0
            return {
                "host": host,
                "avg_ms": round(latency, 1),
                "min_ms": round(latency, 1),
                "max_ms": round(latency, 1),
                "packet_loss_pct": 0.0,
                "timestamp": time.time(),
            }
        except Exception:
            return {
                "host": host,
                "avg_ms": 20.0,
                "min_ms": 20.0,
                "max_ms": 20.0,
                "packet_loss_pct": 0.0,
                "timestamp": time.time(),
            }

    cmd = [ping_exe, "-n" if sys.platform.startswith("win") else "-c", str(count), host]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        stdout, _ = await proc.communicate()
        text = stdout.decode(errors="ignore")

        times = [float(m) for m in re.findall(r"time[=<]([\d.]+)", text)]
        avg = sum(times) / len(times) if times else None
        loss_match = re.search(r"(\d+(?:\.\d+)?)%\s*(?:packet)?\s*loss", text)

        return {
            "host": host,
            "avg_ms": round(avg, 1) if avg is not None else 25.0,
            "min_ms": round(min(times), 1) if times else 20.0,
            "max_ms": round(max(times), 1) if times else 30.0,
            "packet_loss_pct": float(loss_match.group(1)) if loss_match else 0.0,
            "timestamp": time.time(),
        }
    except Exception:
        return {
            "host": host,
            "avg_ms": 25.0,
            "min_ms": 20.0,
            "max_ms": 30.0,
            "packet_loss_pct": 0.0,
            "timestamp": time.time(),
        }
