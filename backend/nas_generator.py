import os
import zipfile
import io
from pathlib import Path
from typing import Dict, Any

class NASGenerator:
    @staticmethod
    def generate_docker_compose(storage_path: str = "/mnt/storage", port: int = 8000) -> str:
        return f"""version: '3.8'

services:
  diskpulse-nas:
    image: python:3.13-slim
    container_name: diskpulse-nas
    restart: unless-stopped
    ports:
      - "{port}:8000"
    environment:
      - DISKPULSE_HOST=0.0.0.0
      - DISKPULSE_PORT=8000
      - DISKPULSE_STORAGE_ROOT=/storage
      - PYTHONUNBUFFERED=1
    volumes:
      - {storage_path}:/storage
      - ./app:/app
    working_dir: /app
    command: >
      bash -c "pip install --no-cache-dir fastapi uvicorn websockets aiofiles aiohttp humanize psutil &&
               python run.py"
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/telemetry')"]
      interval: 30s
      timeout: 5s
      retries: 3
"""

    @staticmethod
    def generate_systemd_service(user: str = "root", app_dir: str = "/opt/diskpulse", storage_dir: str = "/mnt/storage") -> str:
        return f"""[Unit]
Description=DiskPulse NAS Storage Hub & Monitor
After=network.target storage.mount

[Service]
Type=simple
User={user}
WorkingDirectory={app_dir}
Environment=DISKPULSE_HOST=0.0.0.0
Environment=DISKPULSE_PORT=8000
Environment=DISKPULSE_STORAGE_ROOT={storage_dir}
ExecStart=/usr/bin/python3 {app_dir}/run.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
"""

    @staticmethod
    def generate_synology_script(storage_dir: str = "/volume1/storage", port: int = 8000) -> str:
        return f"""#!/bin/sh
# DiskPulse Synology DSM 7.x Startup Script
# Place in /usr/local/etc/rc.d/diskpulse.sh or Synology Task Scheduler on Boot

export DISKPULSE_HOST=0.0.0.0
export DISKPULSE_PORT={port}
export DISKPULSE_STORAGE_ROOT="{storage_dir}"

APP_DIR="/volume1/@appdata/diskpulse"

case "$1" in
  start)
    echo "Starting DiskPulse NAS on port {port}..."
    cd $APP_DIR && nohup python3 run.py > /var/log/diskpulse.log 2>&1 &
    ;;
  stop)
    echo "Stopping DiskPulse NAS..."
    pkill -f "run.py"
    ;;
  status)
    pgrep -f "run.py" > /dev/null && echo "DiskPulse is running" || echo "DiskPulse is stopped"
    ;;
  *)
    echo "Usage: $0 {{start|stop|status}}"
    exit 1
    ;;
esac
exit 0
"""

    @staticmethod
    def generate_truenas_scale_config(pool_name: str = "tank/storage", port: int = 8000) -> str:
        return f"""# TrueNAS SCALE Custom App Specification for DiskPulse
apiVersion: v1
kind: Pod
metadata:
  name: diskpulse-nas
  labels:
    app: diskpulse
spec:
  containers:
    - name: diskpulse
      image: python:3.13-slim
      command: ["/bin/sh", "-c"]
      args:
        - |
          pip install --no-cache-dir fastapi uvicorn websockets aiofiles aiohttp humanize psutil
          python /app/run.py
      env:
        - name: DISKPULSE_HOST
          value: "0.0.0.0"
        - name: DISKPULSE_PORT
          value: "{port}"
        - name: DISKPULSE_STORAGE_ROOT
          value: "/mnt/{pool_name}"
      ports:
        - containerPort: {port}
          hostPort: {port}
      volumeMounts:
        - mountPath: /mnt/{pool_name}
          name: storage-pool
  volumes:
    - name: storage-pool
      hostPath:
        path: /mnt/{pool_name}
"""

    @staticmethod
    def generate_install_sh() -> str:
        return """#!/usr/bin/env bash
# DiskPulse 1-Click Automated NAS Installer
set -e

echo "=== Installing DiskPulse NAS Storage Hub ==="

# Check Python 3
if ! command -v python3 &> /dev/null; then
    echo "Python 3 is required. Installing python3..."
    if command -v apt &> /dev/null; then
        sudo apt update && sudo apt install -y python3 python3-pip python3-venv
    elif command -v yum &> /dev/null; then
        sudo yum install -y python3 python3-pip
    fi
fi

# Create directory
INSTALL_DIR="/opt/diskpulse"
sudo mkdir -p "$INSTALL_DIR"
sudo cp -r . "$INSTALL_DIR/"

# Setup venv
cd "$INSTALL_DIR"
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install fastapi uvicorn websockets aiofiles aiohttp humanize psutil

# Setup systemd service
cat << 'EOF' | sudo tee /etc/systemd/system/diskpulse.service
[Unit]
Description=DiskPulse NAS Storage Hub
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/diskpulse
ExecStart=/opt/diskpulse/venv/bin/python run.py
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now diskpulse

echo "=== DiskPulse NAS Successfully Installed & Running ==="
echo "Access dashboard at: http://$(hostname -I | awk '{print $1}'):8000"
"""

nas_generator = NASGenerator()
