"""
DiskPulse Configuration
Reads from diskpulse_config.json if present, otherwise falls back to env vars / defaults.
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# ── Load persisted config (written by setup wizard) ────────────────────────────
def _load_persisted() -> dict:
    cfg_file = BASE_DIR / "diskpulse_config.json"
    if cfg_file.exists():
        try:
            import json
            return json.loads(cfg_file.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}

_persisted = _load_persisted()

# ── Active settings (env vars override persisted config) ───────────────────────
STORAGE_ROOT = os.environ.get(
    "DISKPULSE_STORAGE_ROOT",
    _persisted.get("storage_root", str(BASE_DIR / "storage_pool"))
)

HOST = os.environ.get("DISKPULSE_HOST", _persisted.get("app_host", "0.0.0.0"))
PORT = int(os.environ.get("DISKPULSE_PORT", str(_persisted.get("app_port", 8000))))
DEBUG = os.environ.get("DISKPULSE_DEBUG", "False").lower() in ("true", "1", "yes")

FRONTEND_DIR = BASE_DIR / "frontend"

# ── Telemetry ──────────────────────────────────────────────────────────────────
TELEMETRY_INTERVAL_SECS = 1.0

# ── Download category → file extension map ────────────────────────────────────
DOWNLOAD_CATEGORIES = {
    "media":     ["mp4", "mkv", "avi", "mov", "webm", "mp3", "flac", "wav", "aac", "ogg"],
    "iso":       ["iso", "img", "vmdk", "qcow2", "vdi"],
    "documents": ["pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "json"],
    "software":  ["exe", "msi", "dmg", "pkg", "deb", "rpm", "AppImage", "zip", "tar.gz", "tar.xz", "7z"],
    "backups":   ["bak", "tar", "gz", "dump", "sql", "bundle"],
}

# ── Type-based sort folders (uploads + downloads) ─────────────────────────────
# When "sort into type folders" is enabled, an incoming file is dropped into the
# matching subfolder below (nested inside the chosen destination). This is the
# single source of truth shared by the uploader and the download engine so both
# organise files identically. Order matters: the FIRST bucket that lists an
# extension wins, and anything unmatched lands in "Other".
FILE_TYPE_FOLDERS = {
    "Images":      [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg",
                    ".tif", ".tiff", ".heic", ".heif", ".avif", ".ico", ".raw"],
    "Video":       [".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv", ".wmv",
                    ".m4v", ".mpg", ".mpeg", ".ts", ".m2ts", ".3gp", ".ogv"],
    "Audio":       [".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".wma",
                    ".opus", ".aiff", ".alac", ".mid", ".midi"],
    "Documents":   [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
                    ".txt", ".md", ".csv", ".rtf", ".odt", ".ods", ".odp",
                    ".epub", ".mobi", ".json", ".xml"],
    "Archives":    [".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".bz2",
                    ".xz", ".zst", ".lz", ".lzma", ".cab", ".arj"],
    "Disk Images": [".iso", ".img", ".vmdk", ".qcow2", ".vdi", ".vhd", ".vhdx",
                    ".bin", ".cue", ".nrg", ".toast"],
    "Programs":    [".exe", ".msi", ".msix", ".apk", ".deb", ".rpm", ".appimage",
                    ".pkg", ".dmg", ".bat", ".sh", ".jar", ".flatpak", ".snap"],
}

# Folder used when no extension bucket matches.
FILE_TYPE_OTHER = "Other"


def folder_for_extension(ext: str) -> str:
    """Return the type-folder name (Images, Video, …) for a file extension.

    Accepts the extension with or without a leading dot; matching is
    case-insensitive. Unknown or blank extensions map to ``Other``.
    """
    if not ext:
        return FILE_TYPE_OTHER
    ext = ext.lower()
    if not ext.startswith("."):
        ext = "." + ext
    for folder, exts in FILE_TYPE_FOLDERS.items():
        if ext in exts:
            return folder
    return FILE_TYPE_OTHER


# Ensure the storage directory exists
Path(STORAGE_ROOT).mkdir(parents=True, exist_ok=True)
