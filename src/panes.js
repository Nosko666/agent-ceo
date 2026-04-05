// src/panes.js
// ─────────────────────────────────────────────────────────
// Manages tmux session, panes, and message piping
// ─────────────────────────────────────────────────────────
const { execSync, execFileSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const SESSION_NAME = 'ceo';

class PaneManager {
  constructor(logDir) {
    this.logDir = logDir || '/tmp/agent-ceo';
    this.panes = new Map(); // agentName → { paneId, logFile, provider }
    this.ensureLogDir();
  }

  ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  // ── Session lifecycle ──────────────────────────────────

  sessionExists() {
    try {
      execSync(`tmux has-session -t ${SESSION_NAME} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  createSession() {
    if (this.sessionExists()) {
      const name = this._findAvailableSessionName();
      execSync(`tmux new-session -d -s ${name} -x 200 -y 50`);
      this.sessionName = name;
    } else {
      execSync(`tmux new-session -d -s ${SESSION_NAME} -x 200 -y 50`);
      this.sessionName = SESSION_NAME;
    }
    // Enable mouse mode
    execSync(`tmux set-option -t ${this.sessionName} -g mouse on 2>/dev/null || true`);
    return this.sessionName;
  }

  _findAvailableSessionName() {
    let i = 2;
    while (true) {
      const name = `${SESSION_NAME}-${i}`;
      try {
        execSync(`tmux has-session -t ${name} 2>/dev/null`);
        i++;
      } catch {
        return name;
      }
    }
  }

  destroySession() {
    try {
      execSync(`tmux kill-session -t ${this.sessionName} 2>/dev/null`);
    } catch { /* ignore */ }
  }

  attach() {
    // This replaces the current process
    const { spawnSync } = require('child_process');
    spawnSync('tmux', ['attach-session', '-t', this.sessionName], {
      stdio: 'inherit',
    });
  }

  // ── Pane management ────────────────────────────────────

  getMainPaneId() {
    try {
      const out = execSync(
        `tmux list-panes -t ${this.sessionName} -F "#{pane_id}" | head -1`
      ).toString().trim();
      return out;
    } catch {
      return null;
    }
  }

  createAgentPane(agentName, provider, direction = 'right', percent = 25) {
    const logFile = path.join(this.logDir, `${agentName}.log`);

    // Clear old log
    fs.writeFileSync(logFile, '');

    // Create pane with default shell (NOT sleep infinity — that blocks input)
    const paneId = execSync(
      `tmux split-window -t ${this.sessionName} -${direction === 'right' ? 'h' : 'v'} -p ${percent} -P -F "#{pane_id}"`
    ).toString().trim();

    // Set pane title
    try {
      execSync(`tmux select-pane -t ${paneId} -T "${agentName}"`);
    } catch { /* older tmux may not support titles */ }

    // Start logging BEFORE starting the CLI to capture all output
    execSync(`tmux pipe-pane -t ${paneId} "cat >> ${logFile}"`);

    // Start the agent CLI via literal send-keys (shell is ready for input)
    const cmd = `${provider.command} ${provider.startArgs.join(' ')}`.trim();
    execFileSync('tmux', ['send-keys', '-t', paneId, '-l', cmd]);
    execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter']);

    this.panes.set(agentName, {
      paneId,
      logFile,
      provider,
      byteOffset: 0,
      status: 'starting',
    });

    return { paneId, logFile };
  }

  removePane(agentName) {
    const pane = this.panes.get(agentName);
    if (!pane) return;
    try {
      execSync(`tmux kill-pane -t ${pane.paneId} 2>/dev/null`);
    } catch { /* ignore */ }
    this.panes.delete(agentName);
  }

  // ── Message piping ─────────────────────────────────────

  sendToPane(agentName, text) {
    const pane = this.panes.get(agentName);
    if (!pane) return false;

    // Split text into lines and send each via literal send-keys
    // Using -l flag + execFileSync avoids all shell interpolation risks
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.length > 0) {
        execFileSync('tmux', ['send-keys', '-t', pane.paneId, '-l', line]);
      }
      execFileSync('tmux', ['send-keys', '-t', pane.paneId, 'Enter']);
    }
    return true;
  }

  // ── Output capture ─────────────────────────────────────

  readNewOutput(agentName) {
    const pane = this.panes.get(agentName);
    if (!pane) return null;

    try {
      const stats = fs.statSync(pane.logFile);
      if (stats.size <= pane.byteOffset) return null;

      const length = stats.size - pane.byteOffset;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(pane.logFile, 'r');
      fs.readSync(fd, buffer, 0, length, pane.byteOffset);
      fs.closeSync(fd);

      pane.byteOffset = stats.size;
      return this.stripAnsi(buffer.toString('utf-8'));
    } catch {
      return null;
    }
  }

  peekNewOutput(agentName) {
    // Like readNewOutput but doesn't advance the offset
    const pane = this.panes.get(agentName);
    if (!pane) return null;

    try {
      const stats = fs.statSync(pane.logFile);
      if (stats.size <= pane.byteOffset) return null;

      const length = stats.size - pane.byteOffset;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(pane.logFile, 'r');
      fs.readSync(fd, buffer, 0, length, pane.byteOffset);
      fs.closeSync(fd);

      return this.stripAnsi(buffer.toString('utf-8'));
    } catch {
      return null;
    }
  }

  getByteOffset(agentName) {
    const pane = this.panes.get(agentName);
    return pane ? pane.byteOffset : 0;
  }

  setByteOffset(agentName, offset) {
    const pane = this.panes.get(agentName);
    if (pane) pane.byteOffset = offset;
  }

  // ── Health checks ──────────────────────────────────────

  isPaneDead(agentName) {
    const pane = this.panes.get(agentName);
    if (!pane) return true;
    try {
      const result = execSync(
        `tmux list-panes -t ${this.sessionName} -F "#{pane_id} #{pane_dead}" 2>/dev/null`
      ).toString();
      const lines = result.trim().split('\n');
      for (const line of lines) {
        const [id, dead] = line.trim().split(' ');
        if (id === pane.paneId) return dead === '1';
      }
      return true; // pane not found = dead
    } catch {
      return true;
    }
  }

  reviveAgent(agentName) {
    const pane = this.panes.get(agentName);
    if (!pane) return false;

    try {
      // Truncate log file so capture starts clean (no rereading old output)
      fs.writeFileSync(pane.logFile, '');
      pane.byteOffset = 0;

      // Respawn the pane with a shell, then start the CLI via send-keys
      execFileSync('tmux', ['respawn-pane', '-t', pane.paneId]);
      // Re-enable logging on the fresh file
      execSync(`tmux pipe-pane -t ${pane.paneId} "cat >> ${pane.logFile}"`);
      // Start the CLI
      const cmd = `${pane.provider.command} ${pane.provider.startArgs.join(' ')}`.trim();
      execFileSync('tmux', ['send-keys', '-t', pane.paneId, '-l', cmd]);
      execFileSync('tmux', ['send-keys', '-t', pane.paneId, 'Enter']);
      pane.status = 'starting';
      return true;
    } catch {
      return false;
    }
  }

  // ── Layout ─────────────────────────────────────────────

  arrangeLayout() {
    try {
      execSync(`tmux select-layout -t ${this.sessionName} tiled 2>/dev/null`);
    } catch { /* ignore */ }
  }

  focusPane(agentName) {
    const pane = this.panes.get(agentName);
    if (!pane) return;
    try {
      execSync(`tmux select-pane -t ${pane.paneId} 2>/dev/null`);
    } catch { /* ignore */ }
  }

  focusChatroom() {
    const mainPane = this.getMainPaneId();
    if (mainPane) {
      try {
        execSync(`tmux select-pane -t ${mainPane} 2>/dev/null`);
      } catch { /* ignore */ }
    }
  }

  // ── Restore from external setup ───────────────────

  restoreFromSetup(setupState) {
    this.sessionName = setupState.sessionName;
    for (const [name, info] of Object.entries(setupState.agents)) {
      const provider = require(`./providers/${info.provider}`);
      this.panes.set(name, {
        paneId: info.paneId,
        logFile: info.logFile,
        provider,
        byteOffset: 0,
        status: 'starting',
      });
    }
  }

  // ── Utils ──────────────────────────────────────────────

  stripAnsi(text) {
    return text
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')    // standard ANSI
      .replace(/\x1b\][^\x07]*\x07/g, '')         // OSC sequences
      .replace(/\x1b\[[0-9;]*[HJK]/g, '')         // cursor movement
      .replace(/\r/g, '');                          // carriage returns
  }

  getStatus() {
    const result = {};
    for (const [name, pane] of this.panes) {
      result[name] = {
        paneId: pane.paneId,
        status: pane.status,
        dead: this.isPaneDead(name),
        byteOffset: pane.byteOffset,
      };
    }
    return result;
  }
}

module.exports = PaneManager;
