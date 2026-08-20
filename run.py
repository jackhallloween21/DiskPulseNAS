#!/usr/bin/env python3
"""
DiskPulse NAS Storage Hub & Server Launcher
"""
import os
import sys
import uvicorn
from pathlib import Path
from backend.config import HOST, PORT, STORAGE_ROOT

def print_banner():
    banner = f"""
\033[36m\033[1m
   ____  _     _    ____        _           
  |  _ \\(_)___| | _|  _ \\ _   _| |___  ___ 
  | | | | / __| |/ / |_) | | | | / __|/ _ \\
  | |_| | \\__ \\   <|  __/| |_| | \\__ \\  __/
  |____/|_|___/_|\\_\\_|    \\__,_|_|___/\\___|
\033[0m
\033[32m\033[1m=== DiskPulse NAS Storage Hub & Diagnostics Server ===\033[0m
\033[37m- Storage Root:  \033[33m{STORAGE_ROOT}\033[0m
\033[37m- Server URL:    \033[36mhttp://{HOST}:{PORT}\033[0m
\033[37m- Local Access:  \033[36mhttp://localhost:{PORT}\033[0m
\033[37m- Fast Telemetry & Terminal WebSockets Active\033[0m
======================================================
"""
    print(banner)

def main():
    # Ensure storage pool exists
    Path(STORAGE_ROOT).mkdir(parents=True, exist_ok=True)
    
    # Ensure demo data exists if empty
    if not any(Path(STORAGE_ROOT).iterdir()):
        try:
            from generate_demo_data import generate_sample_storage
            generate_sample_storage()
        except Exception as e:
            print(f"Note: Could not generate initial demo data: {e}")

    print_banner()

    # Launch Uvicorn
    uvicorn.run(
        "backend.main:app",
        host=HOST,
        port=PORT,
        log_level="info",
        reload=False
    )

if __name__ == "__main__":
    main()
