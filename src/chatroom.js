// src/chatroom.js
// ─────────────────────────────────────────────────────────
// The chatroom: readline prompt, @-routing, /commands
// This is the CEO's command center.
// ─────────────────────────────────────────────────────────
const readline = require('readline');

const { C, printWelcome, printCeo, printAgent, printSystem, printWarning, printError, printDim, progressBar } = require('./display');
const cmd = require('./commands');

class Chatroom {
  constructor(agentManager, inboxManager, paneManager, capture, session, extras = {}) {
    this.agentManager = agentManager;
    this.inboxManager = inboxManager;
    this.paneManager = paneManager;
    this.capture = capture;
    this.session = session;
    this.workflows = extras.workflows || null;
    this.tagManager = extras.tagManager || null;
    this.tokenTracker = extras.tokenTracker || null;
    this.privacy = extras.privacy || null;
    this.runningDir = extras.runningDir || null;
    this.rl = null;
    this.running = false;
    this._shuttingDown = false;
    this._metaDirty = false;

    // Wrap journal so every append auto-marks meta as dirty
    const rawJournal = extras.journal || null;
    if (rawJournal) {
      const self = this;
      this.journal = new Proxy(rawJournal, {
        get(target, prop) {
          if (prop === 'append') {
            return function (...args) {
              self._metaDirty = true;
              return target.append(...args);
            };
          }
          return target[prop];
        },
      });
    } else {
      this.journal = null;
    }
    this.healthCheckInterval = null;
    this.autoSaveInterval = null;
    this.tokenWarningInterval = null;
  }

  // ── Start the chatroom REPL ────────────────────────────

