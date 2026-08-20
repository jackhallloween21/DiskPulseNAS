import os
import shutil
import mimetypes
import zipfile
import tempfile
import io
import time
from pathlib import Path
from typing import List, Optional, Dict, Any
import humanize

from backend.config import STORAGE_ROOT

class FileManager:
    def __init__(self, root_dir: str = STORAGE_ROOT):
        self.root_dir = Path(root_dir).resolve()
        self.root_dir.mkdir(parents=True, exist_ok=True)

    def _resolve_safe_path(self, target_rel_path: str) -> Path:
        """Resolves target relative path safely under root_dir."""
        clean_rel = target_rel_path.strip().lstrip("/\\")
        resolved = (self.root_dir / clean_rel).resolve()
        # Security: Prevent path traversal escaping root_dir
        if not str(resolved).startswith(str(self.root_dir)):
            return self.root_dir
        return resolved

    def _get_relative_path(self, full_path: Path) -> str:
        try:
            rel = full_path.relative_to(self.root_dir)
            return str(rel).replace("\\", "/")
        except ValueError:
            return ""

    def _get_file_info(self, path: Path) -> Dict[str, Any]:
        stat = path.stat()
        is_dir = path.is_dir()
        rel_path = self._get_relative_path(path)
        
        mime_type, _ = mimetypes.guess_type(str(path))
        if is_dir:
            mime_type = "inode/directory"
            try:
                children_count = len(list(path.iterdir()))
            except Exception:
                children_count = 0
            size_bytes = 0
            size_human = f"{children_count} items"
        else:
            children_count = 0
            size_bytes = stat.st_size
            size_human = humanize.naturalsize(size_bytes, binary=True)

        ext = path.suffix.lstrip(".").lower() if not is_dir else ""
        
        # Categorize file type for UI icons and actions
        category = "other"
        if is_dir:
            category = "folder"
        elif ext in ["mp4", "mkv", "webm", "avi", "mov", "flv"]:
            category = "video"
        elif ext in ["mp3", "wav", "flac", "ogg", "aac", "m4a"]:
            category = "audio"
        elif ext in ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"]:
            category = "image"
        elif ext in ["pdf"]:
            category = "pdf"
        elif ext in ["txt", "md", "py", "js", "html", "css", "json", "yml", "yaml", "sh", "bat", "ini", "conf", "sql", "xml", "csv", "log"]:
            category = "text"
        elif ext in ["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "iso"]:
            category = "archive"
        elif ext in ["exe", "msi", "deb", "rpm", "bin", "apk"]:
            category = "executable"

        return {
            "name": path.name,
            "path": rel_path if rel_path != "." else "",
            "is_dir": is_dir,
            "size": size_bytes,
            "size_human": size_human,
            "mime": mime_type or "application/octet-stream",
            "category": category,
            "extension": ext,
            "items_count": children_count,
            "modified": stat.st_mtime,
            "modified_human": humanize.naturaltime(time.time() - stat.st_mtime),
            "permissions": oct(stat.st_mode)[-3:],
        }

    def list_directory(self, rel_path: str = "") -> Dict[str, Any]:
        target = self._resolve_safe_path(rel_path)
        if not target.exists():
            return {"error": "Directory not found", "files": [], "current_path": ""}
        if not target.is_dir():
            return {"error": "Path is not a directory", "files": [], "current_path": ""}

        items = []
        try:
            for child in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                try:
                    items.append(self._get_file_info(child))
                except (PermissionError, OSError):
                    continue
        except Exception as e:
            return {"error": str(e), "files": [], "current_path": self._get_relative_path(target)}

        # Build breadcrumbs
        current_rel = self._get_relative_path(target)
        breadcrumbs = [{"name": "root", "path": ""}]
        if current_rel and current_rel != ".":
            parts = current_rel.split("/")
            accum = ""
            for p in parts:
                if not p:
                    continue
                accum = f"{accum}/{p}" if accum else p
                breadcrumbs.append({"name": p, "path": accum})

        return {
            "success": True,
            "current_path": current_rel if current_rel != "." else "",
            "breadcrumbs": breadcrumbs,
            "files": items,
            "total_items": len(items),
        }

    def search_files(self, query: str, rel_path: str = "") -> List[Dict[str, Any]]:
        target = self._resolve_safe_path(rel_path)
        if not target.exists():
            return []

        query = query.lower()
        results = []
        try:
            for item in target.rglob("*"):
                if query in item.name.lower():
                    results.append(self._get_file_info(item))
                    if len(results) >= 100:  # Cap search results
                        break
        except Exception:
            pass
        return results

    def create_directory(self, rel_parent: str, name: str) -> Dict[str, Any]:
        clean_name = name.strip().replace("/", "_").replace("\\", "_")
        if not clean_name or clean_name in (".", ".."):
            return {"success": False, "error": "Invalid directory name"}
        
        target = self._resolve_safe_path(rel_parent) / clean_name
        if target.exists():
            return {"success": False, "error": "Directory already exists"}
        
        try:
            target.mkdir(parents=True, exist_ok=True)
            return {"success": True, "file": self._get_file_info(target)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def create_file(self, rel_parent: str, name: str, content: str = "") -> Dict[str, Any]:
        clean_name = name.strip().replace("/", "_").replace("\\", "_")
        if not clean_name or clean_name in (".", ".."):
            return {"success": False, "error": "Invalid file name"}

        target = self._resolve_safe_path(rel_parent) / clean_name
        if target.exists():
            return {"success": False, "error": "File already exists"}

        try:
            target.write_text(content, encoding="utf-8")
            return {"success": True, "file": self._get_file_info(target)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def read_file_content(self, rel_path: str, max_bytes: int = 5 * 1024 * 1024) -> Dict[str, Any]:
        target = self._resolve_safe_path(rel_path)
        if not target.exists() or not target.is_file():
            return {"success": False, "error": "File not found"}

        if target.stat().st_size > max_bytes:
            return {"success": False, "error": "File exceeds maximum preview limit (5MB)"}

        try:
            content = target.read_text(encoding="utf-8", errors="replace")
            return {
                "success": True,
                "content": content,
                "info": self._get_file_info(target)
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    def write_file_content(self, rel_path: str, content: str) -> Dict[str, Any]:
        target = self._resolve_safe_path(rel_path)
        if not target.exists() or not target.is_file():
            return {"success": False, "error": "File not found"}

        try:
            target.write_text(content, encoding="utf-8")
            return {"success": True, "info": self._get_file_info(target)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def rename_item(self, rel_path: str, new_name: str) -> Dict[str, Any]:
        target = self._resolve_safe_path(rel_path)
        if not target.exists():
            return {"success": False, "error": "Source item does not exist"}

        clean_new_name = new_name.strip().replace("/", "_").replace("\\", "_")
        if not clean_new_name or clean_new_name in (".", ".."):
            return {"success": False, "error": "Invalid new name"}

        destination = target.parent / clean_new_name
        if destination.exists():
            return {"success": False, "error": "An item with that name already exists"}

        try:
            target.rename(destination)
            return {"success": True, "file": self._get_file_info(destination)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def move_items(self, source_rel_paths: List[str], dest_rel_folder: str) -> Dict[str, Any]:
        dest_folder = self._resolve_safe_path(dest_rel_folder)
        if not dest_folder.exists() or not dest_folder.is_dir():
            return {"success": False, "error": "Target destination folder not found"}

        moved = []
        errors = []
        for src in source_rel_paths:
            src_target = self._resolve_safe_path(src)
            if not src_target.exists():
                errors.append(f"Source {src} not found")
                continue
            if src_target == dest_folder or dest_folder.is_relative_to(src_target):
                errors.append(f"Cannot move {src} into itself")
                continue
            try:
                dest_file = dest_folder / src_target.name
                shutil.move(str(src_target), str(dest_file))
                moved.append(src)
            except Exception as e:
                errors.append(f"Failed to move {src}: {str(e)}")

        return {"success": len(moved) > 0, "moved": moved, "errors": errors}

    def copy_items(self, source_rel_paths: List[str], dest_rel_folder: str) -> Dict[str, Any]:
        dest_folder = self._resolve_safe_path(dest_rel_folder)
        if not dest_folder.exists() or not dest_folder.is_dir():
            return {"success": False, "error": "Target destination folder not found"}

        copied = []
        errors = []
        for src in source_rel_paths:
            src_target = self._resolve_safe_path(src)
            if not src_target.exists():
                errors.append(f"Source {src} not found")
                continue
            try:
                dest_file = dest_folder / src_target.name
                if dest_file.exists():
                    dest_file = dest_folder / f"Copy_of_{src_target.name}"
                
                if src_target.is_dir():
                    shutil.copytree(str(src_target), str(dest_file))
                else:
                    shutil.copy2(str(src_target), str(dest_file))
                copied.append(src)
            except Exception as e:
                errors.append(f"Failed to copy {src}: {str(e)}")

        return {"success": len(copied) > 0, "copied": copied, "errors": errors}

    def delete_items(self, rel_paths: List[str]) -> Dict[str, Any]:
        deleted = []
        errors = []
        for rel in rel_paths:
            target = self._resolve_safe_path(rel)
            if not target.exists() or target == self.root_dir:
                errors.append(f"Cannot delete {rel}")
                continue
            try:
                if target.is_dir():
                    shutil.rmtree(str(target))
                else:
                    target.unlink()
                deleted.append(rel)
            except Exception as e:
                errors.append(f"Failed to delete {rel}: {str(e)}")

        return {"success": len(deleted) > 0, "deleted": deleted, "errors": errors}

    def create_zip_archive(self, rel_paths: List[str]) -> Optional[str]:
        """Creates a temporary zip archive of requested paths and returns file path."""
        if not rel_paths:
            return None
        
        temp_zip = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        temp_zip.close()

        with zipfile.ZipFile(temp_zip.name, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel in rel_paths:
                target = self._resolve_safe_path(rel)
                if not target.exists():
                    continue
                if target.is_file():
                    zf.write(str(target), arcname=target.name)
                elif target.is_dir():
                    for root, _, files in os.walk(str(target)):
                        for f in files:
                            full_file = Path(root) / f
                            arcname = full_file.relative_to(target.parent)
                            zf.write(str(full_file), arcname=str(arcname))
        return temp_zip.name

file_manager = FileManager()
