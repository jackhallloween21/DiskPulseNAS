# 🚀 DiskPulse NAS

> Full-stack, self-hosted HDD/SSD storage monitor, remote file manager, download manager, multi-device uploader, web media player, and embedded Linux terminal shell. Built for home servers, NAS units (Synology, TrueNAS, Ubuntu Server, Debian, Windows), and desktop monitoring.

---

## 🌟 Key Features

- 📊 **Real-Time System & Drive Telemetry**: Live storage consumption, read/write IOPS, MB/s bandwidth, per-core CPU load, RAM allocation, and S.M.A.R.T. temperature health watchdog over WebSockets.
- 🗂️ **Interactive Web File Manager**: Full-featured file browser with breadcrumb navigation, dual view (Grid & List), file creation, search, rename, move, copy, deletion, and batch ZIP archive downloads.
- 💻 **Embedded Web Terminal Shell Widget**: Execute safe Linux/Unix file management commands (`ls`, `ll`, `cd`, `mkdir`, `mv`, `cp`, `rm`, `cat`, `echo`, `touch`, `du`, `stat`, `df`, `top`, `free`, `diskpulse`) directly from your browser with ANSI color output.
- ⚡ **High-Speed Multi-Engine Downloader**: Download HTTP/HTTPS URLs, YouTube/video links (via `yt-dlp`), and Magnet/Torrent links (natively powered by `libtorrent` on Windows & Linux or optional Aria2) with live speed monitoring, pause/resume, category tagging, and automatic directory organization. Pick exact **video quality** (up to 4K) or extract **audio** (MP3/M4A/Opus/FLAC/WAV) with a "Fetch formats" preview, resilient anti-bot handling (player-client rotation + browser-cookie auth), and a one-click in-app **yt-dlp updater**.
- 🚀 **NAS Network & Internet Speed Test**: Real-time throughput benchmark for Download Mbps, Upload Mbps, Ping latency, and ISP / datacenter detection — one-click, powered by Cloudflare's global speed edge (no external CLI required).
- 📤 **Drag-and-Drop Multi-Device Uploader**: Upload large files seamlessly with real-time queue tracking and instant Mobile QR Pairing for phone-to-NAS uploading.
- 🎬 **In-Browser Web Media Player**: High-fidelity audio player with animated canvas waveform visualizer, plus a streaming video player with **audio-track switching** (dual-audio MKV), **embedded & external subtitles** (SRT/ASS/VTT sidecars), and **playback-speed** controls. Powered by `ffmpeg`/`ffprobe` on the server (see [install notes](#web-media-player--dual-audio--subtitles-ffmpeg) below).
- 🐍 **Python FastAPI Standalone Server**: Built-in 1-click NAS package generator for Docker Compose, TrueNAS SCALE, Synology DSM 7, and Systemd services.

---

## ⚡ Quick Start

### 1. Requirements
- **Python 3.10+** (Python 3.11 / 3.12 / 3.13 supported on Windows & Linux)
- **No Node.js / npm required!**
- **Internet access** for the network speed test — it uses Cloudflare's speed edge via the Python standard library, so no `speedtest-cli` (or any other package) is needed.

#### Real drive health (S.M.A.R.T.) requirements

DiskPulse reports your machine's **actual** drives. Model, capacity, media type and overall health status work out of the box. Temperature, power-on hours and wear-based health require **elevated access**:

**Linux** — install `smartmontools`, then run with `sudo`:

```bash
sudo apt install smartmontools      # Debian / Ubuntu
# sudo dnf install smartmontools    # Fedora / RHEL / CentOS
# sudo pacman -S smartmontools      # Arch

sudo python run.py
```

**Windows** — install `smartmontools`, then run DiskPulse **as Administrator**:

```powershell
winget install smartmontools     # or:  choco install smartmontools

# then launch from an *elevated* PowerShell / Windows Terminal
python run.py
```

> Windows' built-in storage cmdlets only report temperature & power-on hours for **NVMe** drives, so `smartmontools` is what unlocks those metrics on **SATA and USB** disks. Without it (or without Administrator), the cards still show the real model, capacity and media type — temperature and power-on hours simply display `N/A`.

> ✅ **Confirmed on Windows:** after running `winget install smartmontools` and launching DiskPulse from an **elevated** PowerShell, the drive cards populate **temperature, power-on hours and wear** for SATA and USB disks — not just NVMe. If temps still show `N/A`, you either skipped the install or aren't running as Administrator.

#### YouTube / video downloads (optional)

- **ffmpeg** is needed to merge 1080p+ video and to convert audio to MP3/FLAC/WAV. Without it, video tops out at 720p (pre-muxed) and audio can only be saved as the original M4A/Opus stream. See [Web media player — dual audio & subtitles (ffmpeg)](#web-media-player--dual-audio--subtitles-ffmpeg) below for install commands — the same `ffmpeg` install covers both features.
- **"Sign in to confirm you're not a bot"** from YouTube is almost always a stale `yt-dlp`. DiskPulse mitigates this automatically by rotating player clients and reusing a signed-in browser session's cookies, but the reliable cure is to keep `yt-dlp` current:
  - Click **Update yt-dlp** in the Add Download dialog, or run `pip install -U yt-dlp`, then restart DiskPulse.
  - For stubborn videos (age-restricted / members-only), stay logged into YouTube in Chrome, Edge or Firefox on the same machine — DiskPulse auto-detects and uses those cookies.

#### Web media player — dual audio & subtitles (ffmpeg)

The video player uses **`ffmpeg` and `ffprobe`** on the server to switch audio tracks (dual-audio MKV), extract embedded subtitles, load external `.srt`/`.ass`/`.vtt` sidecars, and remux/transcode non-browser-native formats (MKV, HEVC, AC3/DTS audio, etc.) on the fly.

Both tools ship together in the `ffmpeg` package and must be on the server's **PATH**. Without them, the player silently falls back to plain direct playback — the **Audio** and **Subtitles** dropdowns stay hidden and an in-app hint reads *"Install ffmpeg on the server to enable audio-track switching and subtitles."*

**Windows** — any one of:

```powershell
winget install ffmpeg           # Windows Package Manager
choco install ffmpeg            # Chocolatey
scoop install ffmpeg            # Scoop
```

Or install manually: download a build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) or [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases), unzip it, and add the extracted `bin` folder (the one containing `ffmpeg.exe` and `ffprobe.exe`) to your **PATH** (System Properties → Environment Variables), then open a new terminal.

**Linux** — use your distro's package manager:

```bash
sudo apt install ffmpeg         # Debian / Ubuntu / Raspberry Pi OS
sudo dnf install ffmpeg         # Fedora (RHEL/CentOS: enable RPM Fusion first)
sudo pacman -S ffmpeg           # Arch / Manjaro
sudo zypper install ffmpeg      # openSUSE
apk add ffmpeg                  # Alpine (also for slim Docker images)
```

**Verify** the server can see both binaries, then restart DiskPulse:

```bash
ffmpeg -version
ffprobe -version
```

> **Docker:** the `python:3.13-slim` image in the Compose example below does **not** include ffmpeg. Add it to the startup command — e.g. change the `command:` to `bash -c "apt-get update && apt-get install -y ffmpeg && pip install -r requirements.txt && python run.py"` — or bake `RUN apt-get update && apt-get install -y ffmpeg` into a custom image.

### 2. Install & Run
```bash
# Clone or navigate to the repository
cd DiskPulseNAS

# Install dependencies
pip install -r requirements.txt

# Start the DiskPulse server
python run.py
```

Open your browser at **[http://localhost:8000](http://localhost:8000)**.

---

## 🐳 Docker Deployment

Run DiskPulse with Docker Compose:

```yaml
version: '3.8'

services:
  diskpulse-nas:
    image: python:3.13-slim
    container_name: diskpulse-nas
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      - DISKPULSE_HOST=0.0.0.0
      - DISKPULSE_PORT=8000
      - DISKPULSE_STORAGE_ROOT=/storage
    volumes:
      - /mnt/storage:/storage
      - ./:/app
    working_dir: /app
    command: >
      bash -c "pip install -r requirements.txt && python run.py"
```

```bash
docker compose up -d
```

---

## 📐 Architecture

```
DiskPulseNAS/
├── backend/
│   ├── config.py              # Configuration & storage pool settings
│   ├── telemetry.py           # Real-time hardware & system metrics
│   ├── drive_health.py        # Cross-platform real S.M.A.R.T. drive reader
│   ├── speedtest_service.py   # Cloudflare network speed-test engine
│   ├── file_manager.py        # Safe asynchronous filesystem operations
│   ├── download_engine.py     # Multi-threaded async download worker
│   ├── terminal_emulator.py   # Sandboxed Linux NAS terminal shell
│   ├── nas_generator.py       # Synology/TrueNAS/Docker generator
│   └── main.py                # FastAPI REST API & WebSocket endpoints
├── frontend/
│   ├── index.html             # Single-Page Application interface
│   ├── css/
│   │   └── styles.css         # Glassmorphic dark design system
│   └── js/
│       ├── api.js             # REST client & WebSocket manager
│       ├── dashboard.js       # Chart.js telemetry charts & gauges
│       ├── file_manager.js    # Interactive file manager controller
│       ├── download_manager.js# Download manager & speed rate visualizer
│       ├── terminal.js        # Terminal UI & ANSI renderer
│       ├── media_player.js    # Audio/Video player & visualizer
│       ├── uploader.js        # Drag & drop and mobile QR uploader
│       ├── nas_generator.js   # 1-click NAS exporter UI
│       └── app.js             # Core application shell & navigation
├── storage_pool/              # Server storage directories & media
├── generate_demo_data.py      # Demo seed files generator
├── run.py                     # Primary launcher
├── requirements.txt           # Dependencies
└── Dockerfile                 # Container image build
```

---

## 📜 License
MIT License. Built for home servers and NAS enthusiasts.