  start() {
    this.running = true;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${C.bold}${C.cyan}CEO ▸ ${C.reset}`,
    });

    printWelcome(this.agentManager.list());
    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const input = line.trim();
      if (!input) {
        this.rl.prompt();
        return;
      }
      await this.handleInput(input);
      if (this.running) this.rl.prompt();
    });

    this.rl.on('close', () => {
      this.shutdown();
    });

    // Periodic health check every 10s
    this.healthCheckInterval = setInterval(() => {
      const dead = this.agentManager.checkHealth();
      for (const name of dead) {
        printSystem(`⚠️  ${name} disconnected. /revive ${name} to restart.`);
      }
    }, 10000);

    // Auto-save every 30s
    this.autoSaveInterval = setInterval(() => {
      this.session.autoSave(this.agentManager, this.inboxManager);
      if (this.journal && this.journal.needsSnapshot()) {
        this._writeSnapshot();
      }
    }, 30000);

    // Debounced meta.json updates: mark dirty on events, flush at most every 5s
    this._metaDirty = false;
    this.metaUpdateInterval = setInterval(() => {
      if (this._metaDirty && this.runningDir) {
        try {
          const { writeMeta, readMeta } = require('./menu');
          const existing = readMeta(this.runningDir) || {};
          existing.lastActive = new Date().toISOString();
          writeMeta(this.runningDir, existing);
          this._metaDirty = false;
        } catch { /* silent */ }
      }
    }, 5000);

    // Periodic journal snapshot every 60s
    this.snapshotInterval = setInterval(() => {
      if (this.journal && this.journal.eventCount > 0) {
        this._writeSnapshot();
      }
    }, 60000);

    // Token usage warnings every 60s
    this.tokenWarningInterval = setInterval(() => {
      if (this.tokenTracker) {
        const warnings = this.tokenTracker.getWarnings();
        for (const w of warnings) {
          if (w.level === 'critical') printWarning(w.message);
        }
      }
    }, 60000);
  }

  // ── Input handling ─────────────────────────────────────

  async handleInput(input) {
    // /commands
    if (input.startsWith('/')) {
      await this.handleCommand(input);
      return;
    }

    // @ mentions
    const atMatch = input.match(/^@(\S+?)(?::(\w+))?\s*(.*)/s);
    if (atMatch) {
      const [, target, modifier, message] = atMatch;
      await this.handleMention(target, modifier, message || '');
      return;
    }

    // Tag-only messages
    if (input.startsWith('#')) {
      this.session.logMessage('ceo', input);
      this.inboxManager.pushToAll('ceo', input);
      if (this.journal) {
        const seq = this.journal.append({ type: 'msg', from: 'ceo', text: input });
        const recipients = [...this.inboxManager.inboxes.keys()];
        this.journal.append({ type: 'inbox_route', msgSeq: seq, to: recipients });
      }
      printCeo(input);
      return;
    }

    // Plain message — goes to all inboxes, nobody responds
    this.session.logMessage('ceo', input);
    this.inboxManager.pushToAll('ceo', input);
    if (this.journal) {
      const seq = this.journal.append({ type: 'msg', from: 'ceo', text: input });
      const recipients = [...this.inboxManager.inboxes.keys()];
      this.journal.append({ type: 'inbox_route', msgSeq: seq, to: recipients });
    }
    printCeo(input);
    printDim('  (message queued for all agents)');
  }

  // ── @ Mention routing ──────────────────────────────────

  async handleMention(target, modifier, message) {
    const lower = target.toLowerCase();

    // Check for stop modifier
    if (modifier === 'stop') {
      return this.handleStop(lower);
    }

    // Check for DM modifier — private message
    if (modifier === 'dm') {
      return this.handleDM(lower, message);
    }

    // Check for write modifier
    let writeMode = false;
    if (modifier === 'write') {
      writeMode = true;
    }

    // Resolve target — single agent or group
    let agents = [];
    const singleAgent = this.agentManager.resolve(lower);
    if (singleAgent) {
      agents = [singleAgent];
    } else {
      const group = this.agentManager.resolveGroup(lower);
      if (group && group.length > 0) {
        agents = group;
      } else {
        printError(`Unknown agent or group: @${target}`);
        return;
      }
    }

    // Check if any are still running
    const busy = agents.filter(a => this.agentManager.getStatus(a) === 'running');
    if (busy.length > 0) {
      printWarning(`Still responding: ${busy.join(', ')}. Wait or @${busy[0]}:stop first.`);
      return;
    }

    // Check for dead agents
    const dead = agents.filter(a => this.agentManager.getStatus(a) === 'dead');
    if (dead.length > 0) {
      printWarning(`Dead agents: ${dead.join(', ')}. /revive them first.`);
      agents = agents.filter(a => !dead.includes(a));
      if (agents.length === 0) return;
    }

    // Log the user message
    const fullMsg = message || '(no message)';
    this.session.logMessage('ceo', `@${target} ${fullMsg}`);

    // Push message to target inboxes and flush
    for (const agentName of agents) {
      this.inboxManager.pushTo(agentName, 'ceo', fullMsg);
    }

    if (this.journal) {
      const seq = this.journal.append({ type: 'msg', from: 'ceo', text: fullMsg });
      this.journal.append({ type: 'inbox_route', msgSeq: seq, to: [...agents] });
    }

    printCeo(`@${target} ${fullMsg}`);

    // Send to all agents in parallel
    const promises = agents.map(a => this.sendToAgent(a, writeMode));
    await Promise.all(promises);
  }

  async sendToAgent(agentName, writeMode = false, privateMode = false) {
    const prompt = this.inboxManager.flush(agentName);
    if (!prompt) {
      printDim(`  ${this.agentManager.displayName(agentName)} has nothing new to read.`);
      return;
    }

    // Journal the flush
    if (this.journal) {
      this.journal.append({ type: 'inbox_flush', agent: agentName });
    }

    return this.sendAndCapture(agentName, prompt, { writeMode, privateMode });
  }

  /**
   * Lower-level send + capture API with per-call options.
   * Used by sendToAgent (interactive) and AutoRunner (Phase 4).
   *
   * @param {string} agentName
   * @param {string} prompt - text to send to the agent
   * @param {object} options
   * @param {boolean} options.writeMode - append WRITE permission instruction
   * @param {boolean} options.privateMode - don't broadcast response to other inboxes
   * @param {string} options.display - 'full' | 'compact' | 'hidden'
   * @param {string|string[]} options.broadcastTo - 'all' | [agent names] | 'none'
   * @param {object} options.journalMeta - extra metadata for journal events (e.g. autoJobId, step, round, role)
   * @returns {Promise<{text: string, partial: boolean, timedOut: boolean}>}
   */
  async sendAndCapture(agentName, prompt, options = {}) {
    const {
      writeMode = false,
      privateMode = false,
      display: displayMode = 'full',
      broadcastTo = 'all',
      journalMeta = null,
    } = options;

    const displayName = this.agentManager.displayName(agentName);

    // Mark as running
    this.agentManager.setStatus(agentName, 'running');
    if (displayMode === 'full') {
      printDim(`  ◉ ${displayName} thinking...`);
    } else if (displayMode === 'compact') {
      printDim(`  ◉ ${displayName} thinking...`);
    }
    // 'hidden' — no output

    // Check persistent write mode from privacy manager
    const hasWriteMode = writeMode || (this.privacy && this.privacy.hasWriteMode(agentName));

    // Add mode instruction
    let fullPrompt = prompt;
    if (hasWriteMode) {
      fullPrompt += '\n[SYSTEM: You have WRITE permission for this response. You may edit files.]';
    } else {
      fullPrompt += '\n[SYSTEM: READ-ONLY mode. Do not modify any files.]';
    }

    // Include pinned file contents
    if (this.session.filesReferenced.size > 0) {
      const fs = require('fs');
      for (const filePath of this.session.filesReferenced) {
        try {
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            if (stat.size < 50000) { // only inline files under 50KB
              const content = fs.readFileSync(filePath, 'utf-8');
              fullPrompt += `\n[PINNED FILE: ${filePath}]\n${content}\n[END FILE]`;
            } else {
              fullPrompt += `\n[PINNED FILE: ${filePath} — too large to inline (${(stat.size/1024).toFixed(0)}KB)]`;
            }
          }
        } catch { /* skip unreadable files */ }
      }
    }

    // Track tokens sent
    if (this.tokenTracker) this.tokenTracker.trackSent(agentName, fullPrompt);

    // Record offset before sending
    const pane = this.paneManager.panes.get(agentName);
    if (pane) {
      // Advance offset past anything that's already there
      this.paneManager.readNewOutput(agentName);
    }

    // Send to agent's pane
    this.paneManager.sendToPane(agentName, fullPrompt);

    // Wait for response
    const result = await this.capture.waitForResponse(agentName);

    // Process result
    this.agentManager.setStatus(agentName, 'idle');

    if (result.timedOut) {
      if (displayMode !== 'hidden') {
        printWarning(`${displayName} timed out. Partial response captured.`);
      }
    }

    if (result.text) {
      // Track tokens received
      if (this.tokenTracker) this.tokenTracker.trackReceived(agentName, result.text);

      // Check for tag suggestions
      if (this.tagManager) {
        const suggestions = this.tagManager.extractSuggestions(agentName, result.text);
        for (const s of suggestions) {
          this.tagManager.addSuggestion(s);
          if (displayMode === 'full') {
            printDim(`  💡 ${displayName} suggests: #${s.tag} — /tag confirm or /tag dismiss`);
          }
        }
      }

      // Display response based on display mode
      if (displayMode === 'full') {
        const truncated = result.text.length > 5000
          ? result.text.substring(0, 5000) + '\n[... truncated — /full ' + agentName + ' for complete response]'
          : result.text;
        const tag = result.partial ? `${displayName} — PARTIAL` : displayName;
        printAgent(tag, truncated, this.agentManager.agents.get(agentName)?.provider);
      } else if (displayMode === 'compact') {
        const preview = result.text.substring(0, 120).replace(/\n/g, ' ');
        printDim(`  ✔ ${displayName}: ${preview}${result.text.length > 120 ? '…' : ''}`);
      }
      // 'hidden' — no output

      // Log to session (shared log for all, private log for DMs)
      if (privateMode && this.privacy) {
        this.privacy.logPrivateMessage(agentName, agentName, result.text);
      } else {
        this.session.logMessage(agentName, result.text);
      }

      // Journal the agent response
      if (this.journal) {
        const journalEvent = { type: 'msg', from: agentName, text: result.text };
        if (journalMeta) Object.assign(journalEvent, journalMeta);
        const seq = this.journal.append(journalEvent);

        // Journal the routing based on broadcast mode
        const routedTo = this._broadcastResponse(agentName, result.text, displayName, privateMode, broadcastTo, displayMode);
        if (routedTo && routedTo.length > 0) {
          this.journal.append({ type: 'inbox_route', msgSeq: seq, to: routedTo });
        }
      } else {
        // No journal — still need to broadcast
        this._broadcastResponse(agentName, result.text, displayName, privateMode, broadcastTo, displayMode);
      }

      // Show token status after response (only for full display)
      if (displayMode === 'full' && this.tokenTracker) {
        const percent = this.tokenTracker.usagePercent(agentName);
        if (percent >= 50) {
          const color = percent >= 80 ? C.red : C.yellow;
          printDim(`  ${color}context: ~${percent}%${C.reset}`);
        }
      }
    } else {
      if (displayMode === 'full') {
        printDim(`  ${displayName} produced no output.`);
      }
    }

    return result;
  }

  /**
   * Internal: broadcast an agent's response to other inboxes.
   * Returns the list of recipient agent names (for journal routing).
   */
  _broadcastResponse(agentName, text, displayName, privateMode, broadcastTo, display = 'full') {
    // Private mode: only broadcast if agent is transparent
    if (privateMode) {
      if (this.privacy && this.privacy.isTransparent(agentName)) {
        this.inboxManager.pushToAll(agentName, text, agentName);
        if (display !== 'hidden') {
          printDim(`  (${displayName} is transparent — response broadcast to all)`);
        }
        return [...this.inboxManager.inboxes.keys()].filter(n => n !== agentName);
      }
      return [];
    }

    // broadcastTo controls routing
    if (broadcastTo === 'none') {
      return [];
    }

    if (Array.isArray(broadcastTo)) {
      this.inboxManager.pushToGroup(broadcastTo, agentName, text, agentName);
      return broadcastTo.filter(n => n !== agentName);
    }

    // Default: 'all'
    this.inboxManager.pushToAll(agentName, text, agentName);
    if (display !== 'hidden' && this.privacy && this.privacy.isTransparent(agentName)) {
      printDim(`  (${displayName} is transparent — all agents can see its pane)`);
    }
    return [...this.inboxManager.inboxes.keys()].filter(n => n !== agentName);
  }

  handleStop(target) {
    const agents = [];
    const single = this.agentManager.resolve(target);
    if (single) {
      agents.push(single);
    } else {
      const group = this.agentManager.resolveGroup(target);
      if (group) agents.push(...group);
    }

    for (const name of agents) {
      try {
        const pane = this.paneManager.panes.get(name);
        if (pane) {
          require('child_process').execSync(`tmux send-keys -t ${pane.paneId} C-c`);
          this.agentManager.setStatus(name, 'idle');
          printSystem(`Stopped ${name}`);
        }
      } catch { /* ignore */ }
    }
  }

  // ── DM (private message) ─────────────────────────────

  async handleDM(target, message) {
    const resolved = this.agentManager.resolve(target);
    if (!resolved) {
      printError(`Agent not found: ${target}`);
      return;
    }

    if (!message) {
      printError('DM needs a message: @agent:dm <message> or /dm agent <message>');
      return;
    }

    // Log CEO's outgoing DM
    if (this.privacy) {
      this.privacy.logPrivateMessage(resolved, 'ceo', message);
    }

    // Push only to this agent — not to all inboxes
    this.inboxManager.pushTo(resolved, 'ceo', message);

    printCeo(`@${this.agentManager.displayName(resolved)}:dm ${message}`);
    printDim('  (private — other agents will not see this exchange)');

    // Send and capture response in private mode
    await this.sendToAgent(resolved, false, true);
  }

  // ── /Commands ──────────────────────────────────────────

  async handleCommand(input) {
    const parts = input.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    const ctx = {
      agentManager: this.agentManager,
      inboxManager: this.inboxManager,
      paneManager: this.paneManager,
      capture: this.capture,
      session: this.session,
      privacy: this.privacy,
      tokenTracker: this.tokenTracker,
      tagManager: this.tagManager,
      workflows: this.workflows,
      chatroom: this,
    };

    switch (command) {
      case 'agents':    cmd.cmdAgents(ctx); break;
      case 'spawn':     cmd.cmdSpawn(ctx, args); break;
      case 'kill':      cmd.cmdKill(ctx, args); break;
      case 'revive':    cmd.cmdRevive(ctx, args); break;
      case 'rename':    cmd.cmdRename(ctx, args); break;

      case 'dm':
        await this.handleDM(args[0], args.slice(1).join(' '));
        break;

      case 'clear':     await cmd.cmdClear(ctx, args); break;

      case 'group':     cmd.cmdGroup(ctx, args); break;
      case 'groups':    cmd.cmdGroups(ctx); break;
      case 'ungroup':   cmd.cmdUngroup(ctx, args); break;

      case 'pin':       cmd.cmdPin(ctx, args); break;
      case 'pins':      cmd.cmdPins(ctx); break;
      case 'unpin':     cmd.cmdUnpin(ctx, args); break;

      case 'mode':        cmd.cmdMode(ctx, args); break;
      case 'transparent': cmd.cmdTransparent(ctx, args, true); break;
      case 'private':     cmd.cmdTransparent(ctx, args, false); break;
      case 'share':       await cmd.cmdShare(ctx, args); break;

      case 'focus':     cmd.cmdFocus(ctx, args); break;

      case 'layout':
        this.paneManager.arrangeLayout();
        printSystem('Layout reset');
        break;

      case 'save':      cmd.cmdSave(ctx, args); break;

      case 'session':
        if (args[0] === 'name' && args[1]) {
          this.session.setName(args.slice(1).join('-'));
          printSystem(`Session named: ${this.session.name}`);
        }
        break;

      case 'history':   cmd.cmdHistory(ctx); break;
      case 'tags':      cmd.cmdTags(ctx, args); break;
      case 'tag':       cmd.cmdTagAction(ctx, args); break;
      case 'tokens':    cmd.cmdTokens(ctx); break;

      // Phase 3: Workflows (cmdWorkflow stays in chatroom — uses this.sendToAgent)
      case 'debate':    await this.cmdWorkflow('debate', args); break;
      case 'plan':      await this.cmdWorkflow('plan', args); break;
      case 'review':    await this.cmdWorkflow('review', args); break;
      case 'research':  await this.cmdWorkflow('research', args); break;

      case 'preset':    cmd.cmdPreset(ctx); break;
      case 'summarize': cmd.cmdSummarize(ctx, args); break;
      case 'full':      cmd.cmdFull(ctx, args); break;
      case 'status':    cmd.cmdStatus(ctx); break;
      case 'help':      cmd.cmdHelp(); break;
      case 'detach':    cmd.cmdDetach(ctx); break;

      case 'quit':
      case 'exit':
        this.confirmAndShutdown();
        break;

      default:
        printError(`Unknown command: /${command}. Type /help for commands.`);
    }
  }

  // ── Phase 3: Workflow commands ─────────────────────────

  async cmdWorkflow(type, args) {
    if (!this.workflows) {
      printError('Workflows module not loaded.');
      return;
    }

    // Resolve agent names from args
    const agentArgs = [];
    const textParts = [];
    let pastAgents = false;

    for (const arg of args) {
      if (!pastAgents) {
        const resolved = this.agentManager.resolve(arg);
        if (resolved) {
          agentArgs.push(resolved);
          continue;
        }
        // Check group
        const group = this.agentManager.resolveGroup(arg);
        if (group) {
          agentArgs.push(...group);
          continue;
        }
      }
      pastAgents = true;
      textParts.push(arg);
    }

    // If no agents specified, use all
    const agents = agentArgs.length > 0 ? agentArgs : [...this.agentManager.agents.keys()];
    const topic = textParts.join(' ') || null;

    let result;
    switch (type) {
      case 'debate':
        result = await this.workflows.runDebate(agents, topic);
        break;
      case 'plan':
        result = await this.workflows.runPlan(agents, topic);
        break;
      case 'review':
        result = await this.workflows.runReview(agents, topic);
        break;
      case 'research':
        result = await this.workflows.runResearch(agents, topic);
        break;
    }

    if (result && result.error) {
      printError(result.error);
    }
  }

  // ── Journal snapshot ───────────────────────────────────

  _writeSnapshot() {
    if (!this.journal) return;
    try {
      const state = {
        inboxes: this.inboxManager.serialize(),
        agents: this.agentManager.serialize(),
        tags: this.session.tags,
        filesReferenced: [...this.session.filesReferenced],
        privacy: this.privacy ? this.privacy.serialize() : null,
        tokenTracker: this.tokenTracker ? { sent: { ...this.tokenTracker.sent }, received: { ...this.tokenTracker.received } } : null,
        chatLogTail: this.session.chatLog.slice(-200),
        schemaVersion: 1,
        appVersion: '2.0.0',
      };
      this.journal.writeSnapshot(state);
      // Also flush meta on snapshot
      if (this._metaDirty && this.runningDir) {
        const { writeMeta, readMeta } = require('./menu');
        const existing = readMeta(this.runningDir) || {};
        existing.lastActive = new Date().toISOString();
        writeMeta(this.runningDir, existing);
        this._metaDirty = false;
      }
    } catch (e) {
      // Silent fail for periodic snapshots — don't crash the chatroom
    }
  }

  // ── Quit confirmation ──────────────────────────────────

  confirmAndShutdown() {
    // Use the existing readline to avoid conflicts
    this.rl.question('  Are you sure? This ends all agents. (y/N): ', (answer) => {
      if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
        this.shutdown();
      } else {
        printSystem('Quit cancelled.');
        this.rl.prompt();
      }
    });
  }

  // ── Shutdown ───────────────────────────────────────────

  shutdown() {
    // Guard against double shutdown (rl.close fires the 'close' event)
    if (this._shuttingDown) return;
    this._shuttingDown = true;

    this.running = false;
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
    if (this.metaUpdateInterval) clearInterval(this.metaUpdateInterval);
    if (this.tokenWarningInterval) clearInterval(this.tokenWarningInterval);
    if (this.snapshotInterval) clearInterval(this.snapshotInterval);

    // Final meta flush + snapshot before exit
    if (this._metaDirty && this.runningDir) {
      try {
        const { writeMeta, readMeta } = require('./menu');
        const existing = readMeta(this.runningDir) || {};
        existing.lastActive = new Date().toISOString();
        writeMeta(this.runningDir, existing);
        this._metaDirty = false;
      } catch { /* silent */ }
    }
    if (this.journal && this.journal.eventCount > 0) {
      this._writeSnapshot();
    }

    // Save session
    try {
      const dir = this.session.save(this.agentManager, this.inboxManager, this.privacy);
      console.log(`\n${C.dim}Session saved to: ${dir}${C.reset}`);
      // Clean up running dir — session was saved successfully
      if (this.runningDir) {
        try { require('fs').rmSync(this.runningDir, { recursive: true }); } catch { /* ignore */ }
      }
    } catch (e) {
      console.error('Failed to save session:', e.message);
    }

    console.log(`${C.dim}Goodbye, CEO.${C.reset}\n`);
    if (this.rl) this.rl.close();

    // Clean up lock file BEFORE destroying tmux — destroySession() kills
    // our own pane, so the process may die before process.exit() runs.
    if (this.onShutdown) this.onShutdown();

    this.paneManager.destroySession();
    process.exit(0);
  }
}

module.exports = Chatroom;
