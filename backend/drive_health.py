"""
Cross-platform real drive health / S.M.A.R.T. telemetry for DiskPulse NAS.

Replaces the old hardcoded mock drive table with live data from the machine
DiskPulse is actually running on:

  • Windows : PowerShell  Get-PhysicalDisk  +  Get-StorageReliabilityCounter
              (temperature / power-on-hours / wear need Administrator; without
               it we still report model, size, media type and health status)
  • Linux   : smartctl (smartmontools) with JSON output, falling back to
              lsblk + /sys + psutil sensors when smartctl is missing or the
              process lacks root

Results are cached with a TTL and refreshed on a background thread, because the
telemetry WebSocket ticks once per second and shelling out to PowerShell /
smartctl on every tick would be far too expensive (and would block the event
loop). Callers just get the most recent snapshot instantly.
"""
import json
import platform
import shutil
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional

import psutil

try:
    import humanize
except Exception:  # pragma: no cover
    humanize = None

_SYSTEM = platform.system()
_IS_WINDOWS = _SYSTEM == "Windows"
_IS_LINUX = _SYSTEM == "Linux"

# How long a snapshot stays fresh before a background refresh is triggered.
_TTL_SECONDS = 30.0

# Windows: suppress the console window a PowerShell child might otherwise flash.
_CREATE_NO_WINDOW = 0x08000000 if _IS_WINDOWS else 0


# ────────────────────────────── small helpers ─────────────────────────────────

def _to_int(val: Any) -> Optional[int]:
    try:
        if val is None or val == "":
            return None
        return int(float(val))
    except (TypeError, ValueError):
        return None


def _to_float(val: Any) -> Optional[float]:
    try:
        if val is None or val == "":
            return None
        return float(val)
    except (TypeError, ValueError):
        return None


def _human_size(nbytes: Optional[int]) -> str:
    if not nbytes:
        return "—"
    if humanize:
        return humanize.naturalsize(nbytes, binary=True)
    # crude fallback
    val = float(nbytes)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB", "PiB"):
        if val < 1024 or unit == "PiB":
            return f"{val:.1f} {unit}"
        val /= 1024
    return f"{nbytes} B"


def _temp_status(temp: Optional[float], is_ssd: bool) -> str:
    """Temperature banding. SSD/NVMe tolerate higher temps than spinning disks."""
    if temp is None:
        return "Unknown"
    if is_ssd:
        if temp >= 75:
            return "Critical"
        if temp >= 65:
            return "Warning"
    else:
        if temp >= 60:
            return "Critical"
        if temp >= 50:
            return "Warning"
    return "Normal"


def _run(cmd: List[str], timeout: float = 15.0) -> Optional[str]:
    """Run a command and return stdout, or None on any failure."""
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=_CREATE_NO_WINDOW,
        )
        if proc.stdout:
            return proc.stdout
        return None
    except Exception:
        return None


def _base_drive(drive_id: str, name: str) -> Dict[str, Any]:
    return {
        "id": drive_id,
        "name": name,
        "model": name,
        "capacity_bytes": None,
        "capacity_human": "—",
        "media_type": "Unknown",
        "interface": "—",
        "health_percent": None,
        "temperature_c": None,
        "temp_status": "Unknown",
        "power_on_hours": None,
        "reallocated_sectors": None,
        "status": "Unknown",
        "serial": None,
        "data_source": "unknown",
    }


def _placeholder() -> Dict[str, Any]:
    d = _base_drive("none", "No drives detected")
    d["model"] = "—"
    d["note"] = (
        "No drive data available. On Windows run DiskPulse as Administrator; "
        "on Linux install smartmontools and run with sudo for full S.M.A.R.T. metrics."
    )
    d["data_source"] = "none"
    return d


# ─────────────────────────────── Windows ──────────────────────────────────────

