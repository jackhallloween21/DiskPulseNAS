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

# Ensure the storage directory exists
Path(STORAGE_ROOT).mkdir(parents=True, exist_ok=True)
