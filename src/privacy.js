// src/privacy.js
// ─────────────────────────────────────────────────────────
// Manages private pane visibility and sharing to chatroom
// ─────────────────────────────────────────────────────────

class PrivacyManager {
  constructor(agentManager) {
    this.agentManager = agentManager;
    this.transparent = new Set();     // agents whose private panes are visible to all
    this.writeModes = new Set();      // agents with persistent write permission
    this.privateLogs = new Map();     // agentName → [{ from, text, timestamp }]
  }

  // ── Transparency ───────────────────────────────────────

  setTransparent(agentName, value) {
    const resolved = this.agentManager.resolve(agentName);
    if (!resolved) return { error: `Agent not found: ${agentName}` };
    if (value) {
      this.transparent.add(resolved);
    } else {
      this.transparent.delete(resolved);
    }
    return { agent: resolved, transparent: value };
  }

  isTransparent(agentName) {
    return this.transparent.has(agentName);
  }

  // ── Write mode ─────────────────────────────────────────

  setWriteMode(agentName, value) {
    const resolved = this.agentManager.resolve(agentName);
    if (!resolved) return { error: `Agent not found: ${agentName}` };
    if (value) {
      this.writeModes.add(resolved);
    } else {
      this.writeModes.delete(resolved);
    }
    return { agent: resolved, writeMode: value };
  }

  hasWriteMode(agentName) {
    return this.writeModes.has(agentName);
  }

  // ── Private conversation logging ───────────────────────

  logPrivateMessage(agentName, from, text) {
    if (!this.privateLogs.has(agentName)) {
      this.privateLogs.set(agentName, []);
    }
    this.privateLogs.get(agentName).push({
      from,
      text,
      timestamp: new Date().toISOString(),
    });
  }

  getPrivateLog(agentName) {
    return this.privateLogs.get(agentName) || [];
  }

  // Get last N messages from private conversation
  getLastPrivateMessages(agentName, n = 1) {
    const log = this.getPrivateLog(agentName);
    return log.slice(-n);
  }

  // Format messages for sharing to chatroom
  formatForSharing(messages, agentName, mode = 'full') {
    const displayName = this.agentManager.displayName(agentName);
    const header = `[shared from ${displayName}'s private chat]`;

    if (mode === 'conclusion') {
      // Take last agent response only
      const lastResponse = [...messages].reverse().find(m => m.from === agentName);
      if (!lastResponse) return null;
      return `${header}\n${lastResponse.text}`;
    }

    if (mode === 'summary') {
      // This would ideally ask the agent to summarize, but for now just take last 3
      const recent = messages.slice(-3);
      const lines = recent.map(m => `[${m.from}]: ${m.text.substring(0, 200)}`);
      return `${header}\n${lines.join('\n')}`;
    }

    // mode === 'full' or specific messages
    const lines = messages.map(m => {
      const time = new Date(m.timestamp).toLocaleTimeString();
      return `[${m.from} ${time}]: ${m.text}`;
    });
    return `${header}\n${lines.join('\n')}`;
  }

  // ── Conflict detection ─────────────────────────────────

  detectWriteConflict(agentName, filePath, activeWriters) {
    // Check if another agent is also writing to this path
    const conflicts = [];
    for (const [otherAgent, paths] of activeWriters) {
      if (otherAgent !== agentName && paths.has(filePath)) {
        conflicts.push(otherAgent);
      }
    }
    return conflicts;
  }

  // ── Serialization ──────────────────────────────────────

  serialize() {
    const logs = {};
    for (const [name, log] of this.privateLogs) {
      logs[name] = log;
    }
    return {
      transparent: [...this.transparent],
      writeModes: [...this.writeModes],
      privateLogs: logs,
    };
  }

  restore(data) {
    if (data.transparent) {
      for (const name of data.transparent) this.transparent.add(name);
    }
    if (data.writeModes) {
      for (const name of data.writeModes) this.writeModes.add(name);
    }
    if (data.privateLogs) {
      for (const [name, log] of Object.entries(data.privateLogs)) {
        this.privateLogs.set(name, log);
      }
    }
  }
}

module.exports = PrivacyManager;
