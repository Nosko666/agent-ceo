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
    this.autoRunner = null;
    this._codexPendingMarkers = new Map(); // marker → { agentName, discovery }
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
        // Enter on empty line pauses /auto if running
        if (this.autoRunner && this.autoRunner.state === 'running') {
          this.autoRunner.pause('enter');
          if (this.journal) {
            this.journal.append({ type: 'auto_pause', jobId: this.autoRunner.currentJob.id, reason: 'enter' });
          }
          const { printDim } = require('./display');
          printDim('  [auto] Paused. /auto resume to continue.');
        }
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
    // Auto-pause on any manual input while /auto is running
    if (this.autoRunner && this.autoRunner.state === 'running') {
      this.autoRunner.pause('manual_input');
      if (this.journal) {
        this.journal.append({ type: 'auto_pause', jobId: this.autoRunner.currentJob.id, reason: 'manual_input' });
      }
      printDim('  [auto] Paused (manual input). /auto resume to continue.');
    }

    // /commands
    if (input.startsWith('/')) {
      await this.handleCommand(input);
      return;
    }

    // @ mentions
    const atMatch = input.match(/^@([^\s:]+)(?::(\w+))?\s*(.*)/s);
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
      forceReadOnly = false,
      privateMode = false,
      display: displayMode = 'full',
      broadcastTo = 'all',
      journalMeta = null,
    } = options;

    // Codex marker injection: prepend marker to first real message
    let actualPrompt = prompt;
    const agent = this.agentManager.agents.get(agentName);
    if (agent && !agent.sessionId && agent.provider === 'codex') {
      // Generate marker for this conversation (once)
      if (!agent._codexMarker) {
        const CodexDiscovery = require('./native/codexDiscovery');
        agent._codexMarker = CodexDiscovery.generateMarker(agentName);
        agent._codexMarkerSent = false;
      }

      if (!agent._codexMarkerSent) {
        // Journal first, then send (crash-safe ordering)
        if (this.journal) {
          this.journal.append({ type: 'codex_marker_sent', agent: agentName, marker: agent._codexMarker });
        }

        // Prepend marker (internal only — not shown in chatroom)
        actualPrompt = agent._codexMarker + ' (internal, ignore)\n' + prompt;
        agent._codexMarkerSent = true;

        // Register marker with session-level scanner
        this._startCodexDiscoveryIfNeeded(agentName, agent);
      }
    }

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
    const hasWriteMode = forceReadOnly ? false : (writeMode || (this.privacy && this.privacy.hasWriteMode(agentName)));

    // Add mode instruction
    let fullPrompt = actualPrompt;
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

    // Generate unique response markers for clean extraction
    const crypto = require('crypto');
    const markerId = crypto.randomUUID().substring(0, 8);
    const beginMarker = `AGENT_CEO_BEGIN_${markerId}`;
    const endMarker = `AGENT_CEO_END_${markerId}`;

    // Marker instruction — no placeholders (Codex will echo them literally)
    fullPrompt += `\n\nWrap your entire response between these two markers on their own lines:\n${beginMarker}\n${endMarker}\nPut your full answer between them. Do not repeat these instructions.`;

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

    // Extract response between markers (last BEGIN → next END)
    if (result && result.text) {
      const extracted = this._extractBetweenMarkers(result.text, beginMarker, endMarker);
      if (extracted !== null) {
        result.text = extracted;
      } else {
        // Markers missing — reprompt once: ask agent to re-output with markers only
        this.paneManager.readNewOutput(agentName); // advance offset
        this.paneManager.sendToPane(agentName,
          `Please repeat your previous answer, wrapped between these markers on their own lines:\n${beginMarker}\n${endMarker}`);
        const retry = await this.capture.waitForResponse(agentName);
        if (retry && retry.text) {
          const retryExtracted = this._extractBetweenMarkers(retry.text, beginMarker, endMarker);
          if (retryExtracted !== null) {
            result.text = retryExtracted;
          }
          // If still no markers, keep the raw text (fallback — some output is better than none)
        }
      }
    }

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

  _startCodexDiscoveryIfNeeded(agentName, agent) {
    const CodexDiscovery = require('./native/codexDiscovery');
    // Register marker with session-level pending map
    this._codexPendingMarkers.set(agent._codexMarker, agentName);

    // Start one discovery per agent (full single-scanner optimization is Phase 3.5)
    const discovery = CodexDiscovery.startDiscovery({
      marker: agent._codexMarker,
      agentName,
      sessionsDir: null, // uses env var or default
      agentStartTime: new Date(agent.spawnedAt).getTime(),
      projectDir: process.cwd(),
      onFound: (sessionId) => {
        agent.sessionId = sessionId;
        if (this.journal) {
          this.journal.append({ type: 'agent_session', agent: agentName, sessionId });
        }
        this._metaDirty = true;
        this._codexPendingMarkers.delete(agent._codexMarker);
      },
    });
    agent._codexDiscovery = discovery;
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
          if (this.journal) {
            this.journal.append({ type: 'session_name', name: this.session.name });
          }
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
      case 'full':
        if (args[0] === 'auto') {
          cmd.cmdFullAuto(ctx, args.slice(1));
        } else {
          cmd.cmdFull(ctx, args);
        }
        break;
      case 'status':    cmd.cmdStatus(ctx); break;
      case 'help':      cmd.cmdHelp(); break;
      case 'detach':    cmd.cmdDetach(ctx); break;

      case 'quit':
      case 'exit':
        this.confirmAndShutdown();
        break;

      case 'auto':
        await this.handleAutoCommand(args);
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

  // ── /auto command handler ─────────────────────────────

  async handleAutoCommand(args) {
    const AutoRunner = require('./auto');
    const { printSystem, printError, printWarning } = require('./display');

    if (!this.autoRunner) {
      this.autoRunner = new AutoRunner();
    }

    const subCmd = args[0] ? args[0].toLowerCase() : 'status';

    // Control commands
    if (subCmd === 'status') {
      const status = this.autoRunner.getStatus();
      if (!status.currentJob) { printSystem('No auto job running.'); return; }
      const cj = status.currentJob;
      printSystem(`Auto job ${cj.id}: ${status.state} — ${cj.step || 'idle'} (round ${cj.round}/${cj.maxRounds})`);
      return;
    }

    if (subCmd === 'pause') {
      this.autoRunner.pause('manual');
      if (this.journal) this.journal.append({ type: 'auto_pause', jobId: this.autoRunner.currentJob.id, reason: 'manual' });
      printSystem('Auto paused.');
      return;
    }

    if (subCmd === 'resume') {
      if (!this.autoRunner.resume()) { printError('No paused auto job.'); return; }
      const roundsIdx = args.indexOf('--rounds');
      if (roundsIdx >= 0 && args[roundsIdx + 1]) {
        this.autoRunner.addRounds(parseInt(args[roundsIdx + 1], 10));
      }
      if (this.journal) this.journal.append({ type: 'auto_resume', jobId: this.autoRunner.currentJob.id });
      printSystem('Auto resumed.');
      await this.autoRunner.run(this);
      return;
    }

    if (subCmd === 'stop') {
      if (!this.autoRunner.currentJob) { printError('No auto job to stop.'); return; }
      const jobId = this.autoRunner.currentJob.id;
      this.autoRunner.stop(this.journal);
      printSystem(`Auto job ${jobId} stopped.`);
      return;
    }

    if (subCmd === 'verbose') {
      if (!this.autoRunner.currentJob) { printError('No auto job.'); return; }
      const mode = args[1] ? args[1].toLowerCase() : '';
      this.autoRunner.currentJob.verbose = (mode === 'on');
      printSystem(`Auto verbose: ${mode === 'on' ? 'ON' : 'OFF'}`);
      return;
    }

    if (subCmd === 'rounds') {
      if (!this.autoRunner.currentJob) { printError('No auto job.'); return; }
      const n = parseInt(args[1], 10);
      if (isNaN(n)) { printError('Usage: /auto rounds <number>'); return; }
      this.autoRunner.setRounds(n);
      printSystem(`Auto maxRounds set to ${n}.`);
      return;
    }

    // Start new job
    if (this.autoRunner.state !== 'idle') {
      printError(`Auto job ${this.autoRunner.currentJob.id} is already ${this.autoRunner.state}. /auto stop first.`);
      return;
    }

    // Parse flags
    let pipeline = AutoRunner.DEFAULT_PIPELINE;
    let maxRounds = 10;
    let maxMinutes = 30;
    let verbose = false;
    let noRoles = false;
    let participantNames = null;
    const roleOverrides = {};
    const goalParts = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--pipeline') { pipeline = args[++i].split(','); }
      else if (arg === '--rounds') { maxRounds = parseInt(args[++i], 10); }
      else if (arg === '--minutes') { maxMinutes = parseInt(args[++i], 10); }
      else if (arg === '--verbose') { verbose = true; }
      else if (arg === '--no-roles') { noRoles = true; }
      else if (arg === '--participants') { participantNames = args[++i].split(','); }
      else if (arg === '--planner') { roleOverrides.planner = args[++i]; }
      else if (arg === '--critic') {
        const val = args[++i];
        roleOverrides.critic = val.includes(',') ? val.split(',') : val;
      }
      else if (arg === '--implementer') { roleOverrides.implementer = args[++i]; }
      else if (arg === '--reviewer') { roleOverrides.reviewer = args[++i]; }
      else { goalParts.push(arg); }
    }

    const goal = goalParts.join(' ');
    if (!goal) { printError('Usage: /auto <goal>'); return; }

    const participants = participantNames
      ? participantNames.map(n => this.agentManager.resolve(n)).filter(Boolean)
      : [...this.agentManager.agents.keys()];

    if (participants.length === 0) { printError('No agents available.'); return; }

    try { AutoRunner.validatePipeline(pipeline); }
    catch (e) { printError(e.message); return; }

    const roles = AutoRunner.assignRoles(participants, { noRoles, ...roleOverrides });

    const job = this.autoRunner.createJob({ goal, pipeline, participants, maxRounds, maxTimeMs: maxMinutes * 60 * 1000, roles, verbose });

    if (this.journal) {
      this.journal.append({ type: 'auto_start', jobId: job.id, goal, pipeline: job.pipeline, participants: job.participants });
    }

    printSystem(`Auto job ${job.id} started: ${goal}`);
    printSystem(`Pipeline: ${pipeline.join(' → ')} | Rounds: ${maxRounds} | Time: ${maxMinutes}m`);
    printSystem(`Participants: ${participants.join(', ')}${roles.solo ? ' (solo mode)' : ''}`);

    await this.autoRunner.run(this);
  }

  // ── Response extraction ──────────────────────────────────

  _extractBetweenMarkers(text, beginMarker, endMarker) {
    // Use LAST BEGIN (first is input echo) → next END after it
    const beginIdx = text.lastIndexOf(beginMarker);
    if (beginIdx < 0) return null;

    const afterBegin = beginIdx + beginMarker.length;
    const endIdx = text.indexOf(endMarker, afterBegin);

    let extracted;
    if (endIdx >= 0) {
      extracted = text.substring(afterBegin, endIdx);
    } else {
      // No END marker — take everything after last BEGIN
      extracted = text.substring(afterBegin);
    }

    // Clean: remove marker lines + known UI chrome that leaked between markers
    extracted = extracted
      .split('\n')
      .filter(line => {
        const t = line.trim();
        // Marker lines
        if (t.includes('AGENT_CEO_BEGIN_') || t.includes('AGENT_CEO_END_')) return false;
        // System instructions (input echo)
        if (t.includes('SYSTEM: READ-ONLY') || t.includes('SYSTEM: You have WRITE')) return false;
        // Claude Code UI chrome
        if (t.includes('ctrl+g to edit') || t.includes('Pasting text')) return false;
        // Codex UI chrome (status bar, prompt hints, progress)
        if (/^›/.test(t)) return false;                           // Codex prompt hints
        if (/gpt-[\d.]+.*left/.test(t)) return false;             // Codex status bar
        if (/^[•●]\s*(Working|Explored|Searching)/.test(t)) return false; // Codex progress
        if (t === 'esc to interrupt') return false;                // interrupt hint
        return true;
      })
      .join('\n')
      .trim();

    return extracted.length > 0 ? extracted : null;
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
    const { printSystem } = require('./display');

    if (this.autoRunner && this.autoRunner.state !== 'idle') {
      const job = this.autoRunner.currentJob;
      this.rl.question(
        `  ⚠ Auto job ${job.id} is ${job.state} (round ${job.round}/${job.maxRounds}).\n` +
        `  Quit will stop the job and kill all agents.\n` +
        `  Type 'quit' to confirm, or use /detach to leave it running.\n  > `,
        (answer) => {
          if (answer.trim().toLowerCase() === 'quit') {
            this.autoRunner.stop(this.journal);
            this.shutdown();
          } else {
            printSystem('Quit cancelled.');
            this.rl.prompt();
          }
        }
      );
    } else {
      this.rl.question('  Are you sure? This ends all agents. (y/N): ', (answer) => {
        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
          this.shutdown();
        } else {
          printSystem('Quit cancelled.');
          this.rl.prompt();
        }
      });
    }
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
      const dir = this.session.save(this.agentManager, this.inboxManager, this.privacy, this.autoRunner);
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
