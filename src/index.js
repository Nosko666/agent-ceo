// src/index.js
// ─────────────────────────────────────────────────────────
// agent-ceo entry point
//
// Two modes of operation:
//   1. External (default): creates tmux session + panes,
//      then launches the chatroom inside pane 0 and attaches.
//   2. Internal (--_chatroom): runs inside tmux pane 0,
//      reads setup state, and starts the interactive REPL.
// ─────────────────────────────────────────────────────────
const { execSync, execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PaneManager = require('./panes');
const InboxManager = require('./inbox');
const AgentManager = require('./agents');
const ResponseCapture = require('./capture');
const SessionManager = require('./session');
const Chatroom = require('./chatroom');
const WorkflowManager = require('./workflows');
const TagManager = require('./tags');
const TokenTracker = require('./tokens');
const PrivacyManager = require('./privacy');
const Journal = require('./journal');

const SESSION_NAME = 'ceo';
const LOG_DIR = '/tmp/agent-ceo';
// Setup file is per-session so concurrent launches don't race
function setupFileFor(id) {
  return path.join(LOG_DIR, `setup-${id}.json`);
}
// Lock file is per-session — see lockFileFor()

// ── CLI argument parsing ─────────────────────────────────

function parseArgs(argv) {
  const args = {
    agents: null,           // null = not specified (use defaults from config)
    resume: false,
    session: null,
    setup: false,
    help: false,
    _chatroom: false,
    _chatroomId: null,
    new: false,
    attach: null,           // tmux session name to attach to
    name: null,             // session label
    cd: null,               // project directory override
    native: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--resume' || arg === '-r') {
      args.resume = true;
    } else if (arg === '--session' || arg === '-s') {
      args.session = argv[++i];
    } else if (arg === '--agents' || arg === '-a') {
      args.agents = parseAgentSpec(argv[++i]);
    } else if (arg === 'setup') {
      args.setup = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--_chatroom') {
      args._chatroom = true;
      args._chatroomId = argv[++i]; // session name follows
    } else if (arg === '--new') {
      args.new = true;
    } else if (arg === '--attach') {
      args.attach = argv[++i];
    } else if (arg === '--name') {
      args.name = argv[++i];
    } else if (arg === '--cd') {
      args.cd = argv[++i];
    } else if (arg === '--native') {
      args.native = true;
    }
  }
  return args;
}

function parseAgentSpec(spec) {
  // Format: "claude:2,codex:2" or "claude:3 codex:1"
  const result = {};
  if (!spec) return { claude: 2, codex: 2 };
  const parts = spec.replace(/,/g, ' ').split(/\s+/);
  for (const part of parts) {
    const [provider, count] = part.split(':');
    result[provider] = parseInt(count, 10) || 1;
  }
  return result;
}

// ── Dependency checks ────────────────────────────────────

function checkDependencies() {
  const issues = [];

  try {
    execSync('which tmux', { stdio: 'ignore' });
  } catch {
    issues.push('tmux not found. Install with: sudo apt install tmux');
  }

  const nodeVersion = parseInt(process.version.slice(1), 10);
  if (nodeVersion < 20) {
    issues.push(`Node.js 20+ required. You have ${process.version}`);
  }

  return issues;
}

function checkProviders(agentSpec) {
  const available = {};
  const missing = [];

  for (const provider of Object.keys(agentSpec)) {
    try {
      const mod = require(`./providers/${provider}`);
      if (mod.detect()) {
        available[provider] = mod;
      } else {
        missing.push(`${provider} CLI not found in PATH`);
      }
    } catch {
      missing.push(`No provider adapter for: ${provider}`);
    }
  }

  return { available, missing };
}

// ── Lock file ────────────────────────────────────────────

function lockFileFor(sessionName) {
  return path.join(require('os').homedir(), '.agent-ceo', 'running', sessionName, 'lock');
}

let _activeLockFile = null;

function acquireLock(sessionName) {
  const lockFile = lockFileFor(sessionName);
  const lockDir = path.dirname(lockFile);
  fs.mkdirSync(lockDir, { recursive: true });

  if (fs.existsSync(lockFile)) {
    try {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      process.kill(pid, 0);
      return false;
    } catch {
      fs.unlinkSync(lockFile);
    }
  }

  fs.writeFileSync(lockFile, String(process.pid));
  _activeLockFile = lockFile;
  return true;
}

function releaseLock() {
  if (_activeLockFile) {
    try { fs.unlinkSync(_activeLockFile); } catch { /* ignore */ }
    _activeLockFile = null;
  }
}

// ── Setup command ────────────────────────────────────────

function runSetup() {
  console.log('\n  agent-ceo setup\n');

  const deps = checkDependencies();
  if (deps.length > 0) {
    console.log('  ❌ Missing dependencies:');
    deps.forEach(d => console.log(`     ${d}`));
  } else {
    console.log('  ✅ tmux installed');
    console.log(`  ✅ Node.js ${process.version}`);
  }

  const claudeProvider = require('./providers/claude');
  const codexProvider = require('./providers/codex');

  console.log(claudeProvider.detect()
    ? '  ✅ Claude Code CLI found'
    : '  ❌ Claude Code CLI not found');
  console.log(codexProvider.detect()
    ? '  ✅ Codex CLI found'
    : '  ❌ Codex CLI not found');

  console.log('\n  Run `agent-ceo` to start.\n');
}

// ── Help ─────────────────────────────────────────────────

function printHelp() {
  console.log(`
  agent-ceo — Lead a team of AI agents from one terminal

  Usage:
    agent-ceo                             Interactive menu (join/new/resume)
    agent-ceo --new                       Create new session (skip menu)
    agent-ceo --attach <session>          Join existing session directly
    agent-ceo --new --agents claude:3     Custom team composition
    agent-ceo --new --name my-project     Set session label
    agent-ceo --new --cd /path/to/repo    Set project directory
    agent-ceo --resume                    List saved sessions
    agent-ceo --session <name>            Resume a saved session
    agent-ceo setup                       Check dependencies
    agent-ceo --help                      Show this help

  Inside the chatroom:
    @agent message      Send to one agent
    @all message        All agents respond
    @claudes message    Send to all Claude instances
    @agent:dm msg       Private DM
    /detach             Leave (agents keep running)
    /help               Full command reference
    /quit               End session (confirms first)
`);
}

