import asyncio
import os
import re
import shutil
import signal
import sys
import time
import uuid
import aiohttp
import aiofiles
from pathlib import Path
from typing import Dict, List, Optional, Any
import humanize
import urllib.parse

from backend.config import STORAGE_ROOT, DOWNLOAD_CATEGORIES
from backend.ytdlp_service import (
    AUDIO_FORMATS,
    extract_with_fallback,
    friendly_error,
    get_ytdlp,
    has_ffmpeg,
    resolve_output_path,
)

try:
    # Optional — set these in backend/config.py to point at your aria2c daemon.
    from backend.config import ARIA2_HOST, ARIA2_PORT, ARIA2_SECRET
except ImportError:
    ARIA2_HOST = "http://127.0.0.1"
    ARIA2_PORT = 6800
    ARIA2_SECRET = ""

from .aria2_client import Aria2Client, Aria2RpcError

try:
    import libtorrent as lt
except ImportError:
    lt = None

YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com",
    "music.youtube.com", "youtu.be", "vimeo.com", "dailymotion.com",
    "tiktok.com", "reddit.com", "twitch.tv", "soundcloud.com",
}

VALID_BACKENDS = {"auto", "libtorrent", "aria2", "ytdlp", "aiohttp", "wget", "curl"}


def classify_url(url: str) -> str:
    """Rough classification used to pick a default backend."""
    clean_url = url.strip()
    if clean_url.startswith("magnet:") or clean_url.lower().endswith(".torrent"):
        return "torrent"
    try:
        host = urllib.parse.urlparse(clean_url).netloc.lower()
        if any(host == h or host.endswith("." + h) for h in YOUTUBE_HOSTS):
            return "youtube"
    except Exception:
        pass
    return "http"


def parse_content_disposition_filename(cd_header: str) -> Optional[str]:
    """Extracts filename from Content-Disposition header, handling RFC 5987."""
    if not cd_header:
        return None
    # Check for filename*=UTF-8''encoded_name
    match_star = re.search(r"filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)", cd_header, re.IGNORECASE)
    if match_star:
        try:
            return urllib.parse.unquote(match_star.group(1).strip('"\''))
        except Exception:
            pass

    match = re.search(r'filename\s*=\s*"?([^";\n]+)"?', cd_header, re.IGNORECASE)
    if match:
        return match.group(1).strip('"\'')
    return None