_PS_SCRIPT = r"""
$ErrorActionPreference = 'SilentlyContinue'
$disks = Get-PhysicalDisk
$out = foreach ($d in $disks) {
  $rc = $null
  try { $rc = $d | Get-StorageReliabilityCounter -ErrorAction Stop } catch { $rc = $null }
  [PSCustomObject]@{
    DeviceId     = "$($d.DeviceId)"
    FriendlyName = "$($d.FriendlyName)"
    MediaType    = "$($d.MediaType)"
    BusType      = "$($d.BusType)"
    Size         = [int64]$d.Size
    HealthStatus = "$($d.HealthStatus)"
    SerialNumber = "$($d.SerialNumber)"
    Temperature  = $rc.Temperature
    PowerOnHours = $rc.PowerOnHours
    Wear         = $rc.Wear
    ReadErrors   = $rc.ReadErrorsTotal
    WriteErrors  = $rc.WriteErrorsTotal
  }
}
$out | ConvertTo-Json -Depth 3 -Compress
"""


def _collect_windows() -> List[Dict[str, Any]]:
    exe = shutil.which("powershell") or shutil.which("pwsh")
    if not exe:
        return []
    raw = _run(
        [exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", _PS_SCRIPT],
        timeout=25.0,
    )
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, json.JSONDecodeError):
        return []
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return []

    drives: List[Dict[str, Any]] = []
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        media_raw = (item.get("MediaType") or "").strip()
        bus = (item.get("BusType") or "").strip()
        is_nvme = bus.upper() == "NVME"
        if is_nvme:
            media_type = "NVMe"
        elif media_raw.upper() == "SSD":
            media_type = "SSD"
        elif media_raw.upper() == "HDD":
            media_type = "HDD"
        else:
            media_type = "Unknown"
        is_ssd = media_type in ("SSD", "NVMe")

        friendly = (item.get("FriendlyName") or "").strip() or f"Physical Disk {item.get('DeviceId', i)}"
        size = _to_int(item.get("Size"))
        wear = _to_float(item.get("Wear"))
        health_status = (item.get("HealthStatus") or "").strip()
        temp = _to_float(item.get("Temperature"))
        if temp is not None and temp <= 0:
            temp = None  # 0 means "not reported"
        poh = _to_int(item.get("PowerOnHours"))
        if poh is not None and poh <= 0:
            poh = None

        # Health %: prefer SSD wear indicator, else map Windows HealthStatus.
        if wear is not None:
            health_percent = max(0, min(100, int(round(100 - wear))))
        elif health_status.lower() == "healthy":
            health_percent = 100
        elif health_status.lower() == "warning":
            health_percent = 50
        elif health_status.lower() in ("unhealthy", "failed"):
            health_percent = 10
        else:
            health_percent = 100

        if health_status.lower() == "healthy":
            status = "Optimal"
        elif health_status.lower() == "warning":
            status = "Warning"
        elif health_status.lower() in ("unhealthy", "failed"):
            status = "Failing"
        else:
            status = "OK"

        d = _base_drive(f"drive_{item.get('DeviceId', i)}", friendly)
        d.update({
            "capacity_bytes": size,
            "capacity_human": _human_size(size),
            "media_type": media_type,
            "interface": bus or "—",
            "health_percent": health_percent,
            "temperature_c": round(temp, 1) if temp is not None else None,
            "temp_status": _temp_status(temp, is_ssd),
            "power_on_hours": poh,
            "reallocated_sectors": None,
            "status": status,
            "serial": (item.get("SerialNumber") or "").strip() or None,
            "data_source": "powershell",
        })
        drives.append(d)
    return drives


# ──────────────────────────────── Linux ───────────────────────────────────────

def _collect_linux() -> List[Dict[str, Any]]:
    drives: List[Dict[str, Any]] = []
    if shutil.which("smartctl"):
        drives = _collect_linux_smartctl()
    if not drives:
        drives = _collect_linux_lsblk()
    return drives


def _smartctl_scan() -> List[Dict[str, str]]:
    for args in (["smartctl", "--scan-open", "-j"], ["smartctl", "--scan", "-j"]):
        raw = _run(args, timeout=10.0)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            continue
        devs = data.get("devices") or []
        if devs:
            return [{"name": d.get("name"), "type": d.get("type")} for d in devs if d.get("name")]
    return []


