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
    this.rl = null;
    this.running = false;
    this._shuttingDown = false;
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
    }, 30000);

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
      printCeo(input);
      return;
    }

    // Plain message — goes to all inboxes, nobody responds
    this.session.logMessage('ceo', input);
    this.inboxManager.pushToAll('ceo', input);
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

    printCeo(`@${target} ${fullMsg}`);

    // Send to all agents in parallel
    const promises = agents.map(a => this.sendToAgent(a, writeMode));
    await Promise.all(promises);
  }

  async sendToAgent(agentName, writeMode = false, privateMode = false) {
    const displayName = this.agentManager.displayName(agentName);

    // Flush inbox
    const prompt = this.inboxManager.flush(agentName);
    if (!prompt) {
      printDim(`  ${displayName} has nothing new to read.`);
      return;
    }

    // Mark as running
    this.agentManager.setStatus(agentName, 'running');
    printDim(`  ◉ ${displayName} thinking...`);

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
      printWarning(`${displayName} timed out. Partial response captured.`);
    }

    if (result.text) {
      // Track tokens received
      if (this.tokenTracker) this.tokenTracker.trackReceived(agentName, result.text);

      // Check for tag suggestions
      if (this.tagManager) {
        const suggestions = this.tagManager.extractSuggestions(agentName, result.text);
        for (const s of suggestions) {
          this.tagManager.addSuggestion(s);
          printDim(`  💡 ${displayName} suggests: #${s.tag} — /tag confirm or /tag dismiss`);
        }
      }

      // Truncate for chatroom display
      const display = result.text.length > 5000
        ? result.text.substring(0, 5000) + '\n[... truncated — /full ' + agentName + ' for complete response]'
        : result.text;

      const tag = result.partial ? `${displayName} — PARTIAL` : displayName;
      printAgent(tag, display, this.agentManager.agents.get(agentName)?.provider);

      // Log to session (shared log for all, private log for DMs)
      if (privateMode && this.privacy) {
        this.privacy.logPrivateMessage(agentName, agentName, result.text);
      } else {
        this.session.logMessage(agentName, result.text);
      }

      // Push to other agents' inboxes (skip in private/DM mode)
      if (privateMode) {
        // In private mode, only broadcast if agent is transparent
        if (this.privacy && this.privacy.isTransparent(agentName)) {
          this.inboxManager.pushToAll(agentName, result.text, agentName);
          printDim(`  (${displayName} is transparent — response broadcast to all)`);
        }
      } else {
        this.inboxManager.pushToAll(agentName, result.text, agentName);
        if (this.privacy && this.privacy.isTransparent(agentName)) {
          printDim(`  (${displayName} is transparent — all agents can see its pane)`);
        }
      }

      // Show token status after response
      if (this.tokenTracker) {
        const percent = this.tokenTracker.usagePercent(agentName);
        if (percent >= 50) {
          const color = percent >= 80 ? C.red : C.yellow;
          printDim(`  ${color}context: ~${percent}%${C.reset}`);
        }
      }
    } else {
      printDim(`  ${displayName} produced no output.`);
    }
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

      case 'save':      cmd.cmdSave(ctx); break;

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

      case 'quit':
      case 'exit':
        this.shutdown();
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

  // ── Shutdown ───────────────────────────────────────────

  shutdown() {
    // Guard against double shutdown (rl.close fires the 'close' event)
    if (this._shuttingDown) return;
    this._shuttingDown = true;

    this.running = false;
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
    if (this.tokenWarningInterval) clearInterval(this.tokenWarningInterval);

    // Save session
    try {
      const dir = this.session.save(this.agentManager, this.inboxManager, this.privacy);
      console.log(`\n${C.dim}Session saved to: ${dir}${C.reset}`);
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