// ═══════════════════════════════════════════════════════════
// MODE 1: External — create tmux session, spawn agents,
//         launch chatroom in pane 0, then attach.
// ═══════════════════════════════════════════════════════════

function allocateSessionName() {
  const { RUNNING_DIR } = require('./menu');
  fs.mkdirSync(RUNNING_DIR, { recursive: true });

  let name = SESSION_NAME;
  let attempt = 1;
  while (true) {
    // Check tmux collision
    let tmuxTaken = false;
    try {
      execSync(`tmux has-session -t ${name} 2>/dev/null`);
      tmuxTaken = true;
    } catch { /* not taken */ }

    if (tmuxTaken) {
      attempt++;
      name = `${SESSION_NAME}-${attempt}`;
      continue;
    }

    // Reserve via atomic mkdir
    const dirPath = path.join(RUNNING_DIR, name);
    try {
      fs.mkdirSync(dirPath); // fails if exists
      return name;
    } catch (e) {
      if (e.code === 'EEXIST') {
        attempt++;
        name = `${SESSION_NAME}-${attempt}`;
      } else {
        throw e;
      }
    }
  }
}

function attachToSession(sessionName) {
  if (process.env.TMUX) {
    spawnSync('tmux', ['switch-client', '-t', sessionName], { stdio: 'inherit' });
  } else {
    spawnSync('tmux', ['attach-session', '-t', sessionName], { stdio: 'inherit' });
  }
}

