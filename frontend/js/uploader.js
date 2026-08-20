/**
 * Multi-Device Drag & Drop Uploader & Mobile QR Pairing
 * Fixed: progress bar, speed, ETA, pause/cancel controls, button state
 */
class MultiDeviceUploader {
  constructor() {
    this.dropzone = document.getElementById('uploader-dropzone');
    this.fileInput = document.getElementById('uploader-file-input');
    this.queueContainer = document.getElementById('upload-queue-list');
    this.startBtn = document.getElementById('btn-start-upload');

    this.filesQueue = [];
    this.isUploading = false;
    this.cancelledItems = new Set(); // indexes of cancelled uploads

    this.bindEvents();
  }

  bindEvents() {
    if (!this.dropzone) return;

    // Dropzone clicks
    this.dropzone.addEventListener('click', () => this.fileInput.click());

    // File input changes
    this.fileInput.addEventListener('change', (e) => {
      this.addFilesToQueue(Array.from(e.target.files));
      this.fileInput.value = '';
    });

    // Drag and Drop events
    ['dragenter', 'dragover'].forEach(name => {
      this.dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        this.dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      this.dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        this.dropzone.classList.remove('dragover');
      });
    });

    this.dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files) {
        this.addFilesToQueue(Array.from(e.dataTransfer.files));
      }
    });

    // Start / Stop upload button
    this.startBtn?.addEventListener('click', () => {
      if (this.isUploading) {
        this.stopAll();
      } else {
        this.startUpload();
      }
    });

    // Mobile QR Modal Trigger
    document.getElementById('btn-open-qr-modal')?.addEventListener('click', () => {
      this.generateMobileQR();
      app.openModal('modal-mobile-qr');
    });

    document.getElementById('quick-btn-upload')?.addEventListener('click', () => {
      app.switchView('uploader');
    });
  }

  addFilesToQueue(files) {
    files.forEach(f => {
      this.filesQueue.push({
        file: f,
        status: 'pending',  // pending | uploading | done | error | cancelled
        progress: 0,
        speedBps: 0,
        etaSecs: 0,
        uploadedBytes: 0,
        xhr: null,
        startedAt: null,
      });
    });
    this.renderQueue();
    this.updateStartButton();
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  renderQueue() {
    if (!this.queueContainer) return;

    if (!this.filesQueue.length) {
      this.queueContainer.innerHTML =
        '<p style="text-align: center; color: var(--text-dim); padding: 24px;">No files in upload queue.</p>';
      return;
    }

    this.queueContainer.innerHTML = this.filesQueue.map((item, idx) => {
      const f = item.file;
      const sizeMB = (f.size / (1024 * 1024)).toFixed(2);
      const uploadedMB = (item.uploadedBytes / (1024 * 1024)).toFixed(2);

      // Status badge
      let badge = '';
      if (item.status === 'pending') {
        badge = `<span class="nav-badge">Pending</span>`;
      } else if (item.status === 'uploading') {
        badge = `<span class="nav-badge" style="background:rgba(0,242,254,0.2);color:var(--accent-cyan);">Uploading</span>`;
      } else if (item.status === 'done') {
        badge = `<span class="nav-badge" style="background:rgba(16,185,129,0.2);color:var(--accent-emerald);">✓ Done</span>`;
      } else if (item.status === 'error') {
        badge = `<span class="nav-badge" style="background:rgba(244,63,94,0.2);color:var(--accent-rose);">✗ Error</span>`;
      } else if (item.status === 'cancelled') {
        badge = `<span class="nav-badge" style="background:rgba(245,158,11,0.2);color:var(--accent-amber);">Cancelled</span>`;
      }

      // Speed & ETA string (only while uploading)
      const speedStr  = this._formatSpeed(item.speedBps);
      const etaStr    = item.etaSecs > 0 ? this._formatETA(item.etaSecs) : '--';
      const pct       = item.progress;

      // Progress bar colour
      let barColor = 'var(--grad-primary)';
      if (item.status === 'done')      barColor = 'var(--grad-emerald)';
      if (item.status === 'error')     barColor = 'var(--grad-rose)';
      if (item.status === 'cancelled') barColor = 'var(--grad-amber)';

      // Action buttons
      let actionBtns = '';
      if (item.status === 'pending') {
        actionBtns = `
          <button class="btn btn-secondary btn-icon" style="width:28px;height:28px;"
            onclick="uploaderWidget.removeFromQueue(${idx})" title="Remove">
            <i data-lucide="x" style="width:14px;height:14px;"></i>
          </button>`;
      } else if (item.status === 'uploading') {
        actionBtns = `
          <button class="btn btn-danger btn-icon" style="width:28px;height:28px;"
            onclick="uploaderWidget.cancelItem(${idx})" title="Cancel upload">
            <i data-lucide="x-circle" style="width:14px;height:14px;"></i>
          </button>`;
      } else if (item.status === 'error' || item.status === 'cancelled') {
        actionBtns = `
          <button class="btn btn-secondary btn-icon" style="width:28px;height:28px;"
            onclick="uploaderWidget.retryItem(${idx})" title="Retry">
            <i data-lucide="rotate-cw" style="width:14px;height:14px;"></i>
          </button>
          <button class="btn btn-secondary btn-icon" style="width:28px;height:28px;"
            onclick="uploaderWidget.removeFromQueue(${idx})" title="Remove">
            <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
          </button>`;
      } else if (item.status === 'done') {
        actionBtns = `
          <button class="btn btn-secondary btn-icon" style="width:28px;height:28px;"
            onclick="uploaderWidget.removeFromQueue(${idx})" title="Remove">
            <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
          </button>`;
      }

      return `
        <div class="upload-item-card" style="flex-direction: column; align-items: stretch; gap: 10px;" id="upload-item-${idx}">
          <!-- Row 1: file info + badge + action -->
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <div style="display:flex;align-items:center;gap:12px;overflow:hidden;flex:1;">
              <i data-lucide="file" style="color:var(--accent-cyan);flex-shrink:0;"></i>
              <div style="overflow:hidden;">
                <strong style="font-size:0.9rem;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">${f.name}</strong>
                <div style="font-size:0.75rem;color:var(--text-dim);">${sizeMB} MB · ${f.type || 'Unknown type'}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
              ${badge}
              ${actionBtns}
            </div>
          </div>

          <!-- Row 2: progress bar (always visible once added) -->
          <div style="background:var(--bg-tertiary);border-radius:4px;height:8px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${barColor};border-radius:4px;transition:width 0.3s ease;"></div>
          </div>

          <!-- Row 3: stats row -->
          <div style="display:flex;justify-content:space-between;font-size:0.78rem;color:var(--text-muted);">
            <span>
              ${item.status === 'uploading' || item.status === 'done'
                ? `${uploadedMB} MB / ${sizeMB} MB`
                : `0 MB / ${sizeMB} MB`}
            </span>
            <span style="display:flex;gap:16px;">
              ${item.status === 'uploading' ? `
                <span style="color:var(--accent-cyan);font-weight:600;">${speedStr}</span>
                <span>ETA: <strong style="color:#fff;">${etaStr}</strong></span>
              ` : ''}
              <span style="font-weight:700;color:${item.status === 'done' ? 'var(--accent-emerald)' : '#fff'};">${pct}%</span>
            </span>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  /** Update only a single item's progress bars/stats without a full re-render */
  _updateItemProgress(idx) {
    const item = this.filesQueue[idx];
    if (!item) return;

    const card = document.getElementById(`upload-item-${idx}`);
    if (!card) {
      // Fallback — full re-render
      this.renderQueue();
      return;
    }

    const f = item.file;
    const sizeMB     = (f.size / (1024 * 1024)).toFixed(2);
    const uploadedMB = (item.uploadedBytes / (1024 * 1024)).toFixed(2);
    const pct        = item.progress;

    // Progress bar
    const bar = card.querySelector('[data-role="progress-bar"]') || card.querySelectorAll('div > div')[1]?.firstElementChild;
    if (bar) bar.style.width = `${pct}%`;

    // Stats row — just rebuild the entire card when uploading so the numbers are always fresh
    this.renderQueue();
  }

  updateStartButton() {
    if (!this.startBtn) return;
    const hasPending = this.filesQueue.some(i => i.status === 'pending');
    if (this.isUploading) {
      this.startBtn.innerHTML = '<i data-lucide="square"></i> Stop All Uploads';
      this.startBtn.style.display = 'inline-flex';
      this.startBtn.style.background = 'var(--grad-rose)';
    } else if (hasPending) {
      this.startBtn.innerHTML = '<i data-lucide="play"></i> Start Upload';
      this.startBtn.style.display = 'inline-flex';
      this.startBtn.style.background = '';
    } else {
      this.startBtn.style.display = hasPending || this.filesQueue.length > 0 ? 'inline-flex' : 'none';
      this.startBtn.innerHTML = '<i data-lucide="play"></i> Start Upload';
      this.startBtn.style.background = '';
    }
    if (window.lucide) lucide.createIcons();
  }

  // ─── Upload logic ───────────────────────────────────────────────────────────

  async startUpload() {
    if (this.isUploading) return;

    const targetFolder = document.getElementById('upload-target-path')?.value.trim() || '';
    const pendingItems = this.filesQueue.filter(i => i.status === 'pending');
    if (!pendingItems.length) return;

    this.isUploading = true;
    this.updateStartButton();

    for (const item of pendingItems) {
      if (item.status === 'cancelled') continue;
      await this._uploadSingleItem(item, targetFolder);
    }

    this.isUploading = false;
    this.updateStartButton();
    fileManager.refresh();
    this.renderQueue();
  }

  _uploadSingleItem(item, targetFolder) {
    return new Promise((resolve) => {
      item.status = 'uploading';
      item.startedAt = Date.now();
      item.uploadedBytes = 0;
      item.speedBps = 0;
      item.etaSecs = 0;
      item.progress = 0;
      this.renderQueue();

      const formData = new FormData();
      formData.append('target_folder', targetFolder);
      formData.append('files', item.file);

      const xhr = new XMLHttpRequest();
      item.xhr = xhr;
      xhr.open('POST', `${api.baseUrl}/api/upload`);

      let lastLoaded = 0;
      let lastTime = Date.now();

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;

        const now = Date.now();
        const elapsed = (now - lastTime) / 1000;  // seconds since last update
        const deltaByes = e.loaded - lastLoaded;

        if (elapsed > 0.3) {  // update every 300 ms minimum
          item.speedBps     = deltaByes / elapsed;
          const remaining   = e.total - e.loaded;
          item.etaSecs      = item.speedBps > 0 ? remaining / item.speedBps : 0;
          lastLoaded = e.loaded;
          lastTime   = now;
        }

        item.uploadedBytes = e.loaded;
        item.progress      = Math.round((e.loaded / e.total) * 100);
        this.renderQueue();
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          item.status = 'done';
          item.progress = 100;
          item.speedBps = 0;
          item.etaSecs  = 0;
        } else {
          item.status = 'error';
        }
        item.xhr = null;
        this.renderQueue();
        resolve();
      };

      xhr.onerror = () => {
        item.status = 'error';
        item.xhr = null;
        this.renderQueue();
        resolve();
      };

      xhr.onabort = () => {
        item.status = 'cancelled';
        item.speedBps = 0;
        item.etaSecs  = 0;
        item.xhr = null;
        this.renderQueue();
        resolve();
      };

      xhr.send(formData);
    });
  }

  stopAll() {
    this.filesQueue.forEach(item => {
      if (item.status === 'uploading' && item.xhr) {
        item.xhr.abort();
      }
    });
    this.isUploading = false;
    this.updateStartButton();
  }

  cancelItem(idx) {
    const item = this.filesQueue[idx];
    if (!item) return;
    if (item.xhr) {
      item.xhr.abort();  // triggers xhr.onabort → sets status
    } else {
      item.status = 'cancelled';
      this.renderQueue();
    }
  }

  retryItem(idx) {
    const item = this.filesQueue[idx];
    if (!item) return;
    item.status = 'pending';
    item.progress = 0;
    item.uploadedBytes = 0;
    item.speedBps = 0;
    item.etaSecs = 0;
    this.renderQueue();
    this.updateStartButton();
  }

  removeFromQueue(idx) {
    const item = this.filesQueue[idx];
    if (item?.xhr) item.xhr.abort();
    this.filesQueue.splice(idx, 1);
    this.renderQueue();
    this.updateStartButton();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _formatSpeed(bps) {
    if (!bps || bps <= 0) return '0 B/s';
    if (bps >= 1024 * 1024 * 1024) return `${(bps / (1024 ** 3)).toFixed(2)} GB/s`;
    if (bps >= 1024 * 1024)        return `${(bps / (1024 ** 2)).toFixed(2)} MB/s`;
    if (bps >= 1024)               return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${Math.round(bps)} B/s`;
  }

  _formatETA(secs) {
    if (!secs || secs <= 0 || !isFinite(secs)) return '--';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // ─── Mobile QR Pairing ─────────────────────────────────────────────────────

  generateMobileQR() {
    const qrContainer = document.getElementById('qrcode-container');
    const urlText = document.getElementById('mobile-qr-url');
    if (!qrContainer) return;

    qrContainer.innerHTML = '';
    const url = window.location.href;
    if (urlText) urlText.textContent = url;

    if (window.QRCode) {
      new QRCode(qrContainer, {
        text: url,
        width: 170,
        height: 170,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });
    }
  }
}

const uploaderWidget = new MultiDeviceUploader();
