/**
 * Web Media Player Hub & Visualizer
 *
 * Video playback is ffprobe/ffmpeg-aware:
 *   - Browser-native files (MP4 H.264/AAC) on their default audio stream play
 *     directly from /api/files/raw (fully seekable, zero CPU).
 *   - Anything else — MKV, exotic codecs, or a *non-default* audio track — is
 *     remuxed/transcoded on the fly via /api/media/stream with the chosen
 *     audio track (video is stream-copied when already H.264, so it's cheap).
 * Subtitles (embedded, extracted to WebVTT, or external sidecars) attach as
 * <track> elements. Playback speed applies to both audio and video.
 */
class WebMediaPlayer {
  constructor() {
    this.videoEl = document.getElementById('media-video-element');
    this.audioEl = document.getElementById('media-audio-element');
    this.videoContainer = document.getElementById('media-video-container');
    this.audioContainer = document.getElementById('media-audio-container');
    this.canvas = document.getElementById('audio-visualizer-canvas');

    this.activePlayer = 'audio'; // 'audio' | 'video'
    this.playlist = [];
    this.currentIndex = -1;
    this.isPlaying = false;

    // Advanced video state
    this.videoRelPath = null;
    this.mediaInfo = null;
    this.isTranscoded = false;
    this.defaultAudioIdx = 0;
    this.currentAudioIdx = 0;
    this.knownDuration = 0;
    this.baseTime = 0;             // content-time where the current source begins
    this.currentSubtitle = null;   // {kind:'embedded'|'external', track?, file?, label}
    this.playbackRate = 1;
    this._pendingPlay = true;
    this._scrubbing = false;       // user is dragging the seek bar

    this.initVisualizer();
    this.bindEvents();
    this.loadMediaLibrary();
  }

