// src/chatroom.js
// ─────────────────────────────────────────────────────────
// The chatroom: readline prompt, @-routing, /commands
// This is the CEO's command center.
// ─────────────────────────────────────────────────────────
const readline = require('readline');

const { C, printWelcome, printCeo, printAgent, printSystem, printWarning, printError, printDim, progressBar } = require('./display');

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
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case 'agents':
        this.cmdAgents();
        break;

      case 'spawn':
        this.cmdSpawn(args);
        break;

      case 'kill':
        this.cmdKill(args);
        break;

      case 'revive':
        this.cmdRevive(args);
        break;

      case 'rename':
        this.cmdRename(args);
        break;

      case 'dm':
        await this.handleDM(args[0], args.slice(1).join(' '));
        break;

      case 'clear':
        await this.cmdClear(args);
        break;

      case 'group':
        this.cmdGroup(args);
        break;

      case 'groups':
        this.cmdGroups();
        break;

      case 'ungroup':
        this.cmdUngroup(args);
        break;

      case 'pin':
        this.cmdPin(args);
        break;

      case 'pins':
        this.cmdPins();
        break;

      case 'unpin':
        this.cmdUnpin(args);
        break;

      case 'mode':
        this.cmdMode(args);
        break;

      case 'transparent':
        this.cmdTransparent(args, true);
        break;

      case 'private':
        this.cmdTransparent(args, false);
        break;

      case 'share':
        await this.cmdShare(args);
        break;

      case 'focus':
        this.cmdFocus(args);
        break;

      case 'layout':
        this.paneManager.arrangeLayout();
        printSystem('Layout reset');
        break;

      case 'save':
        this.cmdSave();
        break;

      case 'session':
        if (args[0] === 'name' && args[1]) {
          this.session.setName(args.slice(1).join('-'));
          printSystem(`Session named: ${this.session.name}`);
        }
        break;

      case 'history':
        this.cmdHistory();
        break;

      case 'tags':
        this.cmdTags(args);
        break;

      case 'tag':
        this.cmdTagAction(args);
        break;

      case 'tokens':
        this.cmdTokens();
        break;

      // Phase 3: Workflows
      case 'debate':
        await this.cmdWorkflow('debate', args);
        break;

      case 'plan':
        await this.cmdWorkflow('plan', args);
        break;

      case 'review':
        await this.cmdWorkflow('review', args);
        break;

      case 'research':
        await this.cmdWorkflow('research', args);
        break;

      case 'preset':
        this.cmdPreset(args);
        break;

      case 'summarize':
        this.cmdSummarize(args);
        break;

      case 'full':
        this.cmdFull(args);
        break;

      case 'status':
        this.cmdStatus();
        break;

      case 'help':
        this.cmdHelp();
        break;

      case 'quit':
      case 'exit':
        this.shutdown();
        break;

      default:
        printError(`Unknown command: /${cmd}. Type /help for commands.`);
    }
  }

  // ── Command implementations ────────────────────────────

  cmdAgents() {
    const agents = this.agentManager.list();
    if (agents.length === 0) {
      printSystem('No agents active.');
      return;
    }
    printSystem('Active agents:');
    for (const a of agents) {
      const statusColor = a.status === 'idle' ? C.green
        : a.status === 'running' ? C.yellow
        : a.status === 'dead' ? C.red : C.dim;
      const nameStr = a.displayName !== a.name ? `${a.name} (${a.displayName})` : a.name;
      console.log(`  ${statusColor}◉${C.reset} ${nameStr} [${a.provider}] ${statusColor}${a.status}${C.reset} inbox:${a.inbox}`);
    }
  }

  cmdSpawn(args) {
    if (args.length === 0) {
      printError('Usage: /spawn <provider> (e.g. /spawn claude)');
      return;
    }
    const result = this.agentManager.spawn(args[0]);
    if (result.error) {
      printError(result.error);
    } else {
      this.paneManager.arrangeLayout();
      printSystem(`Spawned ${result.name}`);
    }
  }

  cmdKill(args) {
    if (args.length === 0) {
      printError('Usage: /kill <agent>');
      return;
    }
    const result = this.agentManager.kill(args[0]);
    if (result.error) {
      printError(result.error);
    } else {
      printSystem(`Killed ${result.killed}`);
    }
  }

  cmdRevive(args) {
    if (args.length === 0) {
      printError('Usage: /revive <agent>');
      return;
    }
    const result = this.agentManager.revive(args[0]);
    if (result.error) {
      printError(result.error);
    } else {
      printSystem(`Reviving ${result.revived}...`);
    }
  }

  cmdRename(args) {
    if (args.length < 2) {
      printError('Usage: /rename <agent> <newname>');
      return;
    }
    const result = this.agentManager.rename(args[0], args[1]);
    if (result.error) {
      printError(result.error);
    } else {
      printSystem(`Renamed ${result.renamed} → @${result.to}`);
    }
  }

  cmdGroup(args) {
    if (args.length < 2) {
      printError('Usage: /group <name> <agent1> <agent2> ...');
      return;
    }
    const result = this.agentManager.createGroup(args[0], args.slice(1));
    if (result.error) {
      printError(result.error);
    } else {
      printSystem(`Group @${result.group}: ${result.members.join(', ')}`);
    }
  }

  cmdGroups() {
    const groups = this.agentManager.listGroups();
    const keys = Object.keys(groups);
    if (keys.length === 0) {
      printSystem('No custom groups. Built-in: @all, @claudes, @codexes');
      return;
    }
    printSystem('Custom groups:');
    for (const [name, members] of Object.entries(groups)) {
      console.log(`  @${name}: ${members.join(', ')}`);
    }
    console.log(`  ${C.dim}Built-in: @all, @claudes, @codexes${C.reset}`);
  }

  cmdUngroup(args) {
    if (args.length === 0) {
      printError('Usage: /ungroup <name>');
      return;
    }
    const result = this.agentManager.removeGroup(args[0]);
    if (result.error) printError(result.error);
    else printSystem(`Removed group @${result.removed}`);
  }

  cmdPin(args) {
    if (args.length === 0) {
      printError('Usage: /pin <filepath>');
      return;
    }
    const filePath = args.join(' ');
    if (!require('fs').existsSync(filePath)) {
      printError(`File not found: ${filePath}`);
      return;
    }
    this.session.addFileReference(filePath);
    printSystem(`📎 Pinned: ${filePath}`);
  }

  cmdPins() {
    const files = [...this.session.filesReferenced];
    if (files.length === 0) {
      printSystem('No pinned files.');
    } else {
      printSystem('Pinned files:');
      files.forEach(f => console.log(`  📎 ${f}`));
    }
  }

  cmdUnpin(args) {
    if (args.length === 0) return;
    const filePath = args.join(' ');
    this.session.filesReferenced.delete(filePath);
    printSystem(`Unpinned: ${filePath}`);
  }

  cmdMode(args) {
    if (!this.privacy) {
      printError('Privacy module not loaded.');
      return;
    }
    if (args.length < 2) {
      printError('Usage: /mode <agent|all> <read|write>');
      return;
    }
    const target = args[0].toLowerCase();
    const mode = args[1].toLowerCase();

    if (target === 'all') {
      for (const [name] of this.agentManager.agents) {
        this.privacy.setWriteMode(name, mode === 'write');
      }
      printSystem(`All agents set to ${mode.toUpperCase()} mode`);
      return;
    }

    const resolved = this.agentManager.resolve(target);
    if (!resolved) {
      printError(`Agent not found: ${target}`);
      return;
    }
    this.privacy.setWriteMode(resolved, mode === 'write');
    printSystem(`${resolved} set to ${mode.toUpperCase()} mode`);
  }

  cmdTransparent(args, value) {
    if (!this.privacy) return;
    if (args.length === 0) {
      printError(`Usage: /${value ? 'transparent' : 'private'} <agent>`);
      return;
    }
    const result = this.privacy.setTransparent(args[0], value);
    if (result.error) {
      printError(result.error);
    } else {
      printSystem(`${result.agent} is now ${value ? 'transparent (DM responses broadcast to all)' : 'private (DMs stay private until /share)'}`);
    }
  }

  async cmdShare(args) {
    if (!this.privacy) return;
    // /share <agent> [last N | conclusion | summary | all]
    if (args.length < 1) {
      printError('Usage: /share <agent> [last N | conclusion | summary]');
      return;
    }
    const resolved = this.agentManager.resolve(args[0]);
    if (!resolved) {
      printError(`Agent not found: ${args[0]}`);
      return;
    }

    const mode = args[1] || 'conclusion';
    let messages;

    if (mode === 'conclusion') {
      messages = this.privacy.getLastPrivateMessages(resolved, 1);
    } else if (mode === 'summary') {
      messages = this.privacy.getPrivateLog(resolved);
    } else if (mode === 'all') {
      messages = this.privacy.getPrivateLog(resolved);
    } else if (mode === 'last') {
      const n = parseInt(args[2], 10) || 3;
      messages = this.privacy.getLastPrivateMessages(resolved, n);
    } else {
      messages = this.privacy.getLastPrivateMessages(resolved, 1);
    }

    if (!messages || messages.length === 0) {
      printError(`No private conversation with ${resolved} to share.`);
      return;
    }

    const formatted = this.privacy.formatForSharing(messages, resolved, mode);
    if (formatted) {
      this.session.logMessage(resolved, formatted);
      this.inboxManager.pushToAll(resolved, formatted, resolved);
      printSystem(`Shared ${mode} from ${resolved}'s private chat to chatroom`);
      console.log(`${C.dim}${formatted}${C.reset}`);
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

  cmdPreset() {
    if (!this.workflows) return;
    const presets = this.workflows.listPresets();
    printSystem('Available workflows:');
    for (const p of presets) {
      console.log(`  ${p.name} — ${p.description}`);
    }
  }

  // ── Phase 3: Tag actions ───────────────────────────────

  cmdTagAction(args) {
    if (!this.tagManager) return;
    if (args.length === 0) {
      printError('Usage: /tag list | /tag confirm [n] | /tag dismiss [n]');
      return;
    }

    if (args[0] === 'list') {
      const suggestions = this.tagManager.peekPendingSuggestions();
      if (suggestions.length === 0) {
        printSystem('No pending tag suggestions.');
        return;
      }
      printSystem('Pending tag suggestions:');
      suggestions.forEach((s, i) => {
        console.log(`  ${i + 1}. #${s.tag} (from ${s.agentName}) — ${s.text}`);
      });
      return;
    }

    if (args[0] === 'confirm') {
      const idx = args[1] ? parseInt(args[1], 10) - 1 : 0;
      const suggestions = this.tagManager.peekPendingSuggestions();
      if (suggestions.length === 0) {
        printSystem('No pending tag suggestions.');
        return;
      }
      const confirmed = this.tagManager.confirmSuggestion(idx);
      if (confirmed) {
        printSystem(`Tag confirmed: #${confirmed.tag} (suggested by ${confirmed.agentName})`);
      } else {
        printError(`Invalid index. Use /tag list to see pending suggestions.`);
      }
    } else if (args[0] === 'dismiss') {
      const idx = args[1] ? parseInt(args[1], 10) - 1 : 0;
      const dismissed = this.tagManager.dismissSuggestion(idx);
      if (dismissed) {
        printSystem(`Dismissed tag: #${dismissed.tag}`);
      } else {
        printSystem('No pending tag suggestions.');
      }
    }
  }

  cmdTokens() {
    if (!this.tokenTracker) {
      // Fallback: show byte counts
      for (const [name, pane] of this.paneManager.panes) {
        const kb = (pane.byteOffset / 1024).toFixed(1);
        console.log(`  ${name}: ~${kb}KB captured`);
      }
      return;
    }

    const stats = this.tokenTracker.allStats();
    printSystem('Token usage (estimated):');
    console.log();
    for (const s of stats) {
      const bar = progressBar(s.percent, 20);
      const color = s.percent >= 80 ? C.red : s.percent >= 50 ? C.yellow : C.green;
      console.log(`  ${s.displayName.padEnd(12)} ${color}${bar}${C.reset} ${s.tokens.toLocaleString()} / ${(s.limit/1000).toFixed(0)}k tokens (${s.percent}%)`);
      console.log(`  ${' '.repeat(12)} sent: ~${s.sent.toLocaleString()}  received: ~${s.received.toLocaleString()}`);
    }
    console.log();
  }


  cmdSummarize(args) {
    if (args.length === 0) {
      printError('Usage: /summarize <agent> — asks agent to self-summarize, then restarts with summary');
      return;
    }
    const resolved = this.agentManager.resolve(args[0]);
    if (!resolved) {
      printError(`Agent not found: ${args[0]}`);
      return;
    }
    // Send summarize request to agent
    this.inboxManager.pushTo(resolved, 'system',
      'Summarize everything we have discussed so far in a concise format. ' +
      'Include: key findings, decisions made, open questions, and current status. ' +
      'This summary will be used to continue the work in a fresh session.');
    printSystem(`Asked ${resolved} to summarize. After it responds, use /clear ${resolved} to restart it with the summary.`);
  }

  async cmdClear(args) {
    if (args.length === 0) {
      printError('Usage: /clear <agent> — restart agent session, seed with last summary');
      return;
    }
    const resolved = this.agentManager.resolve(args[0]);
    if (!resolved) {
      printError(`Agent not found: ${args[0]}`);
      return;
    }

    // Grab the last response from this agent as the summary
    const lastResponse = this.session.chatLog.filter(e => e.from === resolved).pop();
    const summary = lastResponse ? lastResponse.text : null;

    // Clear stale inbox before restarting (prevents processing old queued messages)
    this.inboxManager.clear(resolved);

    // Revive the agent (restarts its CLI session, truncates log file)
    const result = this.agentManager.revive(resolved);
    if (result.error) {
      printError(result.error);
      return;
    }

    // Reset token tracking
    if (this.tokenTracker) {
      this.tokenTracker.sent[resolved] = 0;
      this.tokenTracker.received[resolved] = 0;
    }

    // Wait for agent to start up
    const agent = this.agentManager.agents.get(resolved);
    const provider = this.agentManager.providers[agent.provider];
    printSystem(`Restarting ${resolved}...`);
    await new Promise(r => setTimeout(r, provider.startupDelay));
    this.agentManager.setStatus(resolved, 'idle');

    // Seed with summary if available
    if (summary) {
      this.inboxManager.pushTo(resolved, 'system',
        `[Previous session summary]\n${summary}\n[End of summary — fresh session started]`);
      printSystem(`${resolved} restarted and seeded with summary. @${resolved} to continue.`);
    } else {
      printSystem(`${resolved} restarted with clean slate.`);
    }
  }

  cmdFull(args) {
    if (args.length === 0) {
      printError('Usage: /full <agent> — show full last response');
      return;
    }
    const resolved = this.agentManager.resolve(args[0]);
    if (!resolved) {
      printError(`Agent not found: ${args[0]}`);
      return;
    }
    const lastResponse = this.session.chatLog.filter(e => e.from === resolved).pop();
    if (lastResponse) {
      printAgent(this.agentManager.displayName(resolved) + ' (full)', lastResponse.text, this.agentManager.agents.get(resolved)?.provider);
    } else {
      printSystem(`No responses from ${resolved} yet.`);
    }
  }

  cmdStatus() {
    // Combined status view
    const agents = this.agentManager.list();
    console.log();
    for (const a of agents) {
      const statusColor = a.status === 'idle' ? C.green
        : a.status === 'running' ? C.yellow
        : a.status === 'dead' ? C.red : C.dim;

      let extra = '';
      if (this.privacy) {
        if (this.privacy.isTransparent(a.name)) extra += ' [transparent]';
        if (this.privacy.hasWriteMode(a.name)) extra += ` ${C.red}[WRITE]${C.reset}`;
      }
      if (this.tokenTracker) {
        const pct = this.tokenTracker.usagePercent(a.name);
        extra += ` ctx:${pct}%`;
      }

      console.log(`  ${statusColor}◉${C.reset} ${a.displayName.padEnd(12)} [${a.provider}] ${statusColor}${a.status.padEnd(8)}${C.reset} inbox:${a.inbox}${extra}`);
    }
    if (this.tokenTracker) {
      console.log();
      console.log(`  ${C.dim}${this.tokenTracker.statusBar()}${C.reset}`);
    }
    console.log();
  }

  cmdFocus(args) {
    if (args.length === 0) {
      this.paneManager.focusChatroom();
      return;
    }
    const resolved = this.agentManager.resolve(args[0]);
    if (resolved) {
      this.paneManager.focusPane(resolved);
    } else {
      printError(`Agent not found: ${args[0]}`);
    }
  }

  cmdSave() {
    const dir = this.session.save(this.agentManager, this.inboxManager, this.privacy);
    printSystem(`Session saved to: ${dir}`);
  }

  cmdHistory() {
    const last10 = this.session.chatLog.slice(-10);
    if (last10.length === 0) {
      printSystem('No messages yet.');
      return;
    }
    printSystem('Last 10 messages:');
    for (const entry of last10) {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const preview = entry.text.substring(0, 100).replace(/\n/g, ' ');
      console.log(`  ${C.dim}${time}${C.reset} ${C.bold}${entry.from}${C.reset}: ${preview}`);
    }
  }

  cmdTags(args) {
    const tags = this.session.searchTags(args[0] || null);
    if (tags.length === 0) {
      printSystem('No tags found.');
      return;
    }
    for (const t of tags) {
      const time = new Date(t.timestamp).toLocaleTimeString();
      console.log(`  ${C.yellow}#${t.tag}${C.reset} ${C.dim}${time}${C.reset} ${t.text.substring(0, 80)}`);
    }
  }

  cmdHelp() {
    console.log(`
${C.bold}${C.cyan}=== agent-ceo v1.0 ===${C.reset}

${C.bold}Addressing:${C.reset}
  @agent message        Talk to one agent
  @all message          All agents respond
  @claudes / @codexes   Provider groups
  @mygroup message      Custom group
  @agent:stop           Stop mid-response
  @agent:write msg      One-time write permission
  @agent:dm msg         Private DM (others won't see)
  plain text            Queued silently for all

${C.bold}Agents:${C.reset}
  /agents  /spawn  /kill  /revive  /rename  /status  /clear

${C.bold}Groups:${C.reset}
  /group <name> a1 a2   Create    /ungroup  /groups

${C.bold}Privacy & Modes:${C.reset}
  /dm <agent> <msg>          Private DM (same as @agent:dm)
  /mode <agent> write|read   Persistent write toggle
  /transparent <agent>       DM responses also broadcast
  /private <agent>           DM stays private until /share
  /share <agent> [mode]      Share private to chatroom
    modes: conclusion, summary, last N, all

${C.bold}Workflows:${C.reset}
  /debate [agents] [topic]   Cross-critique
  /plan <a1> <a2> <topic>    Architect + critic
  /review <a1> <a2> <task>   Implement + review
  /research [agents] <topic> Parallel investigation
  /preset                    List available workflows

${C.bold}Files:${C.reset}  /pin  /unpin  /pins

${C.bold}Tags:${C.reset}
  #decision #todo #rejected  Manual tags in messages
  /tags [filter]             Search tags
  /tag list                  Show pending suggestions
  /tag confirm [n]           Confirm suggestion
  /tag dismiss [n]           Dismiss suggestion

${C.bold}Session:${C.reset}
  /session name <n>  /save  /history  /tokens
  /summarize <agent>  /clear <agent>  /full <agent>

${C.bold}Layout:${C.reset}  /focus [agent]   /layout

${C.bold}Other:${C.reset}   /help   /quit
`);
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