def _collect_linux_smartctl() -> List[Dict[str, Any]]:
    drives: List[Dict[str, Any]] = []
    devices = _smartctl_scan()
    for i, dev in enumerate(devices[:16]):
        name = dev["name"]
        dtype = dev.get("type")
        cmd = ["smartctl", "-a", "-j"]
        if dtype:
            cmd += ["-d", dtype]
        cmd.append(name)
        raw = _run(cmd, timeout=15.0)
        if not raw:
            continue
        try:
            info = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            continue

        model = info.get("model_name") or info.get("scsi_model_name")
        # No model usually means we couldn't actually read the device (perm denied).
        if not model:
            continue

        protocol = (info.get("device", {}) or {}).get("protocol", "") or ""
        is_nvme = "nvme" in protocol.lower() or (info.get("device", {}) or {}).get("type") == "nvme"
        rotation = _to_int(info.get("rotation_rate"))
        if is_nvme:
            media_type = "NVMe"
        elif rotation == 0:
            media_type = "SSD"
        elif rotation:
            media_type = "HDD"
        else:
            media_type = "Unknown"
        is_ssd = media_type in ("SSD", "NVMe")

        capacity = _to_int((info.get("user_capacity", {}) or {}).get("bytes")) or _to_int(info.get("nvme_total_capacity"))

        temp = _to_float((info.get("temperature", {}) or {}).get("current"))
        poh = _to_int((info.get("power_on_time", {}) or {}).get("hours"))
        smart_status = info.get("smart_status", {}) or {}
        passed = smart_status.get("passed")

        reallocated = None
        health_percent = None

        nvme_log = info.get("nvme_smart_health_information_log")
        if nvme_log:
            if temp is None:
                temp = _to_float(nvme_log.get("temperature"))
            if poh is None:
                poh = _to_int(nvme_log.get("power_on_hours"))
            used = _to_float(nvme_log.get("percentage_used"))
            if used is not None:
                health_percent = max(0, min(100, int(round(100 - used))))

        ata_attrs = ((info.get("ata_smart_attributes", {}) or {}).get("table")) or []
        for attr in ata_attrs:
            aid = attr.get("id")
            aname = (attr.get("name") or "").lower()
            if aid == 5 or "reallocated_sector" in aname:
                reallocated = _to_int((attr.get("raw", {}) or {}).get("value"))
            # SSD lifetime / wear indicators — normalized value ≈ % life remaining
            if health_percent is None and (
                aid in (177, 202, 231, 233) or "wear_leveling" in aname or "life" in aname
            ):
                nv = _to_int(attr.get("value"))
                if nv is not None and 0 <= nv <= 100:
                    health_percent = nv

        if health_percent is None:
            health_percent = 100 if passed else (20 if passed is False else 100)

        if passed is True:
            status = "Warning" if (reallocated or 0) > 0 else "Optimal"
        elif passed is False:
            status = "Failing"
        else:
            status = "OK"

        d = _base_drive(f"drive_{i}_{name.replace('/', '_')}", model)
        d.update({
            "capacity_bytes": capacity,
            "capacity_human": _human_size(capacity),
            "media_type": media_type,
            "interface": (protocol or "—"),
            "health_percent": health_percent,
            "temperature_c": round(temp, 1) if temp is not None else None,
            "temp_status": _temp_status(temp, is_ssd),
            "power_on_hours": poh,
            "reallocated_sectors": reallocated,
            "status": status,
            "serial": info.get("serial_number"),
            "device": name,
            "data_source": "smartctl",
        })
        drives.append(d)
    return drives


def _linux_sensor_temps() -> Dict[str, List[float]]:
    """Group drive-related temperatures from psutil by rough category."""
    out: Dict[str, List[float]] = {"nvme": [], "sata": []}
    if not hasattr(psutil, "sensors_temperatures"):
        return out
    try:
        temps = psutil.sensors_temperatures()
    except Exception:
        return out
    for chip, entries in (temps or {}).items():
        cl = chip.lower()
        for e in entries:
            val = getattr(e, "current", None)
            if val is None or val <= 0:
                continue
            if "nvme" in cl:
                out["nvme"].append(float(val))
            elif "drivetemp" in cl or "sata" in cl or "ata" in cl:
                out["sata"].append(float(val))
    return out


