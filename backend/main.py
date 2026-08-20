import os
import asyncio
import json
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, Query, HTTPException, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend.config import STORAGE_ROOT, FRONTEND_DIR, TELEMETRY_INTERVAL_SECS, DEBUG
from backend.telemetry import telemetry_engine
from backend.file_manager import file_manager
from backend.download_engine import download_manager
from backend.terminal_emulator import get_or_create_session
from backend.nas_generator import nas_generator
from backend.setup_manager import (
    get_available_drives, apply_setup, is_setup_complete,
    reset_setup, load_config
)

app = FastAPI(
    title="DiskPulse NAS Hub",
    description="Full-stack self-hosted NAS storage monitor, file manager, download engine & media hub",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------- Request Models -----------------
class MkdirRequest(BaseModel):
    parent_path: str = ""
    folder_name: str

class CreateFileRequest(BaseModel):
    parent_path: str = ""
    file_name: str
    content: str = ""

class WriteFileRequest(BaseModel):
    path: str
    content: str

class RenameRequest(BaseModel):
    path: str
    new_name: str

class MoveCopyRequest(BaseModel):
    source_paths: List[str]
    target_folder: str = ""

class DeleteRequest(BaseModel):
    paths: List[str]

class BatchZipRequest(BaseModel):
    paths: List[str]

class AddDownloadRequest(BaseModel):
    url: str
    category: Optional[str] = None
    custom_folder: str = ""
    custom_filename: Optional[str] = None

class TerminalExecRequest(BaseModel):
    session_id: str = "default"
    command: str

# ----------------- Telemetry Routes -----------------
@app.get("/api/telemetry")
async def get_telemetry():
    return telemetry_engine.get_system_overview()

@app.websocket("/ws/telemetry")
async def websocket_telemetry_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = telemetry_engine.get_system_overview()
            await websocket.send_json(data)
            await asyncio.sleep(TELEMETRY_INTERVAL_SECS)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass

# ----------------- File Manager Routes -----------------
@app.get("/api/files/list")
async def list_files(path: str = ""):
    return file_manager.list_directory(path)

@app.get("/api/files/search")
async def search_files(query: str = "", path: str = ""):
    return file_manager.search_files(query, path)

@app.post("/api/files/mkdir")
async def make_directory(req: MkdirRequest):
    res = file_manager.create_directory(req.parent_path, req.folder_name)
    if not res.get("success"):
        raise HTTPException(status_code=400, detail=res.get("error"))
    return res

@app.post("/api/files/create")
async def create_file(req: CreateFileRequest):
    res = file_manager.create_file(req.parent_path, req.file_name, req.content)
    if not res.get("success"):
        raise HTTPException(status_code=400, detail=res.get("error"))
    return res

@app.get("/api/files/read")
async def read_file(path: str):
    res = file_manager.read_file_content(path)
    if not res.get("success"):
        raise HTTPException(status_code=400, detail=res.get("error"))
    return res

@app.post("/api/files/write")
async def write_file(req: WriteFileRequest):
    res = file_manager.write_file_content(req.path, req.content)
    if not res.get("success"):
        raise HTTPException(status_code=400, detail=res.get("error"))
    return res

@app.post("/api/files/rename")
async def rename_file(req: RenameRequest):
    res = file_manager.rename_item(req.path, req.new_name)
    if not res.get("success"):
        raise HTTPException(status_code=400, detail=res.get("error"))
    return res

@app.post("/api/files/move")
async def move_files(req: MoveCopyRequest):
    return file_manager.move_items(req.source_paths, req.target_folder)

@app.post("/api/files/copy")
async def copy_files(req: MoveCopyRequest):
    return file_manager.copy_items(req.source_paths, req.target_folder)

@app.post("/api/files/delete")
async def delete_files(req: DeleteRequest):
    return file_manager.delete_items(req.paths)

@app.post("/api/files/zip")
async def create_zip(req: BatchZipRequest):
    zip_path = file_manager.create_zip_archive(req.paths)
    if not zip_path or not os.path.exists(zip_path):
        raise HTTPException(status_code=400, detail="Failed to create zip archive")
    return FileResponse(
        zip_path,
        filename="diskpulse_archive.zip",
        media_type="application/zip"
    )

@app.get("/api/files/download")
async def download_file(path: str):
    target = file_manager._resolve_safe_path(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        str(target),
        filename=target.name,
        media_type="application/octet-stream"
    )

@app.get("/api/files/raw")
async def stream_raw_file(path: str):
    target = file_manager._resolve_safe_path(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    
    info = file_manager._get_file_info(target)
    return FileResponse(
        str(target),
        media_type=info["mime"],
        content_disposition_type="inline"
    )

# ----------------- Multi-Device Uploader Routes -----------------
@app.post("/api/upload")
async def upload_files(
    target_folder: str = Form(""),
    files: List[UploadFile] = File(...)
):
    dest_dir = file_manager._resolve_safe_path(target_folder)
    dest_dir.mkdir(parents=True, exist_ok=True)
    
    uploaded_files = []
    for f in files:
        safe_name = os.path.basename(f.filename or "uploaded_file")
        file_path = dest_dir / safe_name
        
        # Handle collision by appending counter
        counter = 1
        base, ext = os.path.splitext(safe_name)
        while file_path.exists():
            file_path = dest_dir / f"{base}_{counter}{ext}"
            counter += 1

        contents = await f.read()
        file_path.write_bytes(contents)
        uploaded_files.append(file_manager._get_file_info(file_path))

    return {"success": True, "uploaded": uploaded_files, "count": len(uploaded_files)}

# ----------------- Download Manager Routes -----------------
@app.get("/api/downloads")
async def get_downloads():
    return download_manager.list_all()

@app.post("/api/downloads/add")
async def add_download(req: AddDownloadRequest):
    task = download_manager.add_download(
        url=req.url,
        category=req.category,
        custom_folder=req.custom_folder,
        custom_filename=req.custom_filename
    )
    return task.to_dict()

@app.post("/api/downloads/pause/{task_id}")
async def pause_download(task_id: str):
    success = download_manager.pause_task(task_id)
    return {"success": success}

@app.post("/api/downloads/resume/{task_id}")
async def resume_download(task_id: str):
    success = download_manager.resume_task(task_id)
    return {"success": success}

@app.post("/api/downloads/cancel/{task_id}")
async def cancel_download(task_id: str):
    success = download_manager.cancel_task(task_id)
    return {"success": success}

@app.post("/api/downloads/retry/{task_id}")
async def retry_download(task_id: str):
    success = download_manager.retry_task(task_id)
    return {"success": success}

@app.delete("/api/downloads/{task_id}")
async def delete_download(task_id: str, delete_file: bool = False):
    success = download_manager.delete_task(task_id, delete_file)
    return {"success": success}

# ----------------- Embedded Terminal Routes -----------------
@app.post("/api/terminal/exec")
async def terminal_exec(req: TerminalExecRequest):
    session = get_or_create_session(req.session_id)
    result = session.execute(req.command)
    return result

@app.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket):
    await websocket.accept()
    session_id = str(id(websocket))
    session = get_or_create_session(session_id)
    
    # Send welcome banner
    banner, _ = session.execute("diskpulse")
    await websocket.send_json({
        "output": banner + f"Interactive NAS Shell initialized.\nType 'help' for commands.\n",
        "cwd": session.get_prompt_path(),
        "exit_code": 0
    })

    try:
        while True:
            msg = await websocket.receive_text()
            data = json.loads(msg)
            cmd = data.get("command", "")
            res = session.execute(cmd)
            await websocket.send_json(res)
    except WebSocketDisconnect:
        sessions.pop(session_id, None)
    except Exception:
        sessions.pop(session_id, None)

# ----------------- NAS Generator & Exporter -----------------
@app.get("/api/nas/export")
async def export_nas_config(
    platform_type: str = Query("docker", enum=["docker", "systemd", "synology", "truenas", "installer"]),
    storage_path: str = "/mnt/storage",
    port: int = 8000
):
    if platform_type == "docker":
        content = nas_generator.generate_docker_compose(storage_path, port)
        filename = "docker-compose.yml"
        mime = "text/yaml"
    elif platform_type == "systemd":
        content = nas_generator.generate_systemd_service("root", "/opt/diskpulse", storage_path)
        filename = "diskpulse.service"
        mime = "text/plain"
    elif platform_type == "synology":
        content = nas_generator.generate_synology_script(storage_path, port)
        filename = "diskpulse-synology.sh"
        mime = "application/x-sh"
    elif platform_type == "truenas":
        content = nas_generator.generate_truenas_scale_config(storage_path.lstrip("/mnt/"), port)
        filename = "truenas-diskpulse.yaml"
        mime = "text/yaml"
    else:
        content = nas_generator.generate_install_sh()
        filename = "install-nas.sh"
        mime = "application/x-sh"

    return Response(
        content=content,
        media_type=mime,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )

# ----------------- Setup API Routes -----------------

class SetupConfigRequest(BaseModel):
    storage_root: str
    seed_demo_data: bool = True
    port: int = 8000


@app.get("/api/setup/status")
async def setup_status():
    cfg = load_config()
    import platform
    return {
        "setup_complete": cfg.get("setup_complete", False),
        "storage_root": cfg.get("storage_root", ""),
        "seed_demo_data": cfg.get("seed_demo_data", True),
        "os": platform.system(),
        "os_release": platform.release(),
    }


@app.get("/api/setup/drives")
async def list_drives():
    drives = get_available_drives()
    return {"drives": drives}


@app.post("/api/setup/configure")
async def configure_setup(req: SetupConfigRequest):
    result = apply_setup(
        storage_root=req.storage_root,
        seed_demo_data=req.seed_demo_data,
        port=req.port,
    )
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Setup failed"))

    # Seed demo data if requested
    if req.seed_demo_data:
        try:
            from generate_demo_data import generate_sample_storage
            import importlib, sys
            # Re-import with the new storage root
            import backend.config as _cfg_mod
            _cfg_mod.STORAGE_ROOT = result["storage_root"]
            from pathlib import Path as _P
            _P(result["storage_root"]).mkdir(parents=True, exist_ok=True)
            generate_sample_storage.__globals__['STORAGE_ROOT'] = result["storage_root"]
            import generate_demo_data as _gdd
            import backend.config as _cfg
            _cfg.STORAGE_ROOT = result["storage_root"]
            _gdd.STORAGE_ROOT = result["storage_root"]
            _gdd.generate_sample_storage()
        except Exception as e:
            print(f"Demo data seeding warning: {e}")

    return result


@app.post("/api/setup/reset")
async def reset_configuration():
    reset_setup()
    return {"success": True, "message": "Setup reset. Reload the page to run the setup wizard again."}


# ----------------- Root Redirect for Setup -----------------
@app.get("/")
async def root_handler():
    """Serve setup.html if not yet configured, else the main app."""
    if not is_setup_complete():
        setup_file = FRONTEND_DIR / "setup.html"
        if setup_file.exists():
            return FileResponse(str(setup_file))
    main_file = FRONTEND_DIR / "index.html"
    if main_file.exists():
        return FileResponse(str(main_file))
    return JSONResponse({"error": "Frontend not found"}, status_code=404)


# ----------------- Static Frontend Assets (CSS / JS / fonts) -----------------
# Mount the frontend directory under /static so CSS/JS can be found,
# AND also mount at root so /css/... and /js/... paths work directly.
if FRONTEND_DIR.exists():
    app.mount("/css",    StaticFiles(directory=str(FRONTEND_DIR / "css")),    name="fe_css")
    app.mount("/js",     StaticFiles(directory=str(FRONTEND_DIR / "js")),     name="fe_js")
    # Catch-all for any other static assets (images, fonts, etc.)
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR)),            name="fe_assets")
