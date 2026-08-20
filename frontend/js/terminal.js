/**
 * Embedded Web Terminal Shell Widget
 */
class TerminalWidget {
  constructor() {
    this.outputEl = document.getElementById('term-output');
    this.inputEl = document.getElementById('term-input');
    this.promptEl = document.getElementById('term-prompt');
    
    this.history = [];
    this.historyIndex = -1;
    this.ws = null;
    this.currentCwd = "~";

    this.initWebSocket();
    this.bindEvents();
  }

  initWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws/terminal`;

    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.onmessage = (event) => {
        try {
          const res = JSON.parse(event.data);
          this.handleResponse(res);
        } catch (_) {}
      };
      this.ws.onclose = () => {
        this.appendOutput("\n[Terminal session disconnected. Reconnecting...]\n");
        setTimeout(() => this.initWebSocket(), 3000);
      };
    } catch (_) {}
  }

  bindEvents() {
    if (!this.inputEl) return;

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const cmd = this.inputEl.value;
        this.inputEl.value = '';
        this.history.push(cmd);
        this.historyIndex = this.history.length;
        this.executeCommand(cmd);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.historyIndex > 0) {
          this.historyIndex--;
          this.inputEl.value = this.history[this.historyIndex] || '';
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          this.inputEl.value = this.history[this.historyIndex] || '';
        } else {
          this.historyIndex = this.history.length;
          this.inputEl.value = '';
        }
      } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        this.clear();
      }
    });

    // Auto-focus terminal on click anywhere inside window
    document.querySelector('.terminal-window')?.addEventListener('click', () => {
      this.inputEl?.focus();
    });
  }

  executeCommand(cmd) {
    const promptText = this.promptEl.textContent;
    this.appendOutput(`${promptText} ${cmd}\n`);

    if (cmd.trim().toLowerCase() === 'clear') {
      this.clear();
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ command: cmd }));
    } else {
      // Fallback REST call
      api.execTerminalCommand(cmd).then(res => this.handleResponse(res));
    }
  }

  sendQuickCommand(cmd) {
    if (this.inputEl) {
      this.inputEl.value = cmd;
      this.executeCommand(cmd);
      this.inputEl.focus();
    }
  }

  handleResponse(res) {
    if (res.output) {
      this.appendOutput(this.ansiToHtml(res.output));
    }
    if (res.cwd) {
      this.currentCwd = res.cwd;
      if (this.promptEl) {
        this.promptEl.textContent = `nasadmin@diskpulse:${res.cwd}$`;
      }
    }
  }

  appendOutput(text) {
    if (!this.outputEl) return;
    this.outputEl.innerHTML += text;
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  clear() {
    if (this.outputEl) {
      this.outputEl.innerHTML = '';
    }
  }

  ansiToHtml(text) {
    // Simple ANSI parser for Linux color codes
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Replace color codes
    html = html
      .replace(/\033\[0m/g, '</span>')
      .replace(/\033\[1m/g, '<span style="font-weight: bold;">')
      .replace(/\033\[31m/g, '<span style="color: #ef4444;">')
      .replace(/\033\[32m/g, '<span style="color: #10b981;">')
      .replace(/\033\[33m/g, '<span style="color: #f59e0b;">')
      .replace(/\033\[34m/g, '<span style="color: #38bdf8;">')
      .replace(/\033\[35m/g, '<span style="color: #8b5cf6;">')
      .replace(/\033\[36m/g, '<span style="color: #00f2fe;">')
      .replace(/\033\[37m/g, '<span style="color: #f8fafc;">')
      .replace(/\033\[2J\033\[H/g, '');

    return html;
  }
}

const terminalWidget = new TerminalWidget();
