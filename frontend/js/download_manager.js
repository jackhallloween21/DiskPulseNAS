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
    const openModal = () => {
      this.resetDownloadModal();
      app.openModal('modal-add-download');
      this.refreshYtdlpStrip();
    };
    document.getElementById('btn-open-add-download')?.addEventListener('click', openModal);
    document.getElementById('quick-btn-download')?.addEventListener('click', openModal);

    // Auto-reveal media options + auto-fetch formats when a media URL is entered
    const urlInput = document.getElementById('modal-dl-url');
    urlInput?.addEventListener('input', () => {
      const val = urlInput.value.trim();
      const looksMedia = this.isMediaUrl(val);
      const box = document.getElementById('modal-dl-media-options');
      if (box && looksMedia && box.style.display === 'none') {
        box.style.display = 'block';
      }
      // Invalidate a stale probe if the URL changed
      if (this._probedUrl && val !== this._probedUrl) {
        this.clearProbePreview();
      }
      // Auto-fetch available formats for known media hosts (debounced so we
      // don't fire a request on every keystroke while pasting).
      clearTimeout(this._probeTimer);
      if (this.isKnownMediaHost(val) && val !== this._probedUrl) {
        this._probeTimer = setTimeout(() => {
          if (document.getElementById('modal-dl-url').value.trim() === val) {
            this.handleProbe({ auto: true });
          }
        }, 700);
      }
    });

    // Fetch available formats
    document.getElementById('modal-dl-fetch')?.addEventListener('click', () => this.handleProbe());

    // Video / Audio mode toggle
    document.querySelectorAll('.dl-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.dl-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const audio = btn.dataset.mode === 'audio';
        document.getElementById('modal-dl-video-row').style.display = audio ? 'none' : 'block';
        document.getElementById('modal-dl-audio-row').style.display = audio ? 'block' : 'none';
        this.updateFfmpegWarning();
      });
    });

    // Lossless formats have no bitrate choice
    document.getElementById('modal-dl-audio-format')?.addEventListener('change', (e) => {
      const lossless = ['flac', 'wav'].includes(e.target.value);
      const wrap = document.getElementById('modal-dl-bitrate-wrap');
      if (wrap) wrap.style.visibility = lossless ? 'hidden' : 'visible';
      this.updateFfmpegWarning();
    });

    // Update yt-dlp
    document.getElementById('modal-dl-ytdlp-update')?.addEventListener('click', () => this.handleYtdlpUpdate());

    // Submit Add Download
    document.getElementById('modal-dl-submit')?.addEventListener('click', async () => {
      const url = document.getElementById('modal-dl-url').value.trim();
      if (!url) {
        alert('Please enter a valid HTTP/HTTPS URL or Magnet Link');
        return;
      }
      const category = document.getElementById('modal-dl-category').value;
      const customDir = document.getElementById('modal-dl-custom-dir').value.trim();
      const mode = document.querySelector('.dl-mode-btn.active')?.dataset.mode || 'video';
      const qSel = document.getElementById('modal-dl-quality');
      const qOpt = qSel.options[qSel.selectedIndex];
      const opts = {
        mode,
        maxHeight: qSel.value,
        // Exact stream picked from the probed list (video mode only). The
        // backend still appends a closest-height fallback, so this never
        // hard-fails if the stream has vanished.
        formatId: mode === 'video' ? (qOpt?.dataset.formatId || '') : '',
        progressive: mode === 'video' ? (qOpt?.dataset.progressive === '1') : false,
        audioFormat: document.getElementById('modal-dl-audio-format').value,
        audioBitrate: document.getElementById('modal-dl-audio-bitrate').value,
      };

      try {
        await api.addDownload(url, category === 'downloads' ? null : category, customDir, null, opts);
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

  // Rough check: does this look like a link yt-dlp handles (so we offer quality)?
  isMediaUrl(url) {
    if (!url || url.startsWith('magnet:')) return false;
    if (/\.(torrent|iso|zip|rar|7z|exe|dmg|pkg|deb|img|bin|tar|gz)$/i.test(url)) return false;
    return /(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|tiktok\.com|twitch\.tv|soundcloud\.com|reddit\.com|facebook\.com|instagram\.com)/i.test(url)
      || /^https?:\/\//i.test(url);  // allow any http(s); probe will confirm
  }

  // Stricter check used to decide whether to AUTO-probe on paste. We only
  // auto-fetch for well-known video/audio hosts so a plain webpage URL doesn't
  // trigger a needless extraction; the manual "Fetch formats" button still
  // works for anything.
  isKnownMediaHost(url) {
    return /^https?:\/\/[^\s]*?(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|tiktok\.com|twitch\.tv|soundcloud\.com|reddit\.com|facebook\.com|instagram\.com|twitter\.com|x\.com)/i.test(url || '');
  }

  resetDownloadModal() {
    clearTimeout(this._probeTimer);
    this._probing = false;
    document.getElementById('modal-dl-url').value = '';
    document.getElementById('modal-dl-custom-dir').value = '';
    document.getElementById('modal-dl-media-options').style.display = 'none';
    document.getElementById('modal-dl-quality').innerHTML = `
      <option value="best" data-format-id="">Best available</option>
      <option value="2160" data-format-id="">2160p (4K)</option>
      <option value="1440" data-format-id="">1440p (2K)</option>
      <option value="1080" data-format-id="">1080p (Full HD)</option>
      <option value="720" data-format-id="">720p (HD)</option>
      <option value="480" data-format-id="">480p</option>
      <option value="360" data-format-id="">360p</option>`;
    document.querySelectorAll('.dl-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'video'));
    document.getElementById('modal-dl-video-row').style.display = 'block';
    document.getElementById('modal-dl-audio-row').style.display = 'none';
    this.clearProbePreview();
  }

  clearProbePreview() {
    this._probedUrl = null;
    this._probeData = null;
    const preview = document.getElementById('modal-dl-preview');
    if (preview) preview.style.display = 'none';
    const msg = document.getElementById('modal-dl-probe-msg');
    if (msg) msg.style.display = 'none';
    const warn = document.getElementById('modal-dl-ffmpeg-warn');
    if (warn) warn.style.display = 'none';
  }

  async handleProbe(opts = {}) {
    const url = document.getElementById('modal-dl-url').value.trim();
    if (!url) { if (!opts.auto) alert('Enter a URL first.'); return; }
    if (this._probing) return;   // don't stack an auto-probe on a manual one
    this._probing = true;

    const btn = document.getElementById('modal-dl-fetch');
    const msg = document.getElementById('modal-dl-probe-msg');
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader"></i> Fetching…';
    if (window.lucide) lucide.createIcons();
    if (msg) { msg.style.display = 'block'; msg.style.color = 'var(--text-dim)'; msg.textContent = opts.auto ? 'Reading available qualities…' : 'Inspecting available formats…'; }

    try {
      const res = await api.probeMedia(url);
      if (!res.success) throw new Error(res.error || 'Could not read this URL.');
      this._probedUrl = url;
      this._probeData = res;
      this.applyProbe(res);
      if (msg) { msg.style.display = 'none'; }
    } catch (err) {
      if (msg) { msg.style.color = 'var(--accent-rose)'; msg.textContent = err.message; }
    } finally {
      this._probing = false;
      btn.disabled = false;
      btn.innerHTML = origHtml;
      if (window.lucide) lucide.createIcons();
    }
  }

  applyProbe(data) {
    document.getElementById('modal-dl-media-options').style.display = 'block';

    // Preview card
    const preview = document.getElementById('modal-dl-preview');
    if (data.thumbnail) {
      document.getElementById('modal-dl-thumb').src = data.thumbnail;
      document.getElementById('modal-dl-thumb').style.display = 'block';
    } else {
      document.getElementById('modal-dl-thumb').style.display = 'none';
    }
    document.getElementById('modal-dl-title').textContent = data.title || 'Media';
    const metaBits = [];
    if (data.uploader) metaBits.push(data.uploader);
    if (data.duration_human) metaBits.push(data.duration_human);
    if (data.extractor) metaBits.push(data.extractor);
    document.getElementById('modal-dl-meta').textContent = metaBits.join(' · ');
    preview.style.display = 'flex';

    // Populate real video qualities (each carries its exact stream id so the
    // download grabs precisely what's listed here).
    const qSel = document.getElementById('modal-dl-quality');
    if (data.video_options && data.video_options.length) {
      qSel.innerHTML = '<option value="best" data-format-id="">Best available</option>' +
        data.video_options.map(o =>
          `<option value="${o.height}" data-format-id="${o.format_id || ''}" data-progressive="${o.progressive ? 1 : 0}">${o.display}</option>`
        ).join('');
    }

    // Populate audio bitrate options from what actually exists
    const bSel = document.getElementById('modal-dl-audio-bitrate');
    if (data.audio_options && data.audio_options.length) {
      const seen = new Set();
      const opts = [];
      data.audio_options.forEach(o => {
        // Snap real abr to the nearest common preset label but keep the real number
        const val = String(o.abr);
        if (!seen.has(val)) { seen.add(val); opts.push(`<option value="${val}">${o.display}</option>`); }
      });
      if (opts.length) bSel.innerHTML = opts.join('');
    }

    this.updateFfmpegWarning(data);
  }

  updateFfmpegWarning(data) {
    data = data || this._probeData;
    const warn = document.getElementById('modal-dl-ffmpeg-warn');
    if (!warn) return;
    const hasFfmpeg = data ? data.ffmpeg !== false : true;
    const mode = document.querySelector('.dl-mode-btn.active')?.dataset.mode || 'video';
    const height = document.getElementById('modal-dl-quality').value;

    if (!hasFfmpeg && mode === 'audio') {
      warn.style.display = 'block';
      warn.textContent = 'ffmpeg not found — MP3/FLAC/WAV conversion is unavailable. Pick M4A to grab the original audio, or install ffmpeg.';
    } else if (!hasFfmpeg && (height === 'best' || parseInt(height, 10) > 720)) {
      warn.style.display = 'block';
      warn.textContent = 'ffmpeg not found — 1080p+ needs muxing and will fall back to ≤720p. Install ffmpeg for full quality.';
    } else {
      warn.style.display = 'none';
    }
  }

  async refreshYtdlpStrip() {
    const strip = document.getElementById('modal-dl-ytdlp-strip');
    const status = document.getElementById('modal-dl-ytdlp-status');
    const updateBtn = document.getElementById('modal-dl-ytdlp-update');
    if (!strip) return;
    strip.style.display = 'flex';
    if (status) status.textContent = 'Checking yt-dlp…';
    if (updateBtn) updateBtn.style.display = 'none';

    try {
      const info = await api.getYtdlpVersion();
      if (!info.installed) {
        if (status) { status.innerHTML = '<span style="color: var(--accent-rose);">yt-dlp not installed</span>'; }
        if (updateBtn) { updateBtn.style.display = 'inline-flex'; updateBtn.innerHTML = '<i data-lucide="download"></i> Install yt-dlp'; }
      } else {
        const cookieTxt = info.cookies && info.cookies.available
          ? ` · cookies: ${info.cookies.browser}` : ' · no signed-in cookies found';
        const ffTxt = info.ffmpeg ? '' : ' · no ffmpeg';
        if (status) {
          status.innerHTML = `yt-dlp ${info.version || '?'}${info.stale ? ' <span style="color: var(--accent-amber);">(outdated)</span>' : ''}<span style="opacity:0.7;">${cookieTxt}${ffTxt}</span>`;
        }
        if (updateBtn) updateBtn.style.display = info.stale ? 'inline-flex' : 'inline-flex';
      }
    } catch (_) {
      if (status) status.textContent = 'Could not check yt-dlp version.';
    }
    if (window.lucide) lucide.createIcons();
  }

  async handleYtdlpUpdate() {
    const btn = document.getElementById('modal-dl-ytdlp-update');
    const status = document.getElementById('modal-dl-ytdlp-status');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader"></i> Updating…';
    if (window.lucide) lucide.createIcons();
    if (status) status.textContent = 'Running pip install -U yt-dlp… this can take a minute.';

    try {
      const res = await api.updateYtdlp();
      if (status) {
        status.style.color = res.success ? 'var(--accent-emerald)' : 'var(--accent-rose)';
        status.textContent = res.message;
      }
    } catch (err) {
      if (status) { status.style.color = 'var(--accent-rose)'; status.textContent = err.message; }
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
      if (window.lucide) lucide.createIcons();
    }
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

          ${isError && t.error_message ? `
            <div style="margin-top: 8px; font-size: 0.75rem; color: var(--accent-rose); background: rgba(244,63,94,0.08); border: 1px solid rgba(244,63,94,0.2); border-radius: 8px; padding: 8px 10px; display: flex; gap: 8px; align-items: flex-start;">
              <i data-lucide="alert-triangle" style="width: 14px; height: 14px; flex-shrink: 0; margin-top: 1px;"></i>
              <span>${t.error_message}</span>
            </div>
          ` : ''}

          <div class="dl-task-info">
            <div>
              <span>${t.downloaded_human} / ${t.total_human} (${t.progress_percent}%)</span>
              ${t.is_magnet ? `<span style="margin-left: 12px; color: var(--accent-violet);">Peers: ${t.peers} | Seeds: ${t.seeds}</span>` : ''}
              ${t.backend ? `<span class="nav-badge" style="margin-left: 8px; font-size: 0.65rem;">${t.backend}</span>` : ''}
              ${t.quality_label ? `<span class="nav-badge" style="margin-left: 6px; font-size: 0.65rem; background: rgba(139,92,246,0.15); color: var(--accent-violet);">${t.quality_label}</span>` : ''}
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
