// src/session.js
// ─────────────────────────────────────────────────────────
// Session persistence: save, resume, list, export
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const BASE_DIR = path.join(require('os').homedir(), '.agent-ceo');
const SESSIONS_DIR = path.join(BASE_DIR, 'sessions');

class SessionManager {
  constructor() {
    this.name = null;
    this.startedAt = new Date().toISOString();
    this.chatLog = [];    // { from, text, timestamp, tags[] }
    this.tags = [];        // { tag, text, timestamp, index }
    this.filesReferenced = new Set();
    this.ensureDirs();
  }

  ensureDirs() {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  setName(name) {
    this.name = name.replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  // ── Chat logging ───────────────────────────────────────

  logMessage(from, text, tags = []) {
    const entry = {
      from,
      text,
      timestamp: new Date().toISOString(),
      tags,
    };
    this.chatLog.push(entry);

    // Extract tags from text
    const tagMatches = text.match(/#(\w+)/g);
    if (tagMatches) {
      for (const tag of tagMatches) {
        this.tags.push({
          tag: tag.slice(1),
          text,
          timestamp: entry.timestamp,
          index: this.chatLog.length - 1,
        });
      }
    }

    return entry;
  }

  addFileReference(filePath) {
    this.filesReferenced.add(filePath);
  }

  // ── Tag search ─────────────────────────────────────────

  searchTags(filter = null) {
    if (!filter) return this.tags;
    const lower = filter.toLowerCase();
    return this.tags.filter(t => t.tag.toLowerCase().includes(lower));
  }

  // ── Save ───────────────────────────────────────────────

  save(agentManager, inboxManager, privacy = null, autoRunner = null) {
    const sessionName = this.name || `session-${Date.now()}`;
    const dir = path.join(SESSIONS_DIR, sessionName);
    fs.mkdirSync(dir, { recursive: true });

    // Chatroom log as markdown
    const chatMd = this._formatChatLog();
    fs.writeFileSync(path.join(dir, 'chatroom.md'), chatMd);

    // Summary
    const summary = this._generateSummary();
    fs.writeFileSync(path.join(dir, 'summary.md'), summary);

    // Tags
    const tagsMd = this._formatTags();
    fs.writeFileSync(path.join(dir, 'tags.md'), tagsMd);

    // Files referenced
    const filesMd = [...this.filesReferenced].map(f => `- ${f}`).join('\n');
    fs.writeFileSync(path.join(dir, 'files-referenced.md'),
      `# Files Referenced\n\n${filesMd || 'None'}\n`);

    // State for resume — full restorable state
    const agentsSerialized = agentManager.serialize();
    // Strip native sessionIds from portable save (they go in native.json via --native)
    if (agentsSerialized.agents) {
      for (const [name, agent] of Object.entries(agentsSerialized.agents)) {
        delete agent.sessionId;
        delete agent._codexHome;
      }
    }

    const state = {
      name: sessionName,
      startedAt: this.startedAt,
      savedAt: new Date().toISOString(),
      agents: agentsSerialized,
      inboxes: inboxManager.serialize(),
      messageCount: this.chatLog.length,
      chatLog: this.chatLog,
      tags: this.tags,
      filesReferenced: [...this.filesReferenced],
      // paneOffsets: kept for debugging/telemetry only — not restored on
      // resume because fresh panes truncate logs to size 0 (see index.js).
      paneOffsets: {},
      privacy: privacy ? privacy.serialize() : null,
    };

    for (const [name] of agentManager.agents) {
      state.paneOffsets[name] = agentManager.paneManager
        ? agentManager.paneManager.getByteOffset(name)
        : 0;
    }

    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));

    // Save auto job outputs
    if (autoRunner && autoRunner.jobs && autoRunner.jobs.length > 0) {
      const autoDir = path.join(dir, 'auto');
      fs.mkdirSync(autoDir, { recursive: true });

      for (const job of autoRunner.jobs) {
        const lines = [
          `# Auto Job ${job.id}: ${job.goal}`,
          `Pipeline: ${job.pipeline.join(' → ')}`,
          `State: ${job.state} | Rounds: ${job.round}/${job.maxRounds}`,
          `Participants: ${job.participants.join(', ')}`,
          '', '---', '',
        ];

        for (const r of job.responses) {
          lines.push(`## Round ${r.round} — ${r.step} (${r.agent})`);
          lines.push(r.text);
          lines.push('');
        }

        fs.writeFileSync(path.join(autoDir, `${job.id}.md`), lines.join('\n'));
      }
    }

    return dir;
  }

  // Auto-save state (called periodically)
  autoSave(agentManager, inboxManager) {
    try {
      const sessionName = this.name || 'autosave';
      const dir = path.join(SESSIONS_DIR, sessionName);
      fs.mkdirSync(dir, { recursive: true });

      const state = {
        name: sessionName,
        startedAt: this.startedAt,
        savedAt: new Date().toISOString(),
        agents: agentManager.serialize(),
        inboxes: inboxManager.serialize(),
        messageCount: this.chatLog.length,
      };
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    } catch { /* silent fail for autosave */ }
  }

  // ── List sessions ──────────────────────────────────────

  static listSessions() {
    try {
      const dirs = fs.readdirSync(SESSIONS_DIR);
      const sessions = [];
      for (const dir of dirs) {
        const statePath = path.join(SESSIONS_DIR, dir, 'state.json');
        if (fs.existsSync(statePath)) {
          try {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            sessions.push({
              name: dir,
              startedAt: state.startedAt,
              savedAt: state.savedAt,
              messageCount: state.messageCount,
            });
          } catch { /* skip corrupt */ }
        }
      }
      return sessions.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    } catch {
      return [];
    }
  }

  // ── Resume ─────────────────────────────────────────────

  static loadState(sessionName) {
    const statePath = path.join(SESSIONS_DIR, sessionName, 'state.json');
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  }

  saveNativeIds(dir, agentManager) {
    const native = {};
    for (const [name, agent] of agentManager.agents) {
      if (agent.sessionId) {
        native[name] = {
          provider: agent.provider,
          sessionId: agent.sessionId,
          codexHome: agent._codexHome || null,
        };
      }
    }
    if (Object.keys(native).length > 0) {
      fs.writeFileSync(path.join(dir, 'native.json'), JSON.stringify(native, null, 2));
    }

    // Copy Codex CODEX_HOME contents (sessions + sqlite) for resume
    for (const [name, agent] of agentManager.agents) {
      if (agent._codexHome && fs.existsSync(agent._codexHome)) {
        const codexSaveDir = path.join(dir, 'codex', name);
        this._copyDirExcept(agent._codexHome, codexSaveDir, ['auth.json', 'config.toml']);
      }
    }
  }

  _copyDirExcept(src, dst, excludeNames) {
    fs.mkdirSync(dst, { recursive: true });
    try {
      const entries = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        if (excludeNames.includes(entry.name)) continue;
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
          this._copyDirExcept(srcPath, dstPath, excludeNames);
        } else if (entry.isSymbolicLink()) {
          // Skip symlinks (auth.json, config.toml)
        } else {
          fs.copyFileSync(srcPath, dstPath);
        }
      }
    } catch { /* ignore copy errors */ }
  }

  static loadNativeIds(sessionName) {
    const nativePath = path.join(SESSIONS_DIR, sessionName, 'native.json');
    if (!fs.existsSync(nativePath)) return null;
    try { return JSON.parse(fs.readFileSync(nativePath, 'utf-8')); }
    catch { return null; }
  }

  static loadSummary(sessionName) {
    const summaryPath = path.join(SESSIONS_DIR, sessionName, 'summary.md');
    if (!fs.existsSync(summaryPath)) return null;
    return fs.readFileSync(summaryPath, 'utf-8');
  }

  // Restore session state from a saved state object
  restoreState(savedState) {
    if (savedState.chatLog) this.chatLog = savedState.chatLog;
    if (savedState.tags) this.tags = savedState.tags;
    if (savedState.filesReferenced) {
      this.filesReferenced = new Set(savedState.filesReferenced);
    }
    if (savedState.startedAt) this.startedAt = savedState.startedAt;
  }

  // ── Formatting ─────────────────────────────────────────

  _formatChatLog() {
    const lines = [`# agent-ceo Session: ${this.name || 'unnamed'}`,
      `Started: ${this.startedAt}`, '', '---', ''];
    for (const entry of this.chatLog) {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const tags = entry.tags.length ? ` ${entry.tags.map(t => `#${t}`).join(' ')}` : '';
      lines.push(`**[${entry.from.toUpperCase()} ${time}]**${tags}`);
      lines.push(entry.text);
      lines.push('');
    }
    return lines.join('\n');
  }

  _formatTags() {
    if (this.tags.length === 0) return '# Tags\n\nNo tags in this session.\n';
    const lines = ['# Tags', ''];
    const grouped = {};
    for (const t of this.tags) {
      if (!grouped[t.tag]) grouped[t.tag] = [];
      grouped[t.tag].push(t);
    }
    for (const [tag, entries] of Object.entries(grouped)) {
      lines.push(`## #${tag}`);
      for (const e of entries) {
        const time = new Date(e.timestamp).toLocaleTimeString();
        lines.push(`- [${time}] ${e.text.substring(0, 100)}...`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  _generateSummary() {
    const agentNames = new Set();
    let decisions = 0;
    let todos = 0;

    for (const entry of this.chatLog) {
      if (entry.from !== 'ceo') agentNames.add(entry.from);
    }
    for (const t of this.tags) {
      if (t.tag === 'decision') decisions++;
      if (t.tag === 'todo') todos++;
    }

    return [
      `# Session Summary: ${this.name || 'unnamed'}`,
      '',
      `- **Started:** ${this.startedAt}`,
      `- **Messages:** ${this.chatLog.length}`,
      `- **Agents used:** ${[...agentNames].join(', ') || 'none'}`,
      `- **Decisions tagged:** ${decisions}`,
      `- **TODOs tagged:** ${todos}`,
      `- **Files referenced:** ${this.filesReferenced.size}`,
      '',
      '## Conversation Flow',
      '',
      ...this.chatLog.slice(0, 20).map(e => {
        const preview = e.text.substring(0, 80).replace(/\n/g, ' ');
        return `- **${e.from}**: ${preview}...`;
      }),
      this.chatLog.length > 20 ? `\n... and ${this.chatLog.length - 20} more messages` : '',
    ].join('\n');
  }
}

module.exports = SessionManager;