class DownloadTask:
    def __init__(
        self,
        task_id: str,
        url: str,
        category: str = "downloads",
        custom_folder: str = "",
        name: Optional[str] = None,
        backend: str = "auto",
        mode: str = "video",
        max_height: str = "best",
        audio_format: str = "mp3",
        audio_bitrate: str = "192",
        format_id: str = "",
        progressive: bool = False,
    ):
        self.task_id = task_id
        self.url = url
        self.category = category
        self.custom_folder = custom_folder
        self.status = "queued"  # queued, downloading, paused, completed, error, cancelled
        self.error_message = ""

        self.backend_requested = backend if backend in VALID_BACKENDS else "auto"
        self.backend = self.backend_requested
        self.url_kind = classify_url(url)

        # Media options (yt-dlp only)
        self.mode = "audio" if mode == "audio" else "video"
        self.max_height = str(max_height or "best")
        self.audio_format = audio_format if audio_format in AUDIO_FORMATS else "mp3"
        self.audio_bitrate = str(audio_bitrate or "192")
        #: Exact stream id chosen from the probed format list (video mode). When
        #: set, the download requests this precise stream and only falls back to
        #: the closest height if it has since vanished.
        self.format_id = str(format_id or "")
        self.progressive = bool(progressive)
        #: Which bot-check strategy actually worked, surfaced in the UI.
        self.strategy = ""
        #: Actual delivered video height, filled in after the download completes,
        #: so the card can show e.g. "1080p → 720p" when the exact pick wasn't
        #: available and we fell back to the closest stream.
        self.actual_height: Optional[int] = None

        # Extracted filename
        self.filename = name or self._determine_filename(url)

        # Target path
        self.target_dir = self._resolve_target_dir()
        self.target_filepath = self.target_dir / self.filename

        # Progress stats
        self.total_bytes = 0
        self.downloaded_bytes = 0
        self.progress_percent = 0.0
        self.speed_bytes_sec = 0.0
        self.eta_seconds = 0
        self.created_at = time.time()
        self.started_at: Optional[float] = None
        self.completed_at: Optional[float] = None
        self.is_magnet = self.url_kind == "torrent"
        self.peers = 0
        self.seeds = 0

        # Backend-specific handles
        self.aria2_gid: Optional[str] = None
        self._lt_handle: Any = None
        self._subprocess: Optional[asyncio.subprocess.Process] = None

        # Worker control
        self._pause_event = asyncio.Event()
        self._pause_event.set()
        self._cancel_flag = False
        self._delete_file_on_cancel = False
        self._async_task: Optional[asyncio.Task] = None

    def _determine_filename(self, url: str) -> str:
        if url.startswith("magnet:"):
            try:
                parsed = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
                if "dn" in parsed and parsed["dn"]:
                    return parsed["dn"][0]
            except Exception:
                pass
            return f"torrent_{int(time.time())}.dat"

        try:
            parsed = urllib.parse.urlparse(url)
            path = urllib.parse.unquote(parsed.path)
            base = os.path.basename(path)
            if base and "." in base and not base.startswith("watch"):
                return base
        except Exception:
            pass

        if classify_url(url) == "youtube":
            return f"video_{int(time.time())}.mp4"
        return f"download_{int(time.time())}.bin"

    def _resolve_target_dir(self) -> Path:
        root = Path(STORAGE_ROOT)
        if self.custom_folder:
            dest = (root / self.custom_folder.strip("/\\")).resolve()
        else:
            cat_dir = self.category.lower() if self.category else "downloads"
            dest = root / "downloads" / cat_dir
        dest.mkdir(parents=True, exist_ok=True)
        return dest

    def get_relative_file_path(self) -> str:
        try:
            rel = self.target_filepath.relative_to(Path(STORAGE_ROOT))
            return str(rel).replace("\\", "/")
        except Exception:
            return f"downloads/{self.category}/{self.filename}"

    def to_dict(self) -> Dict[str, Any]:
        ext = self.target_filepath.suffix.lstrip(".").lower()
        is_media = ext in ["mp4", "mkv", "avi", "mov", "webm", "mp3", "flac", "wav", "aac", "ogg"]
        is_video = ext in ["mp4", "mkv", "avi", "mov", "webm"]
        is_audio = ext in ["mp3", "flac", "wav", "aac", "ogg"]

        file_exists = self.target_filepath.exists()
        file_size = self.target_filepath.stat().st_size if file_exists else self.downloaded_bytes

        return {
            "task_id": self.task_id,
            "url": self.url,
            "filename": self.filename,
            "category": self.category,
            "status": self.status,
            "error_message": self.error_message,
            "backend": self.backend,
            "total_bytes": self.total_bytes,
            "downloaded_bytes": self.downloaded_bytes,
            "progress_percent": round(self.progress_percent, 1),
            "speed_bytes_sec": self.speed_bytes_sec,
            "speed_human_sec": f"{humanize.naturalsize(self.speed_bytes_sec)}/s",
            "downloaded_human": humanize.naturalsize(self.downloaded_bytes, binary=True),
            "total_human": humanize.naturalsize(self.total_bytes, binary=True) if self.total_bytes > 0 else "Unknown",
            "eta_seconds": int(self.eta_seconds),
            "eta_human": humanize.naturaldelta(int(self.eta_seconds)) if self.eta_seconds > 0 else "--",
            "target_dir": str(self.target_dir.relative_to(Path(STORAGE_ROOT))).replace("\\", "/"),
            "file_rel_path": self.get_relative_file_path(),
            "file_exists": file_exists,
            "is_media": is_media,
            "is_video": is_video,
            "is_audio": is_audio,
            "created_at": self.created_at,
            "is_magnet": self.is_magnet,
            "peers": self.peers,
            "seeds": self.seeds,
            "mode": self.mode,
            "max_height": self.max_height,
            "audio_format": self.audio_format,
            "audio_bitrate": self.audio_bitrate,
            "quality_label": self._quality_label(),
            "strategy": self.strategy,
        }

    def _quality_label(self) -> str:
        """Short human tag for the quality, shown on the task row.

        Once the download finishes we know the *actual* delivered height, so we
        show that — and annotate "requested → actual" when we had to fall back
        to the closest available stream.
        """
        if self.url_kind != "youtube":
            return ""
        if self.mode == "audio":
            if self.audio_format in ("flac", "wav"):
                return f"{self.audio_format.upper()} lossless"
            return f"{self.audio_format.upper()} {self.audio_bitrate}kbps"

        requested = "Best" if self.max_height == "best" else f"{self.max_height}p"
        if self.actual_height:
            got = f"{self.actual_height}p"
            if self.max_height != "best" and str(self.actual_height) != str(self.max_height):
                return f"{requested} → {got}"   # fell back to the closest available
            return got
        return "Best quality" if self.max_height == "best" else requested


