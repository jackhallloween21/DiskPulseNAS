/**
 * DiskPulse API & WebSocket Client Service
 */
class DiskPulseAPI {
  constructor() {
    this.baseUrl = window.location.origin;
    this.wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.wsHost = window.location.host;
    
    this.telemetryWs = null;
    this.terminalWs = null;
    this.listeners = {};
  }

  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => {
        try { cb(data); } catch(e) { console.error(e); }
      });
    }
  }

  // HTTP Helper
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    try {
      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        ...options
      });
      if (!response.ok) {
        let errMessage = `HTTP error ${response.status}`;
        try {
          const errData = await response.json();
          if (errData.detail) errMessage = errData.detail;
        } catch (_) {}
        throw new Error(errMessage);
      }
      return await response.json();
    } catch (err) {
      console.error(`API Error on ${endpoint}:`, err);
      throw err;
    }
  }

  // Telemetry WebSocket
  initTelemetryWebSocket() {
    const wsUrl = `${this.wsProtocol}//${this.wsHost}/ws/telemetry`;
    const connect = () => {
      this.telemetryWs = new WebSocket(wsUrl);
      this.telemetryWs.onopen = () => {
        this.emit('telemetry:status', { connected: true });
      };
      this.telemetryWs.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.emit('telemetry:data', data);
        } catch (e) {
          console.error("Telemetry JSON parse error:", e);
        }
      };
      this.telemetryWs.onclose = () => {
        this.emit('telemetry:status', { connected: false });
        setTimeout(connect, 3000); // Auto reconnect
      };
      this.telemetryWs.onerror = () => {
        this.telemetryWs.close();
      };
    };
    connect();
  }

  // File Manager Endpoints
  async listFiles(path = "") {
    return this.request(`/api/files/list?path=${encodeURIComponent(path)}`);
  }

  async searchFiles(query = "", path = "") {
    return this.request(`/api/files/search?query=${encodeURIComponent(query)}&path=${encodeURIComponent(path)}`);
  }

  async createDirectory(parentPath, folderName) {
    return this.request('/api/files/mkdir', {
      method: 'POST',
      body: JSON.stringify({ parent_path: parentPath, folder_name: folderName })
    });
  }

  async createFile(parentPath, fileName, content = "") {
    return this.request('/api/files/create', {
      method: 'POST',
      body: JSON.stringify({ parent_path: parentPath, file_name: fileName, content: content })
    });
  }

  async readFile(path) {
    return this.request(`/api/files/read?path=${encodeURIComponent(path)}`);
  }

  async writeFile(path, content) {
    return this.request('/api/files/write', {
      method: 'POST',
      body: JSON.stringify({ path: path, content: content })
    });
  }

  async renameFile(path, newName) {
    return this.request('/api/files/rename', {
      method: 'POST',
      body: JSON.stringify({ path: path, new_name: newName })
    });
  }

  async moveFiles(sourcePaths, targetFolder) {
    return this.request('/api/files/move', {
      method: 'POST',
      body: JSON.stringify({ source_paths: sourcePaths, target_folder: targetFolder })
    });
  }

  async copyFiles(sourcePaths, targetFolder) {
    return this.request('/api/files/copy', {
      method: 'POST',
      body: JSON.stringify({ source_paths: sourcePaths, target_folder: targetFolder })
    });
  }

  async deleteFiles(paths) {
    return this.request('/api/files/delete', {
      method: 'POST',
      body: JSON.stringify({ paths: paths })
    });
  }

  getDownloadZipUrl(paths) {
    return `${this.baseUrl}/api/files/zip`;
  }

  getRawFileUrl(path) {
    return `${this.baseUrl}/api/files/raw?path=${encodeURIComponent(path)}`;
  }

  // Download Manager Endpoints
  async getDownloads() {
    return this.request('/api/downloads');
  }

  async addDownload(url, category = null, customFolder = "", customFilename = null) {
    return this.request('/api/downloads/add', {
      method: 'POST',
      body: JSON.stringify({
        url,
        category,
        custom_folder: customFolder,
        custom_filename: customFilename
      })
    });
  }

  async pauseDownload(taskId) {
    return this.request(`/api/downloads/pause/${taskId}`, { method: 'POST' });
  }

  async resumeDownload(taskId) {
    return this.request(`/api/downloads/resume/${taskId}`, { method: 'POST' });
  }

  async cancelDownload(taskId) {
    return this.request(`/api/downloads/cancel/${taskId}`, { method: 'POST' });
  }

  async retryDownload(taskId) {
    return this.request(`/api/downloads/retry/${taskId}`, { method: 'POST' });
  }

  async deleteDownload(taskId, deleteFile = false) {
    return this.request(`/api/downloads/${taskId}?delete_file=${deleteFile}`, { method: 'DELETE' });
  }

  // Terminal API
  async execTerminalCommand(command, sessionId = "default") {
    return this.request('/api/terminal/exec', {
      method: 'POST',
      body: JSON.stringify({ command, session_id: sessionId })
    });
  }
}

const api = new DiskPulseAPI();