  bindEvents() {
    // Play/Pause button
    document.getElementById('media-btn-play')?.addEventListener('click', () => this.togglePlay());
    document.getElementById('media-btn-prev')?.addEventListener('click', () => this.playPrev());
    document.getElementById('media-btn-next')?.addEventListener('click', () => this.playNext());

    // Scrub Bar — preview the time while dragging, commit the seek on release.
    // (A transcoded stream is re-requested on seek, so we don't want to fire on
    // every intermediate 'input' event.)
    const seekBar = document.getElementById('media-seek-bar');
    seekBar?.addEventListener('input', (e) => {
      const dur = this.effectiveDuration();
      if (dur <= 0) return;
      this._scrubbing = true;
      const t = (e.target.value / 100) * dur;
      const curEl = document.getElementById('media-current-time');
      if (curEl) curEl.textContent = this.formatTime(t);
    });
    seekBar?.addEventListener('change', (e) => {
      this._scrubbing = false;
      const dur = this.effectiveDuration();
      if (dur > 0) this.seekTo((e.target.value / 100) * dur);
    });

    // Volume Bar
    const volBar = document.getElementById('media-volume-bar');
    volBar?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (this.videoEl) this.videoEl.volume = val;
      if (this.audioEl) this.audioEl.volume = val;
    });

    // Speed Selector — remembered so it survives a source reload (audio switch)
    document.getElementById('media-speed-select')?.addEventListener('change', (e) => {
      this.playbackRate = parseFloat(e.target.value) || 1;
      this.applyPlaybackRate();
    });

    // Audio-track selector (video only)
    document.getElementById('media-audio-track')?.addEventListener('change', (e) => {
      this.changeAudioTrack(parseInt(e.target.value, 10) || 0);
    });

    // Subtitle selector (video only)
    document.getElementById('media-subtitle-select')?.addEventListener('change', (e) => {
      const opt = e.target.options[e.target.selectedIndex];
      this.changeSubtitle(e.target.value, opt ? opt.textContent : '');
    });

    // Refresh Library
    document.getElementById('media-refresh-btn')?.addEventListener('click', () => this.loadMediaLibrary());

    // Audio & Video Time Updates
    [this.videoEl, this.audioEl].forEach(el => {
      if (!el) return;
      el.addEventListener('timeupdate', () => this.updateTime());
      el.addEventListener('ended', () => this.playNext());
    });
  }

  getActiveElement() {
    return this.activePlayer === 'video' ? this.videoEl : this.audioEl;
  }

  /** Duration to drive the scrub bar: fragmented streams report NaN/Infinity
   *  until fully buffered, so fall back to the ffprobe duration. */
  effectiveDuration() {
    const el = this.getActiveElement();
    const d = el ? el.duration : 0;
    if (d && isFinite(d) && d > 0) return d;
    if (this.activePlayer === 'video' && this.knownDuration > 0) return this.knownDuration;
    return 0;
  }

  applyPlaybackRate() {
    if (this.videoEl) this.videoEl.playbackRate = this.playbackRate;
    if (this.audioEl) this.audioEl.playbackRate = this.playbackRate;
  }

  async loadMediaLibrary() {
    try {
      // Find all audio & video files
      const audioFiles = await api.searchFiles('.wav');
      const mp3Files = await api.searchFiles('.mp3');
      const mkvFiles = await api.searchFiles('.mkv');
      const mp4Files = await api.searchFiles('.mp4');

      const allMedia = [...audioFiles, ...mp3Files, ...mkvFiles, ...mp4Files];
      this.playlist = allMedia;
      this.renderPlaylist();
    } catch (err) {
      console.error(err);
    }
  }

  renderPlaylist() {
    const container = document.getElementById('media-playlist-container');
    if (!container) return;

    if (!this.playlist.length) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-dim); padding: 24px;">No media files found in storage.</p>';
      return;
    }

    container.innerHTML = this.playlist.map((item, idx) => {
      const isCurrent = this.currentIndex === idx;
      const isVid = item.category === 'video';
      return `
        <div class="nav-item ${isCurrent ? 'active' : ''}" style="display: flex; justify-content: space-between; padding: 10px 14px;" onclick="mediaPlayer.playByIndex(${idx})">
          <div style="display: flex; align-items: center; gap: 10px; overflow: hidden;">
            <i data-lucide="${isVid ? 'film' : 'music'}" style="color: ${isVid ? 'var(--accent-rose)' : 'var(--accent-violet)'}; flex-shrink: 0;"></i>
            <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.name}</span>
          </div>
          <span style="font-size: 0.75rem; color: var(--text-dim);">${item.size_human}</span>
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  playByIndex(index) {
    if (index < 0 || index >= this.playlist.length) return;
    this.currentIndex = index;
    const item = this.playlist[index];

    if (item.category === 'video') {
      this.playVideo(api.getRawFileUrl(item.path), item.name, item.path);
    } else {
      this.playAudio(api.getRawFileUrl(item.path), item.name);
    }
    this.renderPlaylist();
  }

  /**
   * Start video playback. `relPath` (storage-relative) unlocks the advanced
   * ffmpeg features; without it we fall back to a plain direct stream.
   */
  async playVideo(url, title, relPath = null) {
    this.activePlayer = 'video';
    this.audioEl.pause();
    this.audioContainer.style.display = 'none';
    this.videoContainer.style.display = 'flex';

    this.videoRelPath = relPath;
    this.videoTitle = title;
    this.mediaInfo = null;
    this.knownDuration = 0;
    this.baseTime = 0;
    this.currentSubtitle = null;
    this._pendingPlay = true;

    const trackRow = document.getElementById('media-track-row');

    // No rel path (legacy caller) → simplest possible playback.
    if (!relPath) {
      if (trackRow) trackRow.style.display = 'none';
      this.updateFfmpegHint(null);
      this.isTranscoded = false;
      this.videoEl.src = url;
      this.applyPlaybackRate();
      this.videoEl.play().catch(() => {});
      this.isPlaying = true;
      this.updatePlayButton();
      return;
    }

    let info = null;
    try {
      info = await api.getMediaInfo(relPath);
    } catch (e) {
      info = null;
    }
    // Guard against a race where the user picked another track meanwhile.
    if (this.videoRelPath !== relPath) return;

    this.mediaInfo = info;
    this.updateFfmpegHint(info);
    if (info && info.ok) {
      this.knownDuration = info.duration || 0;
      const audio = info.audio || [];
      this.defaultAudioIdx = Math.max(0, audio.findIndex(a => a.default));
      if (this.defaultAudioIdx < 0) this.defaultAudioIdx = 0;
      this.currentAudioIdx = this.defaultAudioIdx;

      this.populateAudioTracks(info);
      this.populateSubtitles(info);
      if (trackRow) trackRow.style.display = 'flex';

      // Direct-play only when the container/codecs are browser-native AND we're
      // on the default audio track; otherwise remux/transcode via ffmpeg.
      const useStream = !info.direct_play;
      this.loadVideoSource({ useStream, audioIdx: this.currentAudioIdx, startTime: 0, autoplay: true });
    } else {
      // ffprobe unavailable or failed → best-effort direct playback.
      if (trackRow) trackRow.style.display = 'none';
      this.isTranscoded = false;
      this.videoEl.src = url;
      this.applyPlaybackRate();
      this.videoEl.play().catch(() => {});
      this.isPlaying = true;
      this.updatePlayButton();
    }
  }

  /**
   * (Re)point the <video> at either the raw file or the ffmpeg stream.
   *
   * `startTime` is the *content-time* where playback should begin:
   *   - streamed: ffmpeg `-ss` positions the segment, so the element timeline
   *     is 0-based and `baseTime` records the offset (subtitles are shifted to
   *     match); this keeps arbitrary seeks on transcoded media snappy.
   *   - raw/direct: the file always starts at 0, so we restore the position by
   *     setting `currentTime` once metadata is ready.
   */
  loadVideoSource({ useStream, audioIdx = 0, startTime = 0, autoplay = true } = {}) {
    const vcodec = (this.mediaInfo && this.mediaInfo.video && this.mediaInfo.video.codec) || '';
    this.isTranscoded = !!useStream;
    const start = startTime > 0 ? startTime : 0;

    let src, restoreTo;
    if (useStream) {
      this.baseTime = start;
      restoreTo = 0;  // -ss already positioned the segment
      src = api.getMediaStreamUrl(this.videoRelPath, audioIdx, start, vcodec);
    } else {
      this.baseTime = 0;
      restoreTo = start;
      src = api.getRawFileUrl(this.videoRelPath);
    }

    const shouldPlay = autoplay && this._pendingPlay !== false;

    const onMeta = () => {
      this.videoEl.removeEventListener('loadedmetadata', onMeta);
      this.applyPlaybackRate();
      this.applySubtitle();
      if (restoreTo > 0) {
        try { this.videoEl.currentTime = restoreTo; } catch (_) {}
      }
      if (shouldPlay) this.videoEl.play().catch(() => {});
      this.updatePlayButton();
    };
    this.videoEl.addEventListener('loadedmetadata', onMeta);

    this._pendingPlay = true;
    this.videoEl.src = src;
    this.videoEl.load();
    this.isPlaying = shouldPlay;
    this.updatePlayButton();
  }

  /**
   * Seek to an absolute content-time. Direct-play files seek natively; a
   * transcoded stream is re-requested from that time (ffmpeg `-ss` + re-encode
   * lands within a frame of the request), so forward seeks don't have to buffer
   * from the start of the film and the clock/subtitles stay aligned.
   */
  seekTo(absTime) {
    const el = this.getActiveElement();
    if (!el) return;
    if (this.activePlayer === 'video' && this.isTranscoded) {
      this._pendingPlay = !el.paused;
      this.loadVideoSource({
        useStream: true,
        audioIdx: this.currentAudioIdx,
        startTime: absTime,
        autoplay: true,
      });
    } else {
      try { el.currentTime = absTime; } catch (_) {}
    }
  }

  populateAudioTracks(info) {
    const sel = document.getElementById('media-audio-track');
    if (!sel) return;
    const audio = info.audio || [];
    sel.innerHTML = (audio.length ? audio : [{ rel_index: 0, label: 'Default' }])
      .map(a => `<option value="${a.rel_index}">${a.label}</option>`).join('');
    sel.value = String(this.currentAudioIdx);
    sel.disabled = audio.length <= 1;
  }

  populateSubtitles(info) {
    const sel = document.getElementById('media-subtitle-select');
    const note = document.getElementById('media-track-note');
    if (!sel) return;
    const opts = ['<option value="off" selected>Off</option>'];
    let bitmapCount = 0;

    (info.subtitles || []).forEach(s => {
      if (s.text_based) {
        opts.push(`<option value="emb:${s.rel_index}">Embedded: ${s.label}</option>`);
      } else {
        bitmapCount++;
        opts.push(`<option value="" disabled>${s.label} (image-based — not selectable)</option>`);
      }
    });
    (info.external_subs || []).forEach(e => {
      opts.push(`<option value="ext:${encodeURIComponent(e.file)}">External: ${e.label}</option>`);
    });

    sel.innerHTML = opts.join('');
    sel.value = 'off';
    if (note) {
      note.textContent = bitmapCount
        ? `${bitmapCount} image-based subtitle track(s) can't be shown as text.`
        : '';
    }
  }

  /**
   * Show a hint when the server lacks ffmpeg/ffprobe, so the missing audio &
   * subtitle controls are explained rather than silently absent. `info` is the
   * /api/media/info payload (or null if the request failed / no rel path).
   */
  updateFfmpegHint(info) {
    const hint = document.getElementById('media-ffmpeg-hint');
    const text = document.getElementById('media-ffmpeg-hint-text');
    if (!hint) return;

    let msg = '';
    if (info && (info.ffprobe === false || info.ffmpeg === false)) {
      // Tools genuinely absent — this is the actionable case.
      msg = 'Install ffmpeg on the server to enable audio-track switching and subtitles.';
    } else if (info && info.ok === false && info.ffprobe !== false) {
      // ffprobe is present but couldn't read this file (corrupt / unsupported).
      msg = "Couldn't read this file's audio/subtitle tracks.";
    }

    if (msg) {
      if (text) text.textContent = msg;
      hint.style.display = 'flex';
      if (window.lucide) lucide.createIcons();
    } else {
      hint.style.display = 'none';
    }
  }

  changeAudioTrack(idx) {
    if (!this.videoRelPath || this.activePlayer !== 'video') return;
    this.currentAudioIdx = idx;

    // Default track on a browser-native file can play raw (frame-accurate seek);
    // any other track requires the ffmpeg stream. Resume where we were — the
    // streamed segment is re-encoded from absPos, so audio/video/subtitles all
    // realign to that instant.
    const canDirect = this.mediaInfo && this.mediaInfo.direct_play && idx === this.defaultAudioIdx;
    const absPos = (this.baseTime || 0) + (this.videoEl.currentTime || 0);
    this._pendingPlay = !this.videoEl.paused;
    this.loadVideoSource({ useStream: !canDirect, audioIdx: idx, startTime: absPos, autoplay: true });
  }

  changeSubtitle(value, label = '') {
    if (!value || value === 'off') {
      this.currentSubtitle = null;
    } else if (value.startsWith('emb:')) {
      this.currentSubtitle = { kind: 'embedded', track: parseInt(value.slice(4), 10) || 0, label };
    } else if (value.startsWith('ext:')) {
      this.currentSubtitle = { kind: 'external', file: decodeURIComponent(value.slice(4)), label };
    }
    this.applySubtitle();
  }

  /** Clear existing <track>s and attach the currently selected subtitle. */
  applySubtitle() {
    if (!this.videoEl) return;
    Array.from(this.videoEl.querySelectorAll('track')).forEach(t => t.remove());
    // Hide any lingering text tracks.
    for (const tt of this.videoEl.textTracks) tt.mode = 'disabled';

    const sel = this.currentSubtitle;
    if (!sel || !this.videoRelPath) return;

    // Match the cue timeline to the current segment: a seeked/transcoded stream
    // starts at baseTime, so cues are shifted back by the same amount.
    const offset = this.isTranscoded ? (this.baseTime || 0) : 0;
    const src = api.getSubtitleUrl(this.videoRelPath, { ...sel, offset });
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = sel.label || 'Subtitles';
    track.srclang = 'und';
    track.default = true;
    track.src = src;
    this.videoEl.appendChild(track);

    const showIt = () => {
      for (const tt of this.videoEl.textTracks) tt.mode = 'showing';
    };
    track.addEventListener('load', showIt);
    // Some browsers don't fire 'load' reliably for <track>; nudge it.
    setTimeout(showIt, 300);
  }

  playAudio(url, title) {
    this.activePlayer = 'audio';
    this.videoEl.pause();
    this.videoContainer.style.display = 'none';
    this.audioContainer.style.display = 'flex';
    this.isTranscoded = false;
    this.baseTime = 0;
    const trackRow = document.getElementById('media-track-row');
    if (trackRow) trackRow.style.display = 'none';
    this.updateFfmpegHint(null);

    document.getElementById('audio-current-title').textContent = title || 'Streaming Audio';
    this.audioEl.src = url;
    this.applyPlaybackRate();
    this.audioEl.play();
    this.isPlaying = true;
    this.updatePlayButton();
  }

  playDirectPath(relPath, category, title) {
    const rawUrl = api.getRawFileUrl(relPath);
    const fname = title || relPath.split('/').pop();
    const isVideo = category === 'video' || /\.(mp4|mkv|webm|avi|mov)$/i.test(relPath);

    if (isVideo) {
      this.playVideo(rawUrl, fname, relPath);
    } else {
      this.playAudio(rawUrl, fname);
    }
  }

  togglePlay() {
    const el = this.getActiveElement();
    if (!el || !el.src) {
      if (this.playlist.length > 0) this.playByIndex(0);
      return;
    }
    if (el.paused) {
      el.play();
      this.isPlaying = true;
    } else {
      el.pause();
      this.isPlaying = false;
    }
    this.updatePlayButton();
  }

  playNext() {
    if (this.playlist.length > 0) {
      const nextIndex = (this.currentIndex + 1) % this.playlist.length;
      this.playByIndex(nextIndex);
    }
  }

  playPrev() {
    if (this.playlist.length > 0) {
      const prevIndex = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length;
      this.playByIndex(prevIndex);
    }
  }

  updatePlayButton() {
    const btn = document.getElementById('media-btn-play');
    if (!btn) return;
    btn.innerHTML = this.isPlaying ? '<i data-lucide="pause"></i>' : '<i data-lucide="play"></i>';
    if (window.lucide) lucide.createIcons();
  }

  updateTime() {
    const el = this.getActiveElement();
    if (!el) return;
    if (this._scrubbing) return;  // don't fight the user's drag

    const base = (this.activePlayer === 'video') ? (this.baseTime || 0) : 0;
    const cur = base + (el.currentTime || 0);
    const dur = this.effectiveDuration();

    const curEl = document.getElementById('media-current-time');
    const durEl = document.getElementById('media-duration');
    const seekBar = document.getElementById('media-seek-bar');

    if (curEl) curEl.textContent = this.formatTime(cur);
    if (durEl) durEl.textContent = this.formatTime(dur);
    if (seekBar && dur > 0) {
      seekBar.value = (cur / dur) * 100;
    }
  }

  formatTime(secs) {
    if (!secs || !isFinite(secs)) secs = 0;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    const mm = (h > 0 && m < 10) ? `0${m}` : `${m}`;
    const ss = s < 10 ? `0${s}` : `${s}`;
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  initVisualizer() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    let phase = 0;

    const draw = () => {
      requestAnimationFrame(draw);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      if (this.activePlayer !== 'audio' || !this.isPlaying) return;

      const width = this.canvas.width = this.canvas.offsetWidth;
      const height = this.canvas.height = this.canvas.offsetHeight;
      const bars = 48;
      const barWidth = width / bars;

      phase += 0.05;
      for (let i = 0; i < bars; i++) {
        const h = Math.abs(Math.sin(phase + i * 0.25)) * (height * 0.6) + 10;
        const x = i * barWidth;
        const y = height - h;

        const grad = ctx.createLinearGradient(0, y, 0, height);
        grad.addColorStop(0, '#8b5cf6');
        grad.addColorStop(0.5, '#00f2fe');
        grad.addColorStop(1, '#10b981');

        ctx.fillStyle = grad;
        ctx.fillRect(x + 2, y, barWidth - 4, h);
      }
    };
    draw();
  }
}

const mediaPlayer = new WebMediaPlayer();
