/**
 * Web Media Player Hub & Visualizer
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

    this.initVisualizer();
    this.bindEvents();
    this.loadMediaLibrary();
  }

  bindEvents() {
    // Play/Pause button
    document.getElementById('media-btn-play')?.addEventListener('click', () => this.togglePlay());
    document.getElementById('media-btn-prev')?.addEventListener('click', () => this.playPrev());
    document.getElementById('media-btn-next')?.addEventListener('click', () => this.playNext());

    // Scrub Bar
    const seekBar = document.getElementById('media-seek-bar');
    seekBar?.addEventListener('input', (e) => {
      const activeEl = this.getActiveElement();
      if (activeEl && activeEl.duration) {
        activeEl.currentTime = (e.target.value / 100) * activeEl.duration;
      }
    });

    // Volume Bar
    const volBar = document.getElementById('media-volume-bar');
    volBar?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (this.videoEl) this.videoEl.volume = val;
      if (this.audioEl) this.audioEl.volume = val;
    });

    // Speed Selector
    document.getElementById('media-speed-select')?.addEventListener('change', (e) => {
      const rate = parseFloat(e.target.value);
      if (this.videoEl) this.videoEl.playbackRate = rate;
      if (this.audioEl) this.audioEl.playbackRate = rate;
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
    const url = api.getRawFileUrl(item.path);

    if (item.category === 'video') {
      this.playVideo(url, item.name);
    } else {
      this.playAudio(url, item.name);
    }
    this.renderPlaylist();
  }

  playVideo(url, title) {
    this.activePlayer = 'video';
    this.audioEl.pause();
    this.audioContainer.style.display = 'none';
    this.videoContainer.style.display = 'flex';

    this.videoEl.src = url;
    this.videoEl.play();
    this.isPlaying = true;
    this.updatePlayButton();
  }

  playAudio(url, title) {
    this.activePlayer = 'audio';
    this.videoEl.pause();
    this.videoContainer.style.display = 'none';
    this.audioContainer.style.display = 'flex';

    document.getElementById('audio-current-title').textContent = title || 'Streaming Audio';
    this.audioEl.src = url;
    this.audioEl.play();
    this.isPlaying = true;
    this.updatePlayButton();
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

    const cur = el.currentTime || 0;
    const dur = el.duration || 0;

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
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
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