class DownloadManager:
    def __init__(self):
        self.tasks: Dict[str, DownloadTask] = {}
        self._semaphore = asyncio.Semaphore(4)  # 4 concurrent downloads max
        self._aria2: Optional[Aria2Client] = None
        self._lt_session: Any = None

    def _get_aria2_client(self) -> Aria2Client:
        if self._aria2 is None:
            self._aria2 = Aria2Client(host=ARIA2_HOST, port=ARIA2_PORT, secret=ARIA2_SECRET)
        return self._aria2

    def _get_libtorrent_session(self):
        if lt is None:
            return None
        if self._lt_session is None:
            try:
                # Initialize native libtorrent session
                self._lt_session = lt.session({
                    "listen_interfaces": "0.0.0.0:6881",
                    "enable_dht": True,
                    "enable_lsd": True,
                    "enable_upnp": True,
                    "enable_natpmp": True,
                })
                # Add default DHT bootstrap routers
                self._lt_session.add_dht_router("router.bittorrent.com", 6881)
                self._lt_session.add_dht_router("router.utorrent.com", 6881)
                self._lt_session.add_dht_router("dht.transmissionbt.com", 6881)
                self._lt_session.start_dht()
            except Exception as e:
                print(f"Libtorrent init warning: {e}")
        return self._lt_session

    async def _safe_aria2_call(self, coro_fn, *args) -> None:
        try:
            await coro_fn(*args)
        except Aria2RpcError:
            pass

    # ---------------------------------------------------------------- add

    def add_download(
        self,
        url: str,
        category: Optional[str] = None,
        custom_folder: str = "",
        custom_filename: Optional[str] = None,
        backend: str = "auto",
        mode: str = "video",
        max_height: str = "best",
        audio_format: str = "mp3",
        audio_bitrate: str = "192",
        format_id: str = "",
        progressive: bool = False,
    ) -> DownloadTask:
        url = url.strip()
        if not category:
            category = "downloads"
            ext = url.split("?")[0].split("#")[0].split(".")[-1].lower()
            for cat_name, ext_list in DOWNLOAD_CATEGORIES.items():
                if ext in ext_list:
                    category = cat_name
                    break

        # If it's a YouTube / video link and no custom category was given, use media
        if classify_url(url) == "youtube" and category == "downloads":
            category = "media"

        task_id = str(uuid.uuid4())[:8]
        task = DownloadTask(
            task_id=task_id,
            url=url,
            category=category,
            custom_folder=custom_folder,
            name=custom_filename,
            backend=backend,
            mode=mode,
            max_height=max_height,
            audio_format=audio_format,
            audio_bitrate=audio_bitrate,
            format_id=format_id,
            progressive=progressive,
        )
        self.tasks[task_id] = task

        task._async_task = asyncio.create_task(self._run_task(task))
        return task

    async def _run_task(self, task: DownloadTask):
        async with self._semaphore:
            task.started_at = time.time()
            task.status = "downloading"

            backend = task.backend_requested
            if backend == "auto":
                if task.url_kind == "youtube":
                    backend = "ytdlp"
                elif task.url_kind == "torrent":
                    # Prefer native in-process libtorrent if installed
                    if lt is not None:
                        backend = "libtorrent"
                    else:
                        backend = "aria2"
                else:
                    # For standard HTTP/HTTPS URLs, use native async aiohttp
                    backend = "aiohttp"
            task.backend = backend

            try:
                if backend == "ytdlp":
                    await self._download_ytdlp(task)
                elif backend == "libtorrent":
                    await self._download_libtorrent(task)
                elif backend == "aria2":
                    await self._download_aria2(task)
                elif backend == "wget":
                    await self._download_subprocess(task, "wget")
                elif backend == "curl":
                    await self._download_subprocess(task, "curl")
                else:
                    await self._download_http(task)
            except asyncio.CancelledError:
                task.status = "cancelled"

    # ------------------------------------------------------------ libtorrent

    async def _download_libtorrent(self, task: DownloadTask):
        if lt is None:
            # Fall back to aria2 if installed/configured
            task.backend = "aria2"
            await self._download_aria2(task)
            return

        session = self._get_libtorrent_session()
        if not session:
            task.status = "error"
            task.error_message = "Failed to initialize native BitTorrent session."
            return

        try:
            task.target_dir.mkdir(parents=True, exist_ok=True)

            if task.url.startswith("magnet:"):
                params = lt.parse_magnet_uri(task.url)
            elif task.url.lower().endswith(".torrent") and (task.url.startswith("http://") or task.url.startswith("https://")):
                # Download the .torrent file first
                async with aiohttp.ClientSession() as http_sess:
                    async with http_sess.get(task.url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                        if resp.status != 200:
                            task.status = "error"
                            task.error_message = f"Failed to fetch .torrent file: HTTP {resp.status}"
                            return
                        content = await resp.read()
                ti = lt.torrent_info(lt.bdecode(content))
                params = lt.add_torrent_params()
                params.ti = ti
            elif os.path.exists(task.url):
                ti = lt.torrent_info(task.url)
                params = lt.add_torrent_params()
                params.ti = ti
            else:
                params = lt.parse_magnet_uri(task.url)

            params.save_path = str(task.target_dir)
            handle = session.add_torrent(params)
            task._lt_handle = handle

        except Exception as e:
            task.status = "error"
            task.error_message = f"Torrent initialization error: {e}"
            return

        try:
            while True:
                if task._cancel_flag:
                    try:
                        session.remove_torrent(handle, 1 if task._delete_file_on_cancel else 0)
                    except Exception:
                        pass
                    task.status = "cancelled"
                    return

                await task._pause_event.wait()

                st = handle.status()

                task.total_bytes = int(st.total_wanted or st.total_done or 0)
                task.downloaded_bytes = int(st.total_done or 0)
                task.speed_bytes_sec = float(st.download_rate or 0)
                task.peers = int(st.num_peers or 0)
                task.seeds = int(st.num_seeds or 0)
                task.progress_percent = min(100.0, round(st.progress * 100.0, 1))

                # Update filename once metadata is fetched
                if st.name and st.name != task.filename and not task.filename.endswith(".dat"):
                    task.filename = st.name
                    task.target_filepath = task.target_dir / st.name

                if task.total_bytes > 0 and task.speed_bytes_sec > 0:
                    remaining = task.total_bytes - task.downloaded_bytes
                    if remaining > 0:
                        task.eta_seconds = remaining / task.speed_bytes_sec

                # Check completion
                if st.is_seeding or st.progress >= 1.0 or str(st.state) in ("seeding", "finished"):
                    task.status = "completed"
                    task.progress_percent = 100.0
                    task.speed_bytes_sec = 0.0
                    task.completed_at = time.time()
                    if st.name:
                        task.filename = st.name
                        task.target_filepath = task.target_dir / st.name
                    return

                await asyncio.sleep(1.0)

        except asyncio.CancelledError:
            try:
                session.remove_torrent(handle, 0)
            except Exception:
                pass
            task.status = "cancelled"

    # ------------------------------------------------------------ aria2

    async def _download_aria2(self, task: DownloadTask):
        client = self._get_aria2_client()
        options = {"dir": str(task.target_dir), "out": task.filename}

        try:
            gid = await client.add_uri([task.url], options)
        except Aria2RpcError as e:
            if task.is_magnet:
                # If libtorrent is available, fall back to libtorrent
                if lt is not None:
                    task.backend = "libtorrent"
                    await self._download_libtorrent(task)
                    return

                task.status = "error"
                task.error_message = (
                    f"Aria2 daemon is unreachable at {ARIA2_HOST}:{ARIA2_PORT}, and libtorrent is not active. "
                    f"Error: {e}"
                )
                return
            # Non-torrent URL: fall back to the built-in aiohttp downloader.
            task.backend = "aiohttp"
            await self._download_http(task)
            return

        task.aria2_gid = gid
        try:
            while True:
                if task._cancel_flag:
                    await self._safe_aria2_call(client.force_remove, gid)
                    task.status = "cancelled"
                    return

                await task._pause_event.wait()

                try:
                    status = await client.tell_status(gid)
                except Aria2RpcError as e:
                    task.status = "error"
                    task.error_message = f"Lost contact with aria2c: {e}"
                    return

                st = status.get("status")
                task.total_bytes = int(status.get("totalLength") or 0)
                task.downloaded_bytes = int(status.get("completedLength") or 0)
                task.speed_bytes_sec = float(status.get("downloadSpeed") or 0)
                task.peers = int(status.get("numPeers") or 0)
                task.seeds = int(status.get("numSeeders") or 0)

                if task.total_bytes > 0:
                    task.progress_percent = min(100.0, task.downloaded_bytes / task.total_bytes * 100.0)
                    remaining = task.total_bytes - task.downloaded_bytes
                    if task.speed_bytes_sec > 0:
                        task.eta_seconds = remaining / task.speed_bytes_sec

                if st == "complete":
                    files = status.get("files") or []
                    if files and files[0].get("path"):
                        task.target_filepath = Path(files[0]["path"])
                        task.filename = task.target_filepath.name
                    task.status = "completed"
                    task.progress_percent = 100.0
                    task.speed_bytes_sec = 0.0
                    task.completed_at = time.time()
                    return
                elif st == "error":
                    task.status = "error"
                    task.error_message = status.get("errorMessage", "aria2 reported an error")
                    return
                elif st == "removed":
                    task.status = "cancelled"
                    return
                elif st == "paused":
                    task.status = "paused"
                else:
                    task.status = "downloading"

                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            await self._safe_aria2_call(client.force_remove, gid)
            task.status = "cancelled"

    # ------------------------------------------------------------ ytdlp

    async def _download_ytdlp(self, task: DownloadTask):
        yt_dlp = get_ytdlp()
        if yt_dlp is None:
            task.status = "error"
            task.error_message = "yt-dlp is not installed. Run: pip install -U yt-dlp"
            return

        loop = asyncio.get_event_loop()
        ffmpeg = has_ffmpeg()

        # Audio extraction and 1080p+ muxing both require ffmpeg. Fail loudly
        # rather than silently handing back a 720p file the user didn't ask for.
        if task.mode == "audio" and not ffmpeg:
            if task.audio_format != "m4a":
                task.status = "error"
                task.error_message = (
                    f"Converting to {task.audio_format.upper()} needs ffmpeg, which isn't "
                    "installed. Install it (winget install ffmpeg / apt install ffmpeg), "
                    "or choose M4A to download the original audio stream without conversion."
                )
                return

        def progress_hook(d: Dict[str, Any]):
            if task._cancel_flag:
                raise yt_dlp.utils.DownloadError("Cancelled by user")
            status = d.get("status")
            if status == "downloading":
                task.downloaded_bytes = d.get("downloaded_bytes", 0) or 0
                task.total_bytes = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                task.speed_bytes_sec = d.get("speed") or 0
                if task.total_bytes:
                    task.progress_percent = min(100.0, task.downloaded_bytes / task.total_bytes * 100.0)
                eta = d.get("eta")
                if eta:
                    task.eta_seconds = eta
                task.status = "downloading"
            elif status == "finished":
                # Post-processing (mux/convert) still to come.
                task.progress_percent = 99.0
                task.speed_bytes_sec = 0.0

        def note_attempt(name: str):
            task.strategy = name

        def run() -> str:
            info, strategy = extract_with_fallback(
                task.url,
                download=True,
                outtmpl=str(task.target_dir / "%(title).180B [%(id)s].%(ext)s"),
                mode=task.mode,
                max_height=task.max_height,
                audio_format=task.audio_format,
                audio_bitrate=task.audio_bitrate,
                progress_hooks=[progress_hook],
                on_attempt=note_attempt,
                format_id=task.format_id or None,
                progressive=task.progressive,
            )
            task.strategy = strategy

            # Record what we actually got so the UI can flag a fallback.
            try:
                dl0 = (info.get("requested_downloads") or [None])[0] or {}
                task.actual_height = info.get("height") or dl0.get("height")
            except Exception:
                pass

            # Post-processing renames the file (e.g. .webm → .mp3), so trust the
            # path yt-dlp reports rather than the pre-conversion template.
            fallback = str(task.target_dir / f"{info.get('title', 'download')}.{info.get('ext', 'mp4')}")
            return resolve_output_path(info, fallback)

        try:
            filepath = await loop.run_in_executor(None, run)
            resolved = Path(filepath)
            # If the exact path is missing, look for a same-stem sibling (the
            # post-processor may have changed the container).
            if not resolved.exists():
                matches = sorted(
                    task.target_dir.glob(resolved.stem + ".*"),
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )
                if matches:
                    resolved = matches[0]

            task.target_filepath = resolved
            task.filename = resolved.name
            if resolved.exists():
                size = resolved.stat().st_size
                task.total_bytes = size
                task.downloaded_bytes = size
            task.status = "completed"
            task.progress_percent = 100.0
            task.speed_bytes_sec = 0.0
            task.completed_at = time.time()
        except Exception as e:
            if task._cancel_flag:
                task.status = "cancelled"
            else:
                task.status = "error"
                task.error_message = friendly_error(e)
                task.speed_bytes_sec = 0.0

    # ------------------------------------------------------ wget / curl

    async def _download_subprocess(self, task: DownloadTask, tool: str):
        exe = shutil.which(tool)
        if not exe:
            task.status = "error"
            task.error_message = f"'{tool}' is not installed on this NAS. Install it or choose a different backend."
            return

        task.target_dir.mkdir(parents=True, exist_ok=True)
        if tool == "wget":
            cmd = [exe, "-c", "-O", str(task.target_filepath),
                   "--user-agent=DiskPulse-NAS-Downloader/1.0", task.url]
        else:  # curl
            cmd = [exe, "-L", "-C", "-", "-o", str(task.target_filepath),
                   "-A", "DiskPulse-NAS-Downloader/1.0", task.url]

        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
        )
        task._subprocess = proc

        last_size = task.target_filepath.stat().st_size if task.target_filepath.exists() else 0
        last_time = time.time()

        try:
            while True:
                if task._cancel_flag:
                    proc.terminate()
                    task.status = "cancelled"
                    return

                await task._pause_event.wait()

                try:
                    await asyncio.wait_for(proc.wait(), timeout=0.5)
                    break  # process exited
                except asyncio.TimeoutError:
                    pass

                if task.target_filepath.exists():
                    size = task.target_filepath.stat().st_size
                    now = time.time()
                    dt = now - last_time
                    if dt >= 0.5:
                        task.speed_bytes_sec = (size - last_size) / dt
                        task.downloaded_bytes = size
                        last_size, last_time = size, now
                        if task.total_bytes > 0:
                            task.progress_percent = min(100.0, size / task.total_bytes * 100.0)

            if proc.returncode == 0:
                task.status = "completed"
                task.progress_percent = 100.0
                task.speed_bytes_sec = 0.0
                task.completed_at = time.time()
            else:
                task.status = "error"
                task.error_message = f"{tool} exited with code {proc.returncode}"
        except asyncio.CancelledError:
            proc.terminate()
            task.status = "cancelled"

    # -------------------------------------------------------- aiohttp

    async def _download_http(self, task: DownloadTask):
        """Direct async HTTP downloader (resumable, multi-chunk, no external binary required)."""
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DiskPulse-NAS-Downloader/1.0"}

        file_mode = "wb"
        resume_offset = 0
        if task.target_filepath.exists():
            resume_offset = task.target_filepath.stat().st_size
            if resume_offset > 0:
                headers["Range"] = f"bytes={resume_offset}-"
                file_mode = "ab"
                task.downloaded_bytes = resume_offset

        try:
            timeout = aiohttp.ClientTimeout(total=None, connect=15, sock_read=30)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(task.url, headers=headers, allow_redirects=True) as resp:
                    if resp.status not in (200, 206):
                        if resp.status == 416:
                            file_mode = "wb"
                            resume_offset = 0
                            task.downloaded_bytes = 0
                        else:
                            task.status = "error"
                            task.error_message = f"HTTP {resp.status} {resp.reason}"
                            return

                    # Parse Content-Disposition header
                    cd = resp.headers.get("Content-Disposition", "")
                    parsed_name = parse_content_disposition_filename(cd)
                    if parsed_name:
                        task.filename = parsed_name
                        task.target_filepath = task.target_dir / parsed_name
                    elif task.filename.startswith("download_") and resp.url:
                        # Extract from final redirected URL path
                        final_path = urllib.parse.unquote(resp.url.path)
                        final_base = os.path.basename(final_path)
                        if final_base and "." in final_base:
                            task.filename = final_base
                            task.target_filepath = task.target_dir / final_base

                    content_length = resp.headers.get("Content-Length")
                    if content_length:
                        task.total_bytes = int(content_length) + resume_offset

                    last_speed_calc_time = time.time()
                    last_downloaded = task.downloaded_bytes

                    async with aiofiles.open(task.target_filepath, file_mode) as f:
                        async for chunk in resp.content.iter_chunked(64 * 1024):
                            if task._cancel_flag:
                                task.status = "cancelled"
                                return

                            await task._pause_event.wait()

                            await f.write(chunk)
                            task.downloaded_bytes += len(chunk)

                            now = time.time()
                            elapsed = now - last_speed_calc_time
                            if elapsed >= 0.5:
                                bytes_diff = task.downloaded_bytes - last_downloaded
                                task.speed_bytes_sec = bytes_diff / elapsed
                                last_speed_calc_time = now
                                last_downloaded = task.downloaded_bytes

                                if task.total_bytes > 0:
                                    task.progress_percent = min(100.0, (task.downloaded_bytes / task.total_bytes) * 100.0)
                                    remaining = task.total_bytes - task.downloaded_bytes
                                    if task.speed_bytes_sec > 0:
                                        task.eta_seconds = remaining / task.speed_bytes_sec

                    task.status = "completed"
                    task.progress_percent = 100.0
                    task.speed_bytes_sec = 0.0
                    task.completed_at = time.time()

        except asyncio.CancelledError:
            task.status = "cancelled"
        except Exception as e:
            task.status = "error"
            task.error_message = str(e)
            task.speed_bytes_sec = 0.0

    # --------------------------------------------------------- controls

    def pause_task(self, task_id: str) -> bool:
        task = self.tasks.get(task_id)
        if not task or task.status != "downloading":
            return False

        task._pause_event.clear()
        task.status = "paused"
        task.speed_bytes_sec = 0

        if task.backend == "libtorrent" and task._lt_handle:
            try:
                task._lt_handle.pause()
            except Exception:
                pass
        elif task.backend == "aria2" and task.aria2_gid:
            asyncio.create_task(self._safe_aria2_call(self._get_aria2_client().pause, task.aria2_gid))
        elif task.backend in ("wget", "curl") and task._subprocess and not sys.platform.startswith("win"):
            try:
                task._subprocess.send_signal(signal.SIGSTOP)
            except (ProcessLookupError, OSError):
                pass

        return True

    def resume_task(self, task_id: str) -> bool:
        task = self.tasks.get(task_id)
        if not task or task.status != "paused":
            return False

        task._pause_event.set()
        task.status = "downloading"

        if task.backend == "libtorrent" and task._lt_handle:
            try:
                task._lt_handle.resume()
            except Exception:
                pass
        elif task.backend == "aria2" and task.aria2_gid:
            asyncio.create_task(self._safe_aria2_call(self._get_aria2_client().unpause, task.aria2_gid))
        elif task.backend in ("wget", "curl") and task._subprocess and not sys.platform.startswith("win"):
            try:
                task._subprocess.send_signal(signal.SIGCONT)
            except (ProcessLookupError, OSError):
                pass

        return True

    def cancel_task(self, task_id: str) -> bool:
        task = self.tasks.get(task_id)
        if task:
            task._cancel_flag = True
            task._pause_event.set()

            if task.backend == "libtorrent" and task._lt_handle:
                session = self._get_libtorrent_session()
                if session:
                    try:
                        session.remove_torrent(task._lt_handle, 0)
                    except Exception:
                        pass
            elif task.backend == "aria2" and task.aria2_gid:
                asyncio.create_task(self._safe_aria2_call(self._get_aria2_client().force_remove, task.aria2_gid))
            if task._subprocess and task._subprocess.returncode is None:
                try:
                    task._subprocess.terminate()
                except ProcessLookupError:
                    pass
            if task._async_task and not task._async_task.done():
                task._async_task.cancel()

            task.status = "cancelled"
            task.speed_bytes_sec = 0
            return True
        return False

    def retry_task(self, task_id: str) -> bool:
        old_task = self.tasks.get(task_id)
        if old_task:
            # Preserve the original filename only for non-yt-dlp jobs; yt-dlp
            # derives its own name from the (possibly re-picked) format.
            keep_name = None if old_task.url_kind == "youtube" else old_task.filename
            return bool(self.add_download(
                url=old_task.url,
                category=old_task.category,
                custom_folder=old_task.custom_folder,
                custom_filename=keep_name,
                backend=old_task.backend_requested,
                mode=old_task.mode,
                max_height=old_task.max_height,
                audio_format=old_task.audio_format,
                audio_bitrate=old_task.audio_bitrate,
                format_id=old_task.format_id,
                progressive=old_task.progressive,
            ))
        return False

    def delete_task(self, task_id: str, delete_file: bool = False) -> bool:
        task = self.tasks.pop(task_id, None)
        if task:
            task._delete_file_on_cancel = delete_file
            self.cancel_task(task_id)
            if delete_file and task.target_filepath.exists():
                try:
                    if task.target_filepath.is_dir():
                        shutil.rmtree(str(task.target_filepath))
                    else:
                        task.target_filepath.unlink()
                except Exception:
                    pass
            return True
        return False

    def list_all(self) -> List[Dict[str, Any]]:
        return [task.to_dict() for task in sorted(self.tasks.values(), key=lambda t: t.created_at, reverse=True)]

    async def aria2_available(self) -> bool:
        return await self._get_aria2_client().ping()

    def libtorrent_available(self) -> bool:
        return lt is not None


download_manager = DownloadManager()