def _collect_linux_lsblk() -> List[Dict[str, Any]]:
    raw = _run(
        ["lsblk", "-dbJ", "-o", "NAME,MODEL,SERIAL,SIZE,ROTA,TYPE,TRAN"],
        timeout=8.0,
    )
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, json.JSONDecodeError):
        return []

    sensor_temps = _linux_sensor_temps()
    nvme_i = 0
    sata_i = 0

    drives: List[Dict[str, Any]] = []
    for i, bd in enumerate(data.get("blockdevices", []) or []):
        if bd.get("type") != "disk":
            continue
        name = bd.get("name", "")
        if name.startswith(("loop", "ram", "sr", "zram", "dm-")):
            continue
        size = _to_int(bd.get("size"))
        if size is not None and size < 256 * 1024 * 1024:
            continue  # skip tiny pseudo/config disks (cloud config volumes, etc.)
        tran = (bd.get("tran") or "").lower()
        rota = bd.get("rota")
        if tran == "nvme":
            media_type = "NVMe"
        elif rota in (True, 1, "1"):
            media_type = "HDD"
        elif rota in (False, 0, "0"):
            media_type = "SSD"
        else:
            media_type = "Unknown"
        is_ssd = media_type in ("SSD", "NVMe")

        # Best-effort temperature from psutil sensors, assigned by category order.
        temp = None
        if media_type == "NVMe" and nvme_i < len(sensor_temps["nvme"]):
            temp = sensor_temps["nvme"][nvme_i]
            nvme_i += 1
        elif sata_i < len(sensor_temps["sata"]):
            temp = sensor_temps["sata"][sata_i]
            sata_i += 1

        model = (bd.get("model") or "").strip() or f"/dev/{name}"

        d = _base_drive(f"drive_{i}_{name}", model)
        d.update({
            "capacity_bytes": size,
            "capacity_human": _human_size(size),
            "media_type": media_type,
            "interface": (tran.upper() if tran else "—"),
            "health_percent": None,
            "temperature_c": round(temp, 1) if temp is not None else None,
            "temp_status": _temp_status(temp, is_ssd),
            "power_on_hours": None,
            "reallocated_sectors": None,
            "status": "OK",
            "serial": (bd.get("serial") or "").strip() or None,
            "device": f"/dev/{name}",
            "data_source": "lsblk",
            "note": "Install smartmontools + run with sudo for temperature, health and power-on hours.",
        })
        drives.append(d)
    return drives


# ─────────────────────────── dispatch + caching ───────────────────────────────

def _collect_all() -> List[Dict[str, Any]]:
    try:
        if _IS_WINDOWS:
            drives = _collect_windows()
        elif _IS_LINUX:
            drives = _collect_linux()
        else:
            drives = []
    except Exception:
        drives = []
    if not drives:
        drives = [_placeholder()]
    return drives


class DriveHealthMonitor:
    """Non-blocking, TTL-cached, background-refreshed drive health provider."""

    def __init__(self):
        self._cache: List[Dict[str, Any]] = []
        self._last: float = 0.0
        self._lock = threading.Lock()
        self._refreshing = False

    def get(self) -> List[Dict[str, Any]]:
        now = time.time()
        start_refresh = False
        with self._lock:
            never_run = self._last == 0.0
            stale = (now - self._last) > _TTL_SECONDS
            if (never_run or stale) and not self._refreshing:
                self._refreshing = True
                start_refresh = True
            snapshot = list(self._cache)
        if start_refresh:
            threading.Thread(target=self._refresh, name="drive-health-refresh", daemon=True).start()
        return snapshot

    def _refresh(self) -> None:
        try:
            data = _collect_all()
        except Exception:
            data = None
        with self._lock:
            if data is not None:
                self._cache = data
            self._last = time.time()
            self._refreshing = False

    def refresh_blocking(self) -> List[Dict[str, Any]]:
        """Force a synchronous refresh (used for testing / diagnostics)."""
        data = _collect_all()
        with self._lock:
            self._cache = data
            self._last = time.time()
            self._refreshing = False
        return list(data)


drive_health_monitor = DriveHealthMonitor()

# Warm the cache at startup (non-blocking) so the first telemetry frame that
# reaches the browser already carries real drive data instead of an empty grid.
try:
    drive_health_monitor.get()
except Exception:
    pass


def get_drive_health() -> List[Dict[str, Any]]:
    """Public entry point — returns the most recent drive-health snapshot."""
    return drive_health_monitor.get()
