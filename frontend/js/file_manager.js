/**
 * Interactive File Manager Module
 */
class FileManagerView {
  constructor() {
    this.currentPath = "";
    this.currentFiles = [];
    this.selectedPaths = new Set();
    this.viewMode = 'grid'; // 'grid' | 'list'
    this.editingFilePath = null;

    this.bindEvents();
  }

  bindEvents() {
    // View Switchers
    document.getElementById('fm-toggle-grid')?.addEventListener('click', () => this.setViewMode('grid'));
    document.getElementById('fm-toggle-list')?.addEventListener('click', () => this.setViewMode('list'));

    // Search filter
    document.getElementById('fm-search-input')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      if (!q) {
        this.renderFiles(this.currentFiles);
      } else {
        const filtered = this.currentFiles.filter(f => f.name.toLowerCase().includes(q));
        this.renderFiles(filtered);
      }
    });

    // New Folder Dialog
    document.getElementById('fm-btn-new-folder')?.addEventListener('click', () => {
      document.getElementById('modal-folder-name').value = '';
      app.openModal('modal-new-folder');
    });

    document.getElementById('modal-folder-submit')?.addEventListener('click', async () => {
      const name = document.getElementById('modal-folder-name').value.trim();
      if (!name) return;
      try {
        await api.createDirectory(this.currentPath, name);
        app.closeModal('modal-new-folder');
        this.refresh();
      } catch (err) {
        alert(err.message);
      }
    });

    // New File Dialog
    document.getElementById('fm-btn-new-file')?.addEventListener('click', () => {
      this.editingFilePath = null;
      document.getElementById('editor-title').innerHTML = '<i data-lucide="file-plus"></i> Create New File';
      document.getElementById('editor-filename-group').style.display = 'block';
      document.getElementById('editor-filename').value = '';
      document.getElementById('editor-content').value = '';
      app.openModal('modal-file-editor');
      if (window.lucide) lucide.createIcons();
    });

    // File Editor Save
    document.getElementById('editor-save-btn')?.addEventListener('click', async () => {
      const content = document.getElementById('editor-content').value;
      try {
        if (this.editingFilePath) {
          await api.writeFile(this.editingFilePath, content);
        } else {
          const fname = document.getElementById('editor-filename').value.trim();
          if (!fname) {
            alert('File name cannot be empty');
            return;
          }
          await api.createFile(this.currentPath, fname, content);
        }
        app.closeModal('modal-file-editor');
        this.refresh();
      } catch (err) {
        alert(err.message);
      }
    });

    // Upload Trigger
    document.getElementById('fm-btn-upload')?.addEventListener('click', () => {
      document.getElementById('upload-target-path').value = this.currentPath;
      app.switchView('uploader');
    });

    // Bulk Delete
    document.getElementById('fm-bulk-delete')?.addEventListener('click', async () => {
      const count = this.selectedPaths.size;
      if (!count || !confirm(`Permanently delete ${count} selected item(s)?`)) return;
      try {
        await api.deleteFiles(Array.from(this.selectedPaths));
        this.selectedPaths.clear();
        this.updateBulkBar();
        this.refresh();
      } catch (err) {
        alert(err.message);
      }
    });

    // Bulk Zip Download
    document.getElementById('fm-bulk-zip')?.addEventListener('click', async () => {
      const paths = Array.from(this.selectedPaths);
      if (!paths.length) return;
      
      const res = await fetch(api.getDownloadZipUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths })
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'diskpulse_archive.zip';
        a.click();
      }
    });

    // Select all checkbox
    document.getElementById('fm-select-all-checkbox')?.addEventListener('change', (e) => {
      if (e.target.checked) {
        this.currentFiles.forEach(f => this.selectedPaths.add(f.path));
      } else {
        this.selectedPaths.clear();
      }
      this.updateBulkBar();
      this.renderFiles(this.currentFiles);
    });
  }

  setViewMode(mode) {
    this.viewMode = mode;
    const gridEl = document.getElementById('fm-files-grid');
    const listEl = document.getElementById('fm-files-list-wrapper');
    if (mode === 'grid') {
      gridEl.style.display = 'grid';
      listEl.style.display = 'none';
    } else {
      gridEl.style.display = 'none';
      listEl.style.display = 'block';
    }
    this.renderFiles(this.currentFiles);
  }

  async navigateTo(path) {
    this.currentPath = path;
    this.selectedPaths.clear();
    this.updateBulkBar();
    await this.refresh();
  }

  async refresh() {
    try {
      const res = await api.listFiles(this.currentPath);
      this.currentFiles = res.files || [];
      this.renderBreadcrumbs(res.breadcrumbs || []);
      this.renderFiles(this.currentFiles);
    } catch (err) {
      console.error(err);
    }
  }

  renderBreadcrumbs(breadcrumbs) {
    const container = document.getElementById('fm-breadcrumbs');
    if (!container) return;

    container.innerHTML = breadcrumbs.map((crumb, idx) => {
      const isLast = idx === breadcrumbs.length - 1;
      if (isLast) {
        return `<span class="crumb-item current">${crumb.name === 'root' ? '<i data-lucide="hard-drive" style="width:14px; display:inline;"></i> root' : crumb.name}</span>`;
      }
      return `
        <span class="crumb-item" onclick="fileManager.navigateTo('${crumb.path}')">
          ${crumb.name === 'root' ? '<i data-lucide="hard-drive" style="width:14px; display:inline;"></i> root' : crumb.name}
        </span>
        <span class="crumb-separator">/</span>
      `;
    }).join('');
    if (window.lucide) lucide.createIcons();
  }

  renderFiles(files) {
    const gridContainer = document.getElementById('fm-files-grid');
    const listBody = document.getElementById('fm-files-list-tbody');

    if (!files.length) {
      gridContainer.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-dim); padding: 48px;"><i data-lucide="folder-open" style="width:48px;height:48px;margin-bottom:12px;opacity:0.4;"></i><p>This directory is empty</p></div>';
      listBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-dim); padding: 32px;">This directory is empty</td></tr>';
      if (window.lucide) lucide.createIcons();
      return;
    }

    // Render Grid View
    gridContainer.innerHTML = files.map(f => {
      const isSelected = this.selectedPaths.has(f.path);
      const icon = this.getCategoryIcon(f.category);
      return `
        <div class="file-item-grid ${isSelected ? 'selected' : ''}" data-path="${f.path}" onclick="fileManager.onItemClick(event, '${f.path}', ${f.is_dir}, '${f.category}')">
          <div class="file-icon-wrap" style="color: ${this.getCategoryColor(f.category)};">
            <i data-lucide="${icon}"></i>
          </div>
          <div class="file-name" title="${f.name}">${f.name}</div>
          <div class="file-meta">${f.size_human}</div>
        </div>
      `;
    }).join('');

    // Render List View
    listBody.innerHTML = files.map(f => {
      const isSelected = this.selectedPaths.has(f.path);
      const icon = this.getCategoryIcon(f.category);
      return `
        <tr class="${isSelected ? 'selected' : ''}" onclick="fileManager.onItemClick(event, '${f.path}', ${f.is_dir}, '${f.category}')">
          <td><input type="checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); fileManager.toggleSelect('${f.path}');"></td>
          <td>
            <div style="display: flex; align-items: center; gap: 8px;">
              <i data-lucide="${icon}" style="width: 16px; height: 16px; color: ${this.getCategoryColor(f.category)};"></i>
              <strong style="color: var(--text-main);">${f.name}</strong>
            </div>
          </td>
          <td>${f.size_human}</td>
          <td><span class="nav-badge">${f.category}</span></td>
          <td>${f.modified_human}</td>
          <td><code>${f.permissions}</code></td>
          <td style="text-align: right;">
            <button class="btn btn-secondary btn-icon" style="width: 28px; height: 28px;" onclick="event.stopPropagation(); fileManager.openItem('${f.path}', ${f.is_dir}, '${f.category}')" title="Open / Preview">
              <i data-lucide="eye" style="width: 14px; height: 14px;"></i>
            </button>
            <button class="btn btn-secondary btn-icon" style="width: 28px; height: 28px;" onclick="event.stopPropagation(); fileManager.promptRename('${f.path}', '${f.name}')" title="Rename">
              <i data-lucide="edit-2" style="width: 14px; height: 14px;"></i>
            </button>
            <button class="btn btn-danger btn-icon" style="width: 28px; height: 28px;" onclick="event.stopPropagation(); fileManager.deleteSingle('${f.path}', '${f.name}')" title="Delete">
              <i data-lucide="trash" style="width: 14px; height: 14px;"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  onItemClick(event, path, isDir, category) {
    if (event.ctrlKey || event.metaKey) {
      this.toggleSelect(path);
      return;
    }
    // Double click behavior or single click
    if (isDir) {
      this.navigateTo(path);
    } else {
      this.openItem(path, isDir, category);
    }
  }

  toggleSelect(path) {
    if (this.selectedPaths.has(path)) {
      this.selectedPaths.delete(path);
    } else {
      this.selectedPaths.add(path);
    }
    this.updateBulkBar();
    this.renderFiles(this.currentFiles);
  }

  updateBulkBar() {
    const bar = document.getElementById('fm-bulk-bar');
    const countEl = document.getElementById('fm-bulk-count');
    const count = this.selectedPaths.size;
    if (count > 0) {
      bar.style.display = 'flex';
      countEl.textContent = `${count} item${count > 1 ? 's' : ''} selected`;
    } else {
      bar.style.display = 'none';
    }
  }

  async openItem(path, isDir, category) {
    if (isDir) {
      this.navigateTo(path);
      return;
    }

    const rawUrl = api.getRawFileUrl(path);

    if (category === 'video') {
      app.switchView('media');
      mediaPlayer.playVideo(rawUrl, path.split('/').pop());
    } else if (category === 'audio') {
      app.switchView('media');
      mediaPlayer.playAudio(rawUrl, path.split('/').pop());
    } else if (category === 'image') {
      document.getElementById('lightbox-title').textContent = path.split('/').pop();
      document.getElementById('lightbox-img').src = rawUrl;
      app.openModal('modal-lightbox');
    } else if (category === 'text' || category === 'pdf') {
      try {
        const data = await api.readFile(path);
        this.editingFilePath = path;
        document.getElementById('editor-title').innerHTML = `<i data-lucide="file-edit"></i> ${path.split('/').pop()}`;
        document.getElementById('editor-filename-group').style.display = 'none';
        document.getElementById('editor-content').value = data.content;
        app.openModal('modal-file-editor');
        if (window.lucide) lucide.createIcons();
      } catch (err) {
        window.open(rawUrl, '_blank');
      }
    } else {
      // Direct file download for archives / binaries
      window.open(`${api.baseUrl}/api/files/download?path=${encodeURIComponent(path)}`, '_blank');
    }
  }

  async promptRename(path, oldName) {
    const newName = prompt("Rename item:", oldName);
    if (!newName || newName === oldName) return;
    try {
      await api.renameFile(path, newName);
      this.refresh();
    } catch (err) {
      alert(err.message);
    }
  }

  async deleteSingle(path, name) {
    if (!confirm(`Delete "${name}"?`)) return;
    try {
      await api.deleteFiles([path]);
      this.refresh();
    } catch (err) {
      alert(err.message);
    }
  }

  getCategoryIcon(cat) {
    switch (cat) {
      case 'folder': return 'folder';
      case 'video': return 'film';
      case 'audio': return 'music';
      case 'image': return 'image';
      case 'pdf': return 'file-text';
      case 'text': return 'file-code';
      case 'archive': return 'archive';
      case 'executable': return 'cpu';
      default: return 'file';
    }
  }

  getCategoryColor(cat) {
    switch (cat) {
      case 'folder': return '#38bdf8';
      case 'video': return '#f43f5e';
      case 'audio': return '#8b5cf6';
      case 'image': return '#10b981';
      case 'pdf': return '#f59e0b';
      case 'text': return '#00f2fe';
      case 'archive': return '#eab308';
      default: return '#94a3b8';
    }
  }
}

const fileManager = new FileManagerView();
