# 🚀 DiskPulse NAS

> Full-stack, self-hosted HDD/SSD storage monitor, remote file manager, download manager, multi-device uploader, web media player, and embedded Linux terminal shell. Built for home servers, NAS units (Synology, TrueNAS, Ubuntu Server, Debian, Windows), and desktop monitoring.

---

## 🌟 Key Features

- 📊 **Real-Time System & Drive Telemetry**: Live storage consumption, read/write IOPS, MB/s bandwidth, per-core CPU load, RAM allocation, and S.M.A.R.T. temperature health watchdog over WebSockets.
- 🗂️ **Interactive Web File Manager**: Full-featured file browser with breadcrumb navigation, dual view (Grid & List), file creation, search, rename, move, copy, deletion, and batch ZIP archive downloads.
- 💻 **Embedded Web Terminal Shell Widget**: Execute safe Linux/Unix file management commands (`ls`, `ll`, `cd`, `mkdir`, `mv`, `cp`, `rm`, `cat`, `echo`, `touch`, `du`, `stat`, `df`, `top`, `free`, `diskpulse`) directly from your browser with ANSI color output.
- ⚡ **High-Speed Download Manager**: Download HTTP/HTTPS URLs and Magnet/Torrent links with live speed monitoring, pause/resume, category tagging, and automatic directory organization.
- 📤 **Drag-and-Drop Multi-Device Uploader**: Upload large files seamlessly with real-time queue tracking and instant Mobile QR Pairing for phone-to-NAS uploading.
- 🎬 **In-Browser Web Media Player**: High-fidelity audio player with animated canvas waveform visualizer and streaming video player with playback speed controls.
- 🐍 **Python FastAPI Standalone Server**: Built-in 1-click NAS package generator for Docker Compose, TrueNAS SCALE, Synology DSM 7, and Systemd services.

---

## ⚡ Quick Start

### 1. Requirements
- Python 3.10+ (Python 3.13 recommended)
- No Node.js/npm required!

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
│   ├── telemetry.py           # Real-time hardware & SMART drive metrics
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
