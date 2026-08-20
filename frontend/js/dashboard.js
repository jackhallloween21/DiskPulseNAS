/**
 * Dashboard & Telemetry Visualizer
 */
class DashboardVisualizer {
  constructor() {
    this.chartDiskIO = null;
    this.chartCategories = null;
    
    // 30 seconds rolling buffer
    this.ioHistoryMax = 30;
    this.ioLabels = Array(this.ioHistoryMax).fill('');
    this.ioReadData = Array(this.ioHistoryMax).fill(0);
    this.ioWriteData = Array(this.ioHistoryMax).fill(0);
    
    this.initCharts();
    this.bindEvents();
  }

  initCharts() {
    // 1. Rolling Disk I/O Line Chart
    const ctxIO = document.getElementById('chart-disk-io')?.getContext('2d');
    if (ctxIO) {
      this.chartDiskIO = new Chart(ctxIO, {
        type: 'line',
        data: {
          labels: this.ioLabels,
          datasets: [
            {
              label: 'Read MB/s',
              data: this.ioReadData,
              borderColor: '#00f2fe',
              backgroundColor: 'rgba(0, 242, 254, 0.1)',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.35,
              fill: true
            },
            {
              label: 'Write MB/s',
              data: this.ioWriteData,
              borderColor: '#10b981',
              backgroundColor: 'rgba(16, 185, 129, 0.1)',
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.35,
              fill: true
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 0 },
          plugins: {
            legend: {
              labels: { color: '#94a3b8', font: { family: 'Inter', size: 11 } }
            },
            tooltip: {
              mode: 'index',
              intersect: false,
              backgroundColor: '#0f172a',
              titleColor: '#f8fafc',
              bodyColor: '#cbd5e1',
              borderColor: 'rgba(255,255,255,0.1)',
              borderWidth: 1
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(255, 255, 255, 0.04)' },
              ticks: { display: false }
            },
            y: {
              beginAtZero: true,
              grid: { color: 'rgba(255, 255, 255, 0.06)' },
              ticks: { color: '#64748b', font: { size: 10 } }
            }
          }
        }
      });
    }

    // 2. Storage Category Doughnut Chart
    const ctxCat = document.getElementById('chart-storage-categories')?.getContext('2d');
    if (ctxCat) {
      this.chartCategories = new Chart(ctxCat, {
        type: 'doughnut',
        data: {
          labels: ['Media', 'ISOs', 'Documents', 'Software', 'Backups', 'Other'],
          datasets: [{
            data: [35, 25, 15, 12, 8, 5],
            backgroundColor: [
              '#00f2fe',
              '#8b5cf6',
              '#10b981',
              '#f59e0b',
              '#f43f5e',
              '#64748b'
            ],
            borderWidth: 0,
            hoverOffset: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '72%',
          plugins: {
            legend: {
              position: 'right',
              labels: { color: '#94a3b8', font: { family: 'Inter', size: 11 }, boxWidth: 10, padding: 8 }
            }
          }
        }
      });
    }
  }

  bindEvents() {
    api.on('telemetry:status', ({ connected }) => {
      const statusEl = document.getElementById('live-telemetry-status');
      if (statusEl) {
        statusEl.textContent = connected ? 'STREAMING LIVE' : 'DISCONNECTED';
        statusEl.parentElement.style.borderColor = connected ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)';
      }
    });

    api.on('telemetry:data', (data) => this.renderTelemetry(data));
  }

  renderTelemetry(data) {
    if (!data) return;

    // 1. Header & Host Info
    const hostEl = document.getElementById('sidebar-hostname');
    const uptimeEl = document.getElementById('sidebar-uptime');
    if (hostEl && data.system) hostEl.textContent = data.system.hostname;
    if (uptimeEl && data.system) uptimeEl.textContent = `Up: ${data.system.uptime_human}`;

    // 2. Storage Pool Overview
    const pool = data.storage_pool;
    if (pool) {
      document.getElementById('dash-pool-used').textContent = pool.used_human;
      document.getElementById('dash-pool-free').textContent = pool.free_human;
      document.getElementById('dash-pool-total').textContent = pool.total_human;
      document.getElementById('dash-pool-percent').textContent = `${pool.percent}%`;
      document.getElementById('dash-pool-bar').style.width = `${pool.percent}%`;

      document.getElementById('sidebar-pool-text').textContent = `${pool.percent}%`;
      document.getElementById('sidebar-pool-bar').style.width = `${pool.percent}%`;

      // Update Categories Doughnut
      if (this.chartCategories && pool.categories) {
        this.chartCategories.data.labels = pool.categories.map(c => c.name);
        this.chartCategories.data.datasets[0].data = pool.categories.map(c => c.size_bytes);
        this.chartCategories.update();
      }
    }

    // 3. Disk I/O & IOPS
    const diskIo = data.disk_io;
    if (diskIo) {
      const readMb = (diskIo.read_bytes_sec / (1024 * 1024));
      const writeMb = (diskIo.write_bytes_sec / (1024 * 1024));
      
      document.getElementById('dash-disk-iops').textContent = `${diskIo.total_iops} IOPS`;
      document.getElementById('dash-disk-read').textContent = diskIo.read_human_sec;
      document.getElementById('dash-disk-write').textContent = diskIo.write_human_sec;
      document.getElementById('dash-disk-rw').textContent = `${(readMb + writeMb).toFixed(1)} MB/s`;

      // Push into Rolling Chart
      if (this.chartDiskIO) {
        this.ioReadData.shift();
        this.ioReadData.push(readMb);
        this.ioWriteData.shift();
        this.ioWriteData.push(writeMb);
        this.chartDiskIO.update('none');
      }
    }

    // 4. CPU Metrics & Per-Core Visualizer
    const cpu = data.cpu;
    if (cpu) {
      document.getElementById('dash-cpu-percent').textContent = `${cpu.percent_total.toFixed(1)}%`;
      document.getElementById('dash-cpu-cores').textContent = `${cpu.cores_logical} Cores`;
      document.getElementById('dash-cpu-freq').textContent = `${cpu.freq_current_mhz} MHz`;

      const coresContainer = document.getElementById('dash-cpu-cores-list');
      if (coresContainer && cpu.per_core) {
        coresContainer.innerHTML = cpu.per_core.map((pct, idx) => `
          <div class="core-chip">
            <div class="core-name">C${idx}</div>
            <div class="core-pct">${pct.toFixed(0)}%</div>
            <div class="core-bar">
              <div class="core-bar-fill" style="width: ${pct}%;"></div>
            </div>
          </div>
        `).join('');
      }
    }

    // 5. Memory RAM Metrics
    const mem = data.memory;
    if (mem) {
      document.getElementById('dash-ram-used').textContent = mem.used_human;
      document.getElementById('dash-ram-avail').textContent = mem.available_human;
      document.getElementById('dash-ram-total').textContent = mem.total_human;
      document.getElementById('dash-ram-percent').textContent = `${mem.percent.toFixed(1)}%`;
      document.getElementById('dash-ram-bar').style.width = `${mem.percent}%`;
    }

    // 6. S.M.A.R.T. Drive Health & Temperature Cards
    const drivesGrid = document.getElementById('dash-drives-grid');
    if (drivesGrid && data.smart_drives) {
      drivesGrid.innerHTML = data.smart_drives.map(drive => {
        let badgeClass = 'badge-normal';
        if (drive.temp_status === 'Warning') badgeClass = 'badge-warning';
        if (drive.temp_status === 'Critical') badgeClass = 'badge-critical';

        return `
          <div class="drive-card">
            <div class="drive-header">
              <div>
                <div class="drive-name">${drive.name}</div>
                <div style="font-size: 0.75rem; color: var(--text-dim);">S.M.A.R.T. Status: <strong style="color: var(--accent-emerald);">${drive.status}</strong></div>
              </div>
              <span class="drive-badge ${badgeClass}">${drive.temperature_c}°C ${drive.temp_status}</span>
            </div>
            
            <div class="progress-mini" style="height: 4px;">
              <div class="progress-mini-bar" style="width: ${drive.health_percent}%; background: var(--grad-emerald);"></div>
            </div>

            <div class="drive-metrics">
              <div>
                <div class="drive-metric-val" style="color: var(--accent-emerald);">${drive.health_percent}%</div>
                <div class="drive-metric-lbl">Health</div>
              </div>
              <div>
                <div class="drive-metric-val" style="color: var(--accent-cyan);">${drive.temperature_c}°C</div>
                <div class="drive-metric-lbl">Temp</div>
              </div>
              <div>
                <div class="drive-metric-val" style="color: var(--accent-violet);">${(drive.power_on_hours / 24).toFixed(0)}d</div>
                <div class="drive-metric-lbl">Power-On</div>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    // 7. Active Partition Mounts Table
    const tbody = document.getElementById('dash-partitions-tbody');
    if (tbody && data.partitions) {
      tbody.innerHTML = data.partitions.map(p => `
        <tr>
          <td><strong style="color: #fff;"><i data-lucide="hard-drive" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle;"></i> ${p.mountpoint}</strong></td>
          <td><code>${p.device}</code></td>
          <td><span class="nav-badge">${p.fstype}</span></td>
          <td>${p.used_human} / ${p.total_human}</td>
          <td style="min-width: 120px;">
            <div class="progress-mini" style="height: 6px;">
              <div class="progress-mini-bar" style="width: ${p.percent}%; ${p.percent > 90 ? 'background: var(--grad-rose);' : ''}"></div>
            </div>
            <div style="font-size: 0.7rem; color: var(--text-dim); margin-top: 2px;">${p.percent}% used</div>
          </td>
          <td style="color: var(--accent-emerald); font-weight: 600;">${p.free_human}</td>
        </tr>
      `).join('');
      if (window.lucide) lucide.createIcons();
    }
  }
}

const dashboardVisualizer = new DashboardVisualizer();