function launchInTmux(args) {
  const sessionName = allocateSessionName();

  try {
    // Determine agent list (from resume state or CLI args)
    let agentList = []; // [{ name, provider }]
    let savedState = null;

    if (args.session) {
      savedState = SessionManager.loadState(args.session);
      if (savedState && savedState.agents && savedState.agents.agents) {
        agentList = Object.entries(savedState.agents.agents).map(([name, agent]) => ({
          name,
          provider: agent.provider,
        }));
      }
    }

    // Fall back to CLI spec if no saved state
    if (agentList.length === 0) {
      const agentSpec = args.agents || { claude: 2, codex: 2 };
      for (const [providerName, count] of Object.entries(agentSpec)) {
        for (let i = 0; i < count; i++) {
          agentList.push({ name: `${providerName}${i + 1}`, provider: providerName });
        }
      }
    }

    // Provider checks (only for providers we need)
    const needed = [...new Set(agentList.map(a => a.provider))];
    const providerSpec = {};
    for (const p of needed) providerSpec[p] = 1;
    const { missing } = checkProviders(providerSpec);
    if (missing.length > 0) {
      console.error('\nProvider issues:');
      missing.forEach(m => console.error(`  ❌ ${m}`));
      console.error('\nRun `agent-ceo setup` for details.\n');
      process.exit(1);
    }

    console.log('\n  Starting agent-ceo...\n');

    // ── Create tmux session ──────────────────────────────
    execSync(`tmux new-session -d -s ${sessionName} -x 200 -y 50`);
    try {
      execSync(`tmux set-option -t ${sessionName} -g mouse on 2>/dev/null`);
      execSync(`tmux set-option -t ${sessionName} pane-border-status top 2>/dev/null`);
      execSync(`tmux set-option -t ${sessionName} pane-border-format " #{pane_title} " 2>/dev/null`);
    } catch { /* older tmux */ }

    // Tag session for discovery by startup menu
    try {
      execSync(`tmux set-option -t ${sessionName} @agent_ceo 1 2>/dev/null`);
    } catch { /* older tmux may not support user options */ }

    // Set session label tag
    if (args.sessionLabel) {
      try {
        execSync(`tmux set-option -t ${sessionName} @agent_ceo_label "${args.sessionLabel}" 2>/dev/null`);
      } catch { /* ignore */ }
    }

    // Get pane 0 ID
    const pane0 = execSync(
      `tmux list-panes -t ${sessionName} -F "#{pane_id}" | head -1`
    ).toString().trim();

    // Title pane 0 as chatroom
    try {
      execSync(`tmux select-pane -t ${pane0} -T "chatroom" 2>/dev/null`);
    } catch { /* ignore */ }

    // ── Create agent panes ───────────────────────────────
    const sessionLogDir = path.join('/tmp/agent-ceo', sessionName);
    fs.mkdirSync(sessionLogDir, { recursive: true });

    // If --native, load native IDs before creating panes so we can use resume args
    let nativeIds = null;
    if (args.native && args.session) {
      nativeIds = SessionManager.loadNativeIds(args.session);
    }

    const agentPanes = {};

    for (const { name, provider: providerName } of agentList) {
      const provider = require(`./providers/${providerName}`);
      const logFile = path.join(sessionLogDir, `${name}.log`);
      fs.writeFileSync(logFile, '');

      console.log(`  Spawning ${name}...`);

      // Create pane with default shell (interactive, accepts send-keys)
      const cdFlag = args.projectDir ? `-c "${args.projectDir}"` : '';
      const paneId = execSync(
        `tmux split-window -t ${sessionName} ${cdFlag} -P -F "#{pane_id}"`
      ).toString().trim();

      // Set pane title
      try {
        execSync(`tmux select-pane -t ${paneId} -T "${name}" 2>/dev/null`);
      } catch { /* ignore */ }

      // Start logging BEFORE starting the CLI
      execSync(`tmux pipe-pane -t ${paneId} "cat >> ${logFile}"`);

      // Check for native resume IDs
      let sessionId;
      let cliArgs;

      if (nativeIds && nativeIds[name]) {
        sessionId = nativeIds[name].sessionId;
        cliArgs = provider.getResumeArgs ? provider.getResumeArgs(sessionId) : provider.startArgs;
        console.log(`  ${name}: resuming native session ${sessionId.substring(0, 8)}...`);
      } else {
        // Generate native session ID (Claude: UUID; Codex: null, discovered later)
        sessionId = provider.generateSessionId ? provider.generateSessionId() : null;
        cliArgs = provider.getStartArgs ? provider.getStartArgs(sessionId) : provider.startArgs;
      }

      const cmd = `${provider.command} ${cliArgs.join(' ')}`.trim();
      execFileSync('tmux', ['send-keys', '-t', paneId, '-l', cmd]);
      execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter']);

      agentPanes[name] = { paneId, logFile, provider: providerName, sessionId };
      console.log(`  ✅ ${name} launched${sessionId ? ` (session: ${sessionId.substring(0, 8)}...)` : ''}`);
    }

    // Arrange layout
    try {
      execSync(`tmux select-layout -t ${sessionName} tiled 2>/dev/null`);
    } catch { /* ignore */ }

    // ── Create persistent running directory for journal ──
    const runningDir = path.join(require('os').homedir(), '.agent-ceo', 'running', sessionName);
    fs.mkdirSync(runningDir, { recursive: true });

    // Write initial session metadata
    const { writeMeta } = require('./menu');
    writeMeta(runningDir, {
      label: args.sessionLabel || sessionName,
      team: Object.fromEntries(agentList.map(a => [a.name, a.provider])),
      projectDir: args.projectDir || process.cwd(),
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      schemaVersion: 1,
      appVersion: '2.0.0',
    });

    // ── Save setup state for the chatroom process ────────
    const setupState = {
      sessionName,
      sessionLogDir,
      pane0,
      agents: agentPanes,
      originalArgs: {
        agents: args.agents,
        session: args.session,
        resume: args.resume,
        native: args.native,
      },
    };
    const setupFile = setupFileFor(sessionName);
    fs.writeFileSync(setupFile, JSON.stringify(setupState));

    // ── Start chatroom in pane 0 ─────────────────────────
    const scriptPath = path.resolve(__dirname, '../bin/agent-ceo');
    const chatCmd = `node "${scriptPath}" --_chatroom "${sessionName}"`;
    execFileSync('tmux', ['send-keys', '-t', pane0, '-l', chatCmd]);
    execFileSync('tmux', ['send-keys', '-t', pane0, 'Enter']);

    // Focus pane 0
    try {
      execSync(`tmux select-pane -t ${pane0} 2>/dev/null`);
    } catch { /* ignore */ }

    // ── Attach to tmux ───────────────────────────────────
    console.log(`  Attaching to tmux session: ${sessionName}\n`);
    attachToSession(sessionName);

  } catch (err) {
    console.error(`\n  Startup failed: ${err.message}\n`);
    try { execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`); } catch { }
    const { RUNNING_DIR } = require('./menu');
    try { fs.rmSync(path.join(RUNNING_DIR, sessionName), { recursive: true }); } catch { }
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════
// MODE 2: Internal — running inside tmux pane 0.
//         Read setup state, initialize, start chatroom REPL.
// ═══════════════════════════════════════════════════════════

async function runChatroom(sessionId) {
  // Read setup state from the external process (per-session file)
  const setupFile = setupFileFor(sessionId);
  if (!fs.existsSync(setupFile)) {
    console.error('Setup state not found. Run agent-ceo normally (without --_chatroom).');
    process.exit(1);
  }
  const setup = JSON.parse(fs.readFileSync(setupFile, 'utf-8'));

  // Clean up setup file
  try { fs.unlinkSync(setupFile); } catch { /* ignore */ }

  // Acquire lock keyed by session name (allows multiple sessions)
  if (!acquireLock(setup.sessionName)) {
    console.error(`Another agent-ceo chatroom is already running for session "${setup.sessionName}".`);
    console.error(`Attach with: tmux attach -t ${setup.sessionName}`);
    process.exit(1);
  }
  // Release lock on exit; SIGINT/SIGTERM are handled after chatroom is created
  process.on('exit', releaseLock);

  // ── Initialize PaneManager with existing panes ───────
  const paneManager = new PaneManager(setup.sessionLogDir);
  paneManager.restoreFromSetup(setup);

  // If this is a recovery (chatroom restart, not fresh session),
  // set byte offsets to EOF so we don't replay old output
  if (setup.isRecovery) {
    for (const [name] of paneManager.panes) {
      const pane = paneManager.panes.get(name);
      try {
        const stats = fs.statSync(pane.logFile);
        if (stats.size > 0) {
          pane.byteOffset = stats.size;
        }
      } catch { /* new file, offset stays 0 */ }
    }
  }

  // ── Initialize InboxManager ──────────────────────────
  const inboxManager = new InboxManager();

  // ── Initialize AgentManager (register, don't spawn) ──
  const agentManager = new AgentManager(paneManager, inboxManager);
  agentManager.paneManager = paneManager;

  for (const [name, info] of Object.entries(setup.agents)) {
    agentManager.agents.set(name, {
      provider: info.provider,
      originalName: name,
      customName: null,
      status: 'starting',
      spawnedAt: new Date().toISOString(),
      sessionId: info.sessionId || null,
    });
    inboxManager.register(name);

    // Update provider counters so /spawn gives correct next number
    const num = parseInt(name.replace(info.provider, ''), 10);
    if (!agentManager.counters[info.provider] || agentManager.counters[info.provider] <= num) {
      agentManager.counters[info.provider] = num + 1;
    }
  }

  // ── Other managers ───────────────────────────────────
  const capture = new ResponseCapture(paneManager);
  const session = new SessionManager();

  // Initialize Journal in persistent running directory
  const runningDir = path.join(require('os').homedir(), '.agent-ceo', 'running', setup.sessionName);
  const journal = new Journal(runningDir);

  const privacy = new PrivacyManager(agentManager);
  const tokenTracker = new TokenTracker(agentManager, paneManager);
  const tagManager = new TagManager(session);

  // Journal session IDs for agents that have them (at spawn time)
  if (!setup.isRecovery) {
    for (const [name] of agentManager.agents) {
      const sid = agentManager.getSessionId(name);
      if (sid && journal) {
        journal.append({ type: 'agent_session', agent: name, sessionId: sid });
      }
    }
  }

  // ── Restore saved session if resuming ────────────────
  const resumeSession = setup.originalArgs.session;
  if (resumeSession) {
    session.setName(resumeSession);
    const savedState = SessionManager.loadState(resumeSession);
    if (savedState) {
      // Restore full state: chatLog, tags, files, inboxes, groups, names
      session.restoreState(savedState);

      if (savedState.inboxes) {
        inboxManager.restore(savedState.inboxes);
      }

      if (savedState.agents) {
        // Restore custom names
        if (savedState.agents.agents) {
          for (const [name, agentState] of Object.entries(savedState.agents.agents)) {
            const agent = agentManager.agents.get(name);
            if (agent && agentState.customName) {
              agent.customName = agentState.customName;
            }
          }
        }
        // Restore custom groups
        if (savedState.agents.groups) {
          for (const [gName, members] of Object.entries(savedState.agents.groups)) {
            agentManager.groups.set(gName, members);
          }
        }
      }

      // Note: paneOffsets are NOT restored here. Resume creates fresh agent
      // panes with truncated log files (size 0), so saved offsets would point
      // past EOF and break capture. Fresh panes start at offset 0 which is correct.

      // Restore privacy state (transparent flags, write modes, DM logs)
      if (savedState.privacy) {
        privacy.restore(savedState.privacy);
      }

      console.log(`  Restored session: ${resumeSession} (${savedState.messageCount || 0} messages)`);
    }

    // Feed summary to agents as context
    const summary = SessionManager.loadSummary(resumeSession);
    if (summary) {
      for (const [name] of agentManager.agents) {
        inboxManager.pushTo(name, 'system',
          `[Previous session summary]\n${summary}\n[End of summary — new session started]`);
      }
    }
  }

  // Native session IDs are now set in launchInTmux (before pane creation)
  // and passed through setup.agents[name].sessionId — no late restore needed.

  // ── Restore chatroom state from journal on recovery ──
  if (setup.isRecovery) {
    const snapshot = journal.loadSnapshot();
    const recoveryEvents = snapshot ? journal.replay(snapshot.seq) : journal.replay();

    // Restore from snapshot first
    if (snapshot) {
      if (snapshot.inboxes) inboxManager.restore(snapshot.inboxes);
      if (snapshot.tags) session.tags = snapshot.tags;
      if (snapshot.filesReferenced) session.filesReferenced = new Set(snapshot.filesReferenced);
      if (snapshot.chatLogTail) session.chatLog = snapshot.chatLogTail;
      if (snapshot.privacy) privacy.restore(snapshot.privacy);
      if (snapshot.agents && snapshot.agents.agents) {
        for (const [name, agentState] of Object.entries(snapshot.agents.agents)) {
          const agent = agentManager.agents.get(name);
          if (agent) {
            if (agentState.customName) agent.customName = agentState.customName;
            if (agentState.sessionId) agent.sessionId = agentState.sessionId;
          }
        }
      }
    }

    // Replay journal events after snapshot
    const msgsBySeq = new Map();
    for (const e of recoveryEvents) {
      if (e.type === 'msg') {
        session.chatLog.push({ from: e.from, text: e.text, timestamp: new Date(e.t).toISOString(), tags: [] });
        msgsBySeq.set(e.seq, e);
      } else if (e.type === 'agent_session') {
        const agent = agentManager.agents.get(e.agent);
        if (agent) agent.sessionId = e.sessionId;
      } else if (e.type === 'inbox_route') {
        const msg = msgsBySeq.get(e.msgSeq);
        if (msg) {
          for (const agentName of e.to) {
            inboxManager.pushTo(agentName, msg.from, msg.text);
          }
        }
      } else if (e.type === 'inbox_flush') {
        inboxManager.flush(e.agent);
      } else if (e.type === 'inbox_clear') {
        inboxManager.clear(e.agent);
      } else if (e.type === 'tag_add') {
        session.tags.push({ tag: e.tag, text: e.text, timestamp: new Date(e.t).toISOString(), index: session.chatLog.length - 1 });
      } else if (e.type === 'pin_add') {
        session.addFileReference(e.path);
      } else if (e.type === 'pin_remove') {
        session.filesReferenced.delete(e.path);
      } else if (e.type === 'session_name') {
        session.setName(e.name);
      } else if (e.type === 'group_create') {
        agentManager.groups.set(e.group, e.members);
      } else if (e.type === 'group_remove') {
        agentManager.groups.delete(e.group);
      }
      // mode_change, codex_marker_sent, auto_* handled by their respective modules
    }

    console.log(`  Restored: ${session.chatLog.length} messages from journal`);
  }

  // ── Wait for agents to initialize (or check status on recovery) ──
  if (setup.isRecovery) {
    const { printSystem, printWarning } = require('./display');
    console.log('  Agent status:');
    for (const [name] of agentManager.agents) {
      if (paneManager.isPaneDead(name)) {
        agentManager.setStatus(name, 'dead');
        printWarning(`  ${name}: dead (pane gone) — /revive ${name}`);
        continue;
      }

      // Check if agent shows a prompt pattern
      try {
        const pane = paneManager.panes.get(name);
        const provider = require(`./providers/${pane.provider.name || pane.provider}`);
        if (fs.existsSync(pane.logFile)) {
          const content = fs.readFileSync(pane.logFile, 'utf-8');
          const lastLines = content.split('\n').slice(-5).join('\n');
          if (provider.promptPattern && provider.promptPattern.test(lastLines)) {
            agentManager.setStatus(name, 'idle');
            printSystem(`  ${name}: idle (prompt detected)`);
          } else {
            agentManager.setStatus(name, 'running');
            printWarning(`  ${name}: busy (no prompt) — /focus ${name} to inspect`);
          }
        } else {
          agentManager.setStatus(name, 'idle');
        }
      } catch {
        agentManager.setStatus(name, 'idle');
      }
    }
    console.log();
  } else {
    const providers = [...new Set(Object.values(setup.agents).map(a => a.provider))];
    const maxDelay = Math.max(...providers.map(p => {
      try { return require(`./providers/${p}`).startupDelay; } catch { return 3000; }
    }));
    console.log(`  Waiting ${maxDelay / 1000}s for agents to initialize...\n`);
    await new Promise(resolve => setTimeout(resolve, maxDelay));

    // Mark all agents as idle
    for (const [name] of agentManager.agents) {
      agentManager.setStatus(name, 'idle');
    }
  }

  // ── Start the chatroom REPL ──────────────────────────
  const chatroom = new Chatroom(agentManager, inboxManager, paneManager, capture, session, {
    tokenTracker,
    tagManager,
    privacy,
    journal,
    runningDir,
  });

  const workflows = new WorkflowManager(
    agentManager, inboxManager, paneManager, capture, session, chatroom
  );
  chatroom.workflows = workflows;

  // Release lock before tmux is destroyed (destroySession kills our pane)
  chatroom.onShutdown = releaseLock;

  // Route Ctrl+C / SIGTERM to chatroom.shutdown() for clean save + tmux cleanup
  process.on('SIGINT', () => chatroom.shutdown());
  process.on('SIGTERM', () => chatroom.shutdown());

  chatroom.start();
}

// ═══════════════════════════════════════════════════════════
// Recovery — respawn chatroom in pane 0 of existing session
// ═══════════════════════════════════════════════════════════

function recoverChatroom(sessionInfo) {
  const { RUNNING_DIR } = require('./menu');
  const sessionName = sessionInfo.sessionName;

  console.log(`\n  Recovering chatroom for session: ${sessionName}...\n`);

  // Get pane 0
  let pane0;
  try {
    pane0 = execSync(
      `tmux list-panes -t "${sessionName}" -F "#{pane_id}" | head -1`,
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();
  } catch (e) {
    console.error(`  Failed to find pane 0: ${e.message}`);
    process.exit(1);
  }

  // Discover agent panes by title
  const agents = {};
  const sessionLogDir = path.join('/tmp/agent-ceo', sessionName);
  try {
    const output = execSync(
      `tmux list-panes -t "${sessionName}" -F "#{pane_id} #{pane_title}" 2>/dev/null`,
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();

    for (const line of output.split('\n')) {
      const parts = line.trim().split(' ');
      const paneId = parts[0];
      const title = parts.slice(1).join(' ');
      if (title && title !== 'chatroom' && title !== '' && paneId !== pane0) {
        const providerMatch = title.match(/^([a-z]+)\d+$/);
        const provider = providerMatch ? providerMatch[1] : 'unknown';
        const logFile = path.join(sessionLogDir, `${title}.log`);
        agents[title] = { paneId, logFile, provider };
      }
    }
  } catch { /* ignore */ }

  console.log(`  Found ${Object.keys(agents).length} agent pane(s)`);

  // Re-enable pipe-pane for each agent (in case it stopped)
  for (const [name, info] of Object.entries(agents)) {
    try {
      execSync(`tmux pipe-pane -o -t ${info.paneId} "cat >> ${info.logFile}" 2>/dev/null`);
    } catch { /* ignore */ }
  }

  // Build setup state for the chatroom process
  const setupState = {
    sessionName,
    pane0,
    agents,
    sessionLogDir,
    isRecovery: true,
    originalArgs: { agents: null, session: null, resume: false },
  };

  const setupFile = setupFileFor(sessionName);
  fs.writeFileSync(setupFile, JSON.stringify(setupState));

  // Respawn pane 0 with chatroom
  const scriptPath = path.resolve(__dirname, '../bin/agent-ceo');
  const chatCmd = `node "${scriptPath}" --_chatroom "${sessionName}"`;
  try {
    execFileSync('tmux', ['respawn-pane', '-k', '-t', pane0, chatCmd]);
  } catch {
    // Fallback: send-keys
    execFileSync('tmux', ['send-keys', '-t', pane0, '-l', chatCmd]);
    execFileSync('tmux', ['send-keys', '-t', pane0, 'Enter']);
  }

  console.log('  Chatroom respawned. Attaching...\n');
  attachToSession(sessionName);
}

// ═══════════════════════════════════════════════════════════
// Recovery — VPS reboot: tmux gone, running dir still has
// journal + snapshots.  Rebuild tmux session from scratch,
// resume native agent sessions where possible.
// ═══════════════════════════════════════════════════════════

async function recoverFromReboot(sessionInfo) {
  const { RUNNING_DIR, writeMeta, readMeta } = require('./menu');
  const { printSystem, printWarning } = require('./display');

  const originalName = sessionInfo.sessionName;
  const runningDir = path.join(RUNNING_DIR, originalName);
  console.log(`\n  Recovering from VPS reboot: ${sessionInfo.label}...\n`);

  // Load meta for team composition
  const meta = readMeta(runningDir);
  if (!meta || !meta.team) {
    console.error('  Cannot recover: no team information in meta.json');
    process.exit(1);
  }

  // Load journal + snapshot for session IDs
  const journal = new Journal(runningDir);
  const snapshot = journal.loadSnapshot();
  const events = snapshot ? journal.replay(snapshot.seq) : journal.replay();

  // Collect session IDs
  const sessionIds = {};
  // From snapshot
  if (snapshot && snapshot.agents && snapshot.agents.agents) {
    for (const [name, agent] of Object.entries(snapshot.agents.agents)) {
      if (agent.sessionId) sessionIds[name] = agent.sessionId;
    }
  }
  // Override with newer journal events
  for (const e of events) {
    if (e.type === 'agent_session') {
      sessionIds[e.agent] = e.sessionId;
    }
  }

  // Build agent list
  const agentList = Object.entries(meta.team).map(([name, provider]) => ({
    name,
    provider,
    sessionId: sessionIds[name] || null,
  }));

  console.log(`  Team: ${agentList.map(a => `${a.name}${a.sessionId ? ' (native)' : ''}`).join(', ')}`);

  // Allocate a new tmux session name
  const sessionName = allocateSessionName();

  // Rename running dir if session name changed (maintain dir==tmux invariant)
  let actualRunningDir = runningDir;
  if (sessionName !== originalName) {
    const newRunningDir = path.join(RUNNING_DIR, sessionName);
    try {
      // allocateSessionName created an empty dir — remove it before rename
      fs.rmdirSync(newRunningDir);
      fs.renameSync(runningDir, newRunningDir);
      actualRunningDir = newRunningDir;
    } catch (e) {
      console.error(`  Failed to rename running dir: ${e.message}`);
      // Continue with original dir
    }
  }

  // Create tmux session
  execSync(`tmux new-session -d -s ${sessionName} -x 200 -y 50`);
  try {
    execSync(`tmux set-option -t ${sessionName} -g mouse on 2>/dev/null`);
    execSync(`tmux set-option -t ${sessionName} pane-border-status top 2>/dev/null`);
    execSync(`tmux set-option -t ${sessionName} pane-border-format " #{pane_title} " 2>/dev/null`);
    execSync(`tmux set-option -t ${sessionName} @agent_ceo 1 2>/dev/null`);
  } catch { /* older tmux */ }

  const pane0 = execSync(
    `tmux list-panes -t ${sessionName} -F "#{pane_id}" | head -1`
  ).toString().trim();

  try {
    execSync(`tmux select-pane -t ${pane0} -T "chatroom" 2>/dev/null`);
  } catch { /* ignore */ }

  // Create agent panes with native resume
  const sessionLogDir = path.join('/tmp/agent-ceo', sessionName);
  fs.mkdirSync(sessionLogDir, { recursive: true });

  const agentPanes = {};
  const projectDir = meta.projectDir || process.cwd();

  for (const { name, provider: providerName, sessionId } of agentList) {
    let provider;
    try {
      provider = require(`./providers/${providerName}`);
    } catch {
      printWarning(`  ${name}: provider ${providerName} not available — skipping`);
      continue;
    }

    if (!provider.detect()) {
      printWarning(`  ${name}: ${providerName} CLI not installed — marking unavailable`);
      agentPanes[name] = { paneId: null, logFile: null, provider: providerName, sessionId, unavailable: true };
      continue;
    }

    const logFile = path.join(sessionLogDir, `${name}.log`);
    fs.writeFileSync(logFile, '');

    const cdFlag = projectDir ? `-c "${projectDir}"` : '';
    const paneId = execSync(
      `tmux split-window -t ${sessionName} ${cdFlag} -P -F "#{pane_id}"`
    ).toString().trim();

    try {
      execSync(`tmux select-pane -t ${paneId} -T "${name}" 2>/dev/null`);
    } catch { /* ignore */ }

    execSync(`tmux pipe-pane -t ${paneId} "cat >> ${logFile}"`);

    // Use native resume args if sessionId exists, else fresh start
    let cliArgs;
    if (sessionId && provider.getResumeArgs) {
      cliArgs = provider.getResumeArgs(sessionId);
      printSystem(`  ${name}: resuming native session ${sessionId.substring(0, 8)}...`);
    } else {
      const newId = provider.generateSessionId ? provider.generateSessionId() : null;
      cliArgs = provider.getStartArgs ? provider.getStartArgs(newId) : provider.startArgs;
      if (newId) printSystem(`  ${name}: fresh session ${newId.substring(0, 8)}...`);
      else printSystem(`  ${name}: fresh session`);
      // Store the new ID
      agentPanes[name] = { paneId, logFile, provider: providerName, sessionId: newId };
    }

    const cmd = `${provider.command} ${cliArgs.join(' ')}`.trim();
    execFileSync('tmux', ['send-keys', '-t', paneId, '-l', cmd]);
    execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter']);

    if (!agentPanes[name]) {
      agentPanes[name] = { paneId, logFile, provider: providerName, sessionId };
    }
  }

  // Arrange layout
  try {
    execSync(`tmux select-layout -t ${sessionName} tiled 2>/dev/null`);
  } catch { /* ignore */ }

  // Update meta
  writeMeta(actualRunningDir, {
    ...meta,
    lastActive: new Date().toISOString(),
  });

  // Write setup state for chatroom (with isRecovery flag)
  const setupState = {
    sessionName,
    sessionLogDir,
    pane0,
    agents: agentPanes,
    isRecovery: true,
    originalArgs: { agents: null, session: null, resume: false, native: false },
  };
  const setupFile = setupFileFor(sessionName);
  fs.writeFileSync(setupFile, JSON.stringify(setupState));

  // Start chatroom in pane 0
  const scriptPath = path.resolve(__dirname, '../bin/agent-ceo');
  const chatCmd = `node "${scriptPath}" --_chatroom "${sessionName}"`;
  execFileSync('tmux', ['send-keys', '-t', pane0, '-l', chatCmd]);
  execFileSync('tmux', ['send-keys', '-t', pane0, 'Enter']);

  try {
    execSync(`tmux select-pane -t ${pane0} 2>/dev/null`);
  } catch { /* ignore */ }

  console.log('\n  Recovery complete. Attaching...\n');
  attachToSession(sessionName);
}

// ═══════════════════════════════════════════════════════════
// Create new session (prompts + launch)
// ═══════════════════════════════════════════════════════════

async function createNewSession(args) {
  const { prompt, detectProjectDir, detectGitRepoName, buildSessionLabel } = require('./menu');

  // Dependency checks
  const deps = checkDependencies();
  if (deps.length > 0) {
    console.error('\nMissing dependencies:');
    deps.forEach(d => console.error(`  ❌ ${d}`));
    console.error('\nRun `agent-ceo setup` for details.\n');
    process.exit(1);
  }

  // Session name prompt (skip if --name provided)
  let sessionLabel = args.name || null;
  if (!sessionLabel && process.stdin.isTTY) {
    const answer = await prompt('\n  Session name (Enter to skip): ');
    if (answer) sessionLabel = answer;
  }

  // Project dir (skip if --cd provided)
  let projectDir = args.cd || null;
  if (!projectDir) {
    const defaultDir = detectProjectDir(process.cwd());
    if (process.stdin.isTTY) {
      const answer = await prompt(`  Project dir [${defaultDir}]: `);
      projectDir = answer || defaultDir;
    } else {
      projectDir = defaultDir;
    }
  }

  // Team composition
  let agentSpec = args.agents;
  if (!agentSpec) {
    // Load per-project defaults
    const Config = require('./config');
    const baseDir = path.join(require('os').homedir(), '.agent-ceo');
    const defaults = Config.loadDefaults(baseDir);
    const projectDefaults = defaults[projectDir] || { claude: 2, codex: 2 };

    if (process.stdin.isTTY) {
      agentSpec = {};
      // Dynamic provider discovery
      const providersDir = path.join(__dirname, 'providers');
      const providerFiles = fs.readdirSync(providersDir).filter(f => f !== 'template.js' && f.endsWith('.js'));

      // Sort by config.providersOrder
      const Config = require('./config');
      const baseDir = path.join(require('os').homedir(), '.agent-ceo');
      const config = Config.load(baseDir);
      const order = config.providersOrder || ['claude', 'codex'];

      providerFiles.sort((a, b) => {
        const nameA = a.replace('.js', '');
        const nameB = b.replace('.js', '');
        const idxA = order.indexOf(nameA);
        const idxB = order.indexOf(nameB);
        const posA = idxA >= 0 ? idxA : order.length;
        const posB = idxB >= 0 ? idxB : order.length;
        if (posA !== posB) return posA - posB;
        return nameA.localeCompare(nameB); // alphabetical tie-break
      });

      for (const file of providerFiles) {
        const provider = require(path.join(providersDir, file));
        const name = provider.name;
        const defaultCount = projectDefaults[name] || 0;
        const installed = provider.detect();

        if (!installed) {
          console.log(`  ${name} agents [${defaultCount}]: ${require('./display').C.dim}(not installed)${require('./display').C.reset}`);
          continue;
        }

        const answer = await prompt(`  ${name} agents [${defaultCount}]: `);
        const count = answer ? parseInt(answer, 10) : defaultCount;
        if (count > 0) agentSpec[name] = count;
      }
    } else {
      agentSpec = projectDefaults;
    }

    // Save as new defaults for this project
    if (Object.keys(agentSpec).length > 0) {
      const Config = require('./config');
      const baseDir = path.join(require('os').homedir(), '.agent-ceo');
      Config.saveDefaults(baseDir, projectDir, agentSpec);
    }
  }

  // Build final label
  const gitRepoName = detectGitRepoName(projectDir);
  const label = buildSessionLabel({ customName: sessionLabel, projectDir, gitRepoName });

  // Launch
  launchInTmux({ ...args, agents: agentSpec, projectDir, sessionLabel: label });
}

// ═══════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) { printHelp(); process.exit(0); }
  if (args.setup) { runSetup(); process.exit(0); }

  // Internal mode (pane 0)
  if (args._chatroom) {
    await runChatroom(args._chatroomId);
    return;
  }

  // Load config (early, so parse errors are caught before any menu logic)
  const Config = require('./config');
  const baseDir = path.join(require('os').homedir(), '.agent-ceo');
  let config;
  try {
    config = Config.load(baseDir);
  } catch (e) {
    if (e.code === 'CONFIG_PARSE_ERROR') {
      if (process.stdin.isTTY) {
        const { prompt } = require('./menu');
        console.error(`\n  Config file is invalid JSON: ${e.filePath}`);
        console.error(`  ${e.cause.message}\n`);
        const answer = await prompt('  [E]dit path  |  [R]eset to defaults  |  [Q]uit\n  > ');
        const choice = (answer || 'q').toLowerCase();
        if (choice === 'r') {
          Config.resetConfig(baseDir);
          console.log('  Config reset to defaults.\n');
          config = Config.load(baseDir);
        } else if (choice === 'e') {
          console.log(`\n  Edit this file: ${e.filePath}\n`);
          process.exit(1);
        } else {
          process.exit(1);
        }
      } else {
        console.error(`Config parse error: ${e.filePath}`);
        console.error(e.cause.message);
        process.exit(1);
      }
    } else {
      throw e;
    }
  }

  // Direct attach
  if (args.attach) {
    const { buildActiveSessionInfo, RUNNING_DIR } = require('./menu');

    // Only check for recovery if this is an agent-ceo session
    let isAgentCeo = false;
    try {
      const tagged = execSync(
        `tmux show-option -t "${args.attach}" -v @agent_ceo 2>/dev/null`,
        { stdio: ['ignore', 'pipe', 'ignore'] }
      ).toString().trim();
      if (tagged === '1') isAgentCeo = true;
    } catch { /* not tagged */ }

    if (!isAgentCeo) {
      // Check running dir fallback — must have meta.json to be a real agent-ceo session
      isAgentCeo = fs.existsSync(path.join(RUNNING_DIR, args.attach, 'meta.json'));
    }

    if (isAgentCeo) {
      try {
        const info = buildActiveSessionInfo(args.attach);
        if (!info.chatroomAlive) {
          console.log(`  Session ${args.attach} has chatroom down. Recovering...`);
          recoverChatroom(info);
          return;
        }
      } catch { /* ignore */ }
    }

    attachToSession(args.attach);
    return;
  }

  // --resume: list saved sessions and exit
  if (args.resume && !args.session) {
    const SessionManager = require('./session');
    const sessions = SessionManager.listSessions();
    if (sessions.length === 0) {
      console.log('No saved sessions found.');
      process.exit(0);
    }
    console.log('\nSaved sessions:');
    sessions.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.name} (${s.messageCount} messages, saved ${new Date(s.savedAt).toLocaleString()})`);
    });
    console.log('\nRun: agent-ceo --session <name> to resume.\n');
    process.exit(0);
  }

  // --session: direct resume (skip menu)
  if (args.session) {
    await createNewSession(args);
    return;
  }

  // Non-interactive check
  if (!process.stdin.isTTY && !args.new) {
    console.error('No TTY detected. Use --new or --attach <session> for non-interactive mode.');
    process.exit(1);
  }

  // Import menu utilities
  const { discoverActiveSessions, discoverRecoverableSessions, prompt } = require('./menu');

  // Discover sessions
  const activeSessions = discoverActiveSessions();
  const recoverableSessions = discoverRecoverableSessions();
  const savedSessions = SessionManager.listSessions();

  // If --new, skip menu
  if (args.new) {
    await createNewSession(args);
    return;
  }

  // If nothing exists, go straight to new session
  if (activeSessions.length === 0 && recoverableSessions.length === 0 && savedSessions.length === 0) {
    await createNewSession(args);
    return;
  }

  // Show menu
  const { C } = require('./display');
  console.log();

  const options = [];
  let idx = 1;

  if (activeSessions.length > 0) {
    console.log(`${C.bold}  Active sessions:${C.reset}`);
    for (const s of activeSessions) {
      const status = s.chatroomAlive ? '' : `  ${C.red}⚠ chatroom down${C.reset}`;
      const teamCounts = s.team ? Object.values(s.team).reduce((m, p) => { m[p] = (m[p]||0)+1; return m; }, {}) : null;
      const teamStr = teamCounts ? ` (${Object.entries(teamCounts).map(([p,c]) => `${c}x ${p}`).join(', ')})` : '';
      console.log(`    ${C.bold}${idx}.${C.reset} ${s.sessionName}${teamStr} — ${s.label}${status}`);
      if (s.projectDir) console.log(`       ${C.dim}${s.projectDir}${C.reset}`);
      options.push({ key: String(idx), type: s.chatroomAlive ? 'join' : 'recover', data: s });
      idx++;
    }
    console.log();
  }

  if (recoverableSessions.length > 0) {
    console.log(`${C.bold}  ${C.yellow}⚠ Recoverable (tmux lost):${C.reset}`);
    for (const s of recoverableSessions) {
      const lastActive = s.lastActive ? new Date(s.lastActive).toLocaleString() : 'unknown';
      console.log(`    ${C.bold}${idx}.${C.reset} ${s.sessionName} — ${s.label} (last active ${lastActive})`);
      options.push({ key: String(idx), type: 'recover_tmux_lost', data: s });
      idx++;
    }
    console.log();
  }

  if (activeSessions.length === 0 && savedSessions.length > 0) {
    console.log(`${C.bold}  Saved sessions:${C.reset}`);
    for (const s of savedSessions) {
      const saved = s.savedAt ? new Date(s.savedAt).toLocaleString() : 'unknown';
      console.log(`    ${C.bold}${idx}.${C.reset} ${s.name} (${s.messageCount} messages, saved ${saved})`);
      options.push({ key: String(idx), type: 'resume', data: s });
      idx++;
    }
    console.log();
  }

  // Prompt
  const choices = [];
  if (options.length > 0) choices.push(`[1-${options.length}] Select`);
  choices.push('[N] New');
  if (activeSessions.length > 0 && savedSessions.length > 0) choices.push('[R] Resume saved...');
  choices.push('[Q] Quit');

  const answer = await prompt(`  ${choices.join('  |  ')}\n\n  > `);
  const input = (answer || '1').toLowerCase();

  if (input === 'q') { process.exit(0); }
  if (input === 'n') { await createNewSession(args); return; }

  if (input === 'r') {
    // Show saved sessions sub-menu
    const SessionManager = require('./session');
    const saved = SessionManager.listSessions();
    if (saved.length === 0) {
      console.log('\n  No saved sessions found.\n');
      // Re-show menu... or just prompt for new
      await createNewSession(args);
      return;
    }
    console.log(`\n${C.bold}  Saved sessions:${C.reset}`);
    saved.forEach((s, i) => {
      const savedAt = s.savedAt ? new Date(s.savedAt).toLocaleString() : 'unknown';
      console.log(`    ${i + 1}. ${s.name} (${s.messageCount} messages, saved ${savedAt})`);
    });
    const savedAnswer = await prompt(`\n  [1-${saved.length}] Resume  |  [B] Back\n\n  > `);
    if (savedAnswer.toLowerCase() === 'b') {
      // User wants to go back — just exit, they can re-run
      process.exit(0);
    }
    const savedIdx = parseInt(savedAnswer, 10) - 1;
    if (savedIdx >= 0 && savedIdx < saved.length) {
      args.session = saved[savedIdx].name;
      await createNewSession(args);
    }
    return;
  }

  // Numeric selection
  const selected = options.find(o => o.key === input);
  if (selected) {
    if (selected.type === 'join') {
      attachToSession(selected.data.sessionName);
    } else if (selected.type === 'recover') {
      console.log(`\n  Session ${selected.data.sessionName} has chatroom down.`);
      const recAnswer = await prompt('  [R] Recover chatroom (default)  |  [T] Attach to tmux only\n  > ');
      if (recAnswer.toLowerCase() === 't') {
        attachToSession(selected.data.sessionName);
      } else {
        recoverChatroom(selected.data);
      }
    } else if (selected.type === 'resume') {
      args.session = selected.data.name;
      await createNewSession(args);
    } else if (selected.type === 'recover_tmux_lost') {
      await recoverFromReboot(selected.data);
    }
    return;
  }

  // Default: first option or new
  if (options.length > 0) {
    attachToSession(options[0].data.sessionName);
  } else {
    await createNewSession(args);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  releaseLock();
  process.exit(1);
});
