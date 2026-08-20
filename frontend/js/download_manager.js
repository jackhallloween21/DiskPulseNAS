/**
 * Download Manager Controller
 */
class DownloadManagerView {
  constructor() {
    this.tasks = [];
    this.activeCategory = 'all';
    this.pollInterval = null;

    this.bindEvents();
    this.startPolling();
  }

  bindEvents() {
    // Open Add Download Modal
    document.getElementById('btn-open-add-download')?.addEventListener('click', () => {
      document.getElementById('modal-dl-url').value = '';
      document.getElementById('modal-dl-custom-dir').value = '';
      app.openModal('modal-add-download');
    });

    document.getElementById('quick-btn-download')?.addEventListener('click', () => {
      document.getElementById('modal-dl-url').value = '';
      document.getElementById('modal-dl-custom-dir').value = '';
      app.openModal('modal-add-download');
    });

    // Submit Add Download
    document.getElementById('modal-dl-submit')?.addEventListener('click', async () => {
      const url = document.getElementById('modal-dl-url').value.trim();
      if (!url) {
        alert('Please enter a valid HTTP/HTTPS URL or Magnet Link');
        return;
      }
      const category = document.getElementById('modal-dl-category').value;
      const customDir = document.getElementById('modal-dl-custom-dir').value.trim();

      try {
        await api.addDownload(url, category === 'downloads' ? null : category, customDir);
        app.closeModal('modal-add-download');
        app.switchView('downloads');
        this.fetchTasks();
      } catch (err) {
        alert(err.message);
      }
    });

    // Category Filter Buttons
    document.querySelectorAll('.dl-category-filters .btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.dl-category-filters .btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.activeCategory = e.target.dataset.cat;
        this.renderTasks();
      });
    });
  }

  startPolling() {
    this.fetchTasks();
    this.pollInterval = setInterval(() => this.fetchTasks(), 1000);
  }

  async fetchTasks() {
    try {
      this.tasks = await api.getDownloads();
      this.updateSummary();
      this.renderTasks();
    } catch (err) {
      // Ignore polling connection blips
    }
  }

  updateSummary() {
    const activeTasks = this.tasks.filter(t => t.status === 'downloading');
    const completedTasks = this.tasks.filter(t => t.status === 'completed');
    const totalSpeedBytes = activeTasks.reduce((acc, t) => acc + (t.speed_bytes_sec || 0), 0);

    const activeEl = document.getElementById('dl-stat-active');
    const speedEl = document.getElementById('dl-stat-speed');
    const compEl = document.getElementById('dl-stat-completed');
    const badgeEl = document.getElementById('badge-downloads-count');

    if (activeEl) activeEl.textContent = activeTasks.length;
    if (speedEl) speedEl.textContent = `${(totalSpeedBytes / (1024 * 1024)).toFixed(2)} MB/s`;
    if (compEl) compEl.textContent = completedTasks.length;
    if (badgeEl) {
      badgeEl.textContent = activeTasks.length;
      badgeEl.className = activeTasks.length > 0 ? 'nav-badge active-badge' : 'nav-badge';
    }
  }

  renderTasks() {
    const container = document.getElementById('dl-tasks-container');
    if (!container) return;

    const filtered = this.activeCategory === 'all'
      ? this.tasks
      : this.tasks.filter(t => t.category.toLowerCase() === this.activeCategory);

    if (!filtered.length) {
      container.innerHTML = `
        <div style="text-align: center; padding: 48px; color: var(--text-dim);">
          <i data-lucide="download-cloud" style="width: 48px; height: 48px; margin-bottom: 12px; opacity: 0.5;"></i>
          <p>No downloads in this category.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    container.innerHTML = filtered.map(t => {
      const isCompleted = t.status === 'completed';
      const isDownloading = t.status === 'downloading';
      const isPaused = t.status === 'paused';
      const isError = t.status === 'error';

      let statusBadge = `<span class="nav-badge" style="background: rgba(0,242,254,0.15); color: var(--accent-cyan); text-transform: uppercase;">${t.status}</span>`;
      if (isCompleted) {
        statusBadge = `<span class="nav-badge" style="background: rgba(16,185,129,0.15); color: var(--accent-emerald);">COMPLETED</span>`;
      } else if (isPaused) {
        statusBadge = `<span class="nav-badge" style="background: rgba(245,158,11,0.15); color: var(--accent-amber);">PAUSED</span>`;
      } else if (isError) {
        statusBadge = `<span class="nav-badge" style="background: rgba(244,63,94,0.15); color: var(--accent-rose);" title="${t.error_message}">ERROR</span>`;
      }

      return `
        <div class="dl-task-card">
          <div class="dl-task-header">
            <div class="dl-task-title">
              <i data-lucide="${t.is_magnet ? 'magnet' : 'link'}" style="color: ${t.is_magnet ? 'var(--accent-violet)' : 'var(--accent-cyan)'}; width: 18px; height: 18px;"></i>
              <span>${t.filename}</span>
              ${statusBadge}
              <span class="nav-badge">${t.category}</span>
            </div>

            <div class="dl-task-actions">
              ${isCompleted ? `
                <button class="btn btn-secondary btn-icon" style="width: 30px; height: 30px;" onclick="downloadManager.openInFileManager('${t.target_dir}')" title="Open in File Manager">
                  <i data-lucide="folder-open" style="width: 14px; height: 14px;"></i>
                </button>
                ${(t.is_media || t.category === 'media') ? `
                  <button class="btn btn-primary btn-icon" style="width: 30px; height: 30px;" onclick="downloadManager.playInMediaHub('${t.file_rel_path}', '${t.filename.replace(/'/g, "\\'")}')" title="Play in Media Hub">
                    <i data-lucide="play" style="width: 14px; height: 14px;"></i>
                  </button>
                ` : ''}
                <button class="btn btn-secondary btn-icon" style="width: 30px; height: 30px;" onclick="downloadManager.downloadToBrowser('${t.file_rel_path}')" title="Download to Device">
                  <i data-lucide="download" style="width: 14px; height: 14px;"></i>
                </button>
              ` : ''}

              ${isDownloading ? `
                <button class="btn btn-secondary btn-icon" style="width: 30px; height: 30px;" onclick="downloadManager.pauseTask('${t.task_id}')" title="Pause">
                  <i data-lucide="pause" style="width: 14px; height: 14px;"></i>
                </button>
              ` : ''}

              ${isPaused ? `
                <button class="btn btn-secondary btn-icon" style="width: 30px; height: 30px;" onclick="downloadManager.resumeTask('${t.task_id}')" title="Resume">
                  <i data-lucide="play" style="width: 14px; height: 14px;"></i>
                </button>
              ` : ''}

              ${isError ? `
                <button class="btn btn-secondary btn-icon" style="width: 30px; height: 30px;" onclick="downloadManager.retryTask('${t.task_id}')" title="Retry">
                  <i data-lucide="rotate-cw" style="width: 14px; height: 14px;"></i>
                </button>
              ` : ''}

              <button class="btn btn-danger btn-icon" style="width: 30px; height: 30px;" onclick="downloadManager.deleteTask('${t.task_id}')" title="Delete">
                <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
              </button>
            </div>
          </div>

          <div class="dl-progress-bar">
            <div class="dl-progress-fill ${isCompleted ? 'completed' : ''}" style="width: ${t.progress_percent}%;"></div>
          </div>

          <div class="dl-task-info">
            <div>
              <span>${t.downloaded_human} / ${t.total_human} (${t.progress_percent}%)</span>
              ${t.is_magnet ? `<span style="margin-left: 12px; color: var(--accent-violet);">Peers: ${t.peers} | Seeds: ${t.seeds}</span>` : ''}
              ${t.backend ? `<span class="nav-badge" style="margin-left: 8px; font-size: 0.65rem;">${t.backend}</span>` : ''}
            </div>
            <div>
              ${isDownloading ? `
                <span style="color: var(--accent-cyan); font-weight: 600;">${t.speed_human_sec}</span>
                <span style="margin-left: 8px; color: var(--text-dim);">ETA: ${t.eta_human}</span>
              ` : ''}
              <span style="margin-left: 12px; color: var(--text-dim);"><i data-lucide="folder" style="width: 12px; height: 12px; display:inline;"></i> /${t.target_dir}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  openInFileManager(targetDir) {
    app.switchView('files');
    fileManager.navigateTo(targetDir);
  }

  playInMediaHub(fileRelPath, filename) {
    app.switchView('media');
    mediaPlayer.playDirectPath(fileRelPath, 'media', filename);
  }

  downloadToBrowser(fileRelPath) {
    window.open(`${api.baseUrl}/api/files/download?path=${encodeURIComponent(fileRelPath)}`, '_blank');
  }

  async pauseTask(taskId) {
    await api.pauseDownload(taskId);
    this.fetchTasks();
  }

  async resumeTask(taskId) {
    await api.resumeDownload(taskId);
    this.fetchTasks();
  }

  async retryTask(taskId) {
    await api.retryDownload(taskId);
    this.fetchTasks();
  }

  async deleteTask(taskId) {
    if (!confirm('Remove download task?')) return;
    await api.deleteDownload(taskId, false);
    this.fetchTasks();
  }
}

const downloadManager = new DownloadManagerView();
