import os
import math
import struct
import wave
from pathlib import Path

# Dynamically read storage root from config if available
def _get_storage_root():
    try:
        import json
        cfg_file = Path(__file__).parent / "diskpulse_config.json"
        if cfg_file.exists():
            cfg = json.loads(cfg_file.read_text())
            if cfg.get("storage_root"):
                return cfg["storage_root"]
    except Exception:
        pass
    return str(Path(__file__).parent / "storage_pool")

STORAGE_ROOT = _get_storage_root()

def create_sample_wav(filepath: Path, duration_secs: float = 8.0, freq: float = 440.0, sample_rate: int = 44100):
    """Generates a clean playable stereo sine-wave audio file."""
    filepath.parent.mkdir(parents=True, exist_ok=True)
    num_samples = int(duration_secs * sample_rate)
    
    with wave.open(str(filepath), 'w') as wav_file:
        wav_file.setnchannels(2)  # Stereo
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(sample_rate)
        
        frames = bytearray()
        for i in range(num_samples):
            t = float(i) / sample_rate
            # Ambient chime chord (root + fifth + octave with envelope)
            envelope = math.sin(math.pi * (i / num_samples))
            val_l = int(16000 * envelope * (math.sin(2 * math.pi * freq * t) * 0.6 + math.sin(2 * math.pi * freq * 1.5 * t) * 0.4))
            val_r = int(16000 * envelope * (math.sin(2 * math.pi * (freq * 1.005) * t) * 0.6 + math.sin(2 * math.pi * freq * 2.0 * t) * 0.4))
            
            val_l = max(-32767, min(32767, val_l))
            val_r = max(-32767, min(32767, val_r))
            frames.extend(struct.pack('<hh', val_l, val_r))
            
        wav_file.writeframes(frames)

def generate_sample_storage():
    root = Path(STORAGE_ROOT)
    root.mkdir(parents=True, exist_ok=True)

    print(f"Generating realistic sample data in: {root}")

    # 1. Media - Music
    music_dir = root / "Music" / "Synthwave & Ambient"
    music_dir.mkdir(parents=True, exist_ok=True)
    create_sample_wav(music_dir / "01 - Cyber_Horizon.wav", duration_secs=10.0, freq=330.0)
    create_sample_wav(music_dir / "02 - Neon_Midnight.wav", duration_secs=12.0, freq=440.0)
    create_sample_wav(music_dir / "03 - Solar_Pulse_Echoes.wav", duration_secs=8.0, freq=523.25)
    
    # 2. Media - Videos & Teaser
    video_dir = root / "Movies" / "SciFi 4K"
    video_dir.mkdir(parents=True, exist_ok=True)
    (video_dir / "Interstellar_NAS_Archive.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"\0" * (1024 * 1024 * 4))  # 4MB sample
    (video_dir / "Cosmic_Journey_1080p.mp4").write_text("Mock MP4 Stream Container Data\nSample Movie Asset\n", encoding="utf-8")

    # 3. Documents
    docs_dir = root / "Documents" / "Server Documentation"
    docs_dir.mkdir(parents=True, exist_ok=True)
    (docs_dir / "NAS_Architecture_Manual.md").write_text("""# DiskPulse NAS Architecture & Operations Manual

## Overview
DiskPulse provides unified high-speed telemetry, file management, and media streaming for home servers, Synology NAS, TrueNAS, and Linux workstations.

### Storage Pools
- **Pool A (ZFS Mirror)**: 2x 4TB Enterprise NAS HDDs (RAID-1)
- **Fast NVMe Tier**: 1TB Samsung 990 Pro (L2ARC Cache & Transcode buffer)

### Active Services
- Real-time S.M.A.R.T. drive telemetry & temperature watchdog
- Low-latency asynchronous download manager with category auto-sorting
- Sandboxed web terminal with Linux file management utilities
- High-fidelity in-browser audio/video player
""", encoding="utf-8")

    (docs_dir / "Storage_Capacity_Report.csv").write_text("""Drive,Model,Capacity_TB,Health_Score,Temperature_C,Status
Drive_0,NVMe System SSD,1.0,99%,38.0,Optimal
Drive_1,WD Red Plus NAS HDD,4.0,100%,34.5,Optimal
Drive_2,Seagate IronWolf NAS HDD,4.0,98%,36.2,Optimal
Drive_3,Samsung 870 EVO SATA SSD,1.0,97%,32.0,Optimal
""", encoding="utf-8")

    # 4. ISOs & Operating Systems
    iso_dir = root / "ISOs"
    iso_dir.mkdir(parents=True, exist_ok=True)
    (iso_dir / "ubuntu-24.04-live-server-amd64.iso").write_bytes(b"CD001\x01\x00" + b"\0" * (1024 * 1024 * 8))
    (iso_dir / "truenas-scale-24.04.iso").write_bytes(b"CD001\x01\x00" + b"\0" * (1024 * 1024 * 5))
    (iso_dir / "debian-12.5.0-netinst.iso").write_bytes(b"CD001\x01\x00" + b"\0" * (1024 * 1024 * 2))

    # 5. Software & Scripts
    soft_dir = root / "Software" / "NAS Tools"
    soft_dir.mkdir(parents=True, exist_ok=True)
    (soft_dir / "docker-compose-media-stack.yml").write_text("""version: '3.8'
services:
  jellyfin:
    image: jellyfin/jellyfin
    container_name: jellyfin
    network_mode: host
    volumes:
      - /storage/Movies:/data/movies
      - /storage/Music:/data/music
    restart: unless-stopped
""", encoding="utf-8")
    (soft_dir / "backup-sync.sh").write_text("""#!/bin/bash
echo "Initiating daily snapshot to Pool B..."
rsync -avz --delete /storage/Documents/ /storage/Backups/daily_docs/
echo "Snapshot completed successfully."
""", encoding="utf-8")

    # 6. Backups
    backup_dir = root / "Backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    (backup_dir / "nas_config_backup_2026.tar.gz").write_bytes(b"\x1f\x8b\x08\x00" + b"\0" * (1024 * 256))
    (backup_dir / "postgres_db_snapshot.sql").write_text("""-- DiskPulse PostgreSQL Database Dump
CREATE TABLE telemetry_metrics (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    cpu_percent FLOAT,
    ram_used_bytes BIGINT,
    disk_read_iops FLOAT,
    disk_write_iops FLOAT
);
""", encoding="utf-8")

    # 7. Images / Wallpapers
    img_dir = root / "Wallpapers & Visuals"
    img_dir.mkdir(parents=True, exist_ok=True)
    svg_content = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" width="800" height="500">
  <defs>
    <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="50%" stop-color="#0284c7" />
      <stop offset="100%" stop-color="#10b981" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g1)" />
  <circle cx="400" cy="250" r="120" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="4" />
  <circle cx="400" cy="250" r="80" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="8" stroke-dasharray="10 15" />
  <text x="400" y="260" fill="#ffffff" font-size="28" font-family="sans-serif" font-weight="bold" text-anchor="middle">DISKPULSE NAS</text>
  <text x="400" y="295" fill="#38bdf8" font-size="14" font-family="sans-serif" text-anchor="middle">Ultra-Fast Storage Monitor</text>
</svg>"""
    (img_dir / "diskpulse_cyber_wallpaper.svg").write_text(svg_content, encoding="utf-8")

    print("Demo data generation complete!")

if __name__ == "__main__":
    generate_sample_storage()
