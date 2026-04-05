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
    agents: { claude: 2, codex: 2 },
    resume: false,
    session: null,
    setup: false,
    help: false,
    _chatroom: false,
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
  if (nodeVersion < 18) {
    issues.push(`Node.js 18+ required. You have ${process.version}`);
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
  return path.join(LOG_DIR, `lock-${sessionName}`);
}

let _activeLockFile = null;

function acquireLock(sessionName) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  const lockFile = lockFileFor(sessionName);

  if (fs.existsSync(lockFile)) {
    try {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      process.kill(pid, 0); // throws if dead
      return false;
    } catch {
      fs.unlinkSync(lockFile); // stale lock
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
    agent-ceo                             Start with default team (2 claude + 2 codex)
    agent-ceo --agents claude:3,codex:1   Custom team composition
    agent-ceo --resume                    List previous sessions
    agent-ceo --session <name>            Resume a specific session
    agent-ceo setup                       Check dependencies
    agent-ceo --help                      Show this help

  Inside the chatroom:
    @agent message      Send to one agent
    @all message        All agents respond
    @claudes message    Send to all Claude instances
    @agent:dm msg       Private DM
    /help               Full command reference
    /quit               Exit
`);
}

// ═══════════════════════════════════════════════════════════
// MODE 1: External — create tmux session, spawn agents,
//         launch chatroom in pane 0, then attach.
// ═══════════════════════════════════════════════════════════

function findAvailableSessionName() {
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

function launchInTmux(args) {
  // Dependency checks
  const deps = checkDependencies();
  if (deps.length > 0) {
    console.error('\nMissing dependencies:');
    deps.forEach(d => console.error(`  ❌ ${d}`));
    console.error('\nRun `agent-ceo setup` for details.\n');
    process.exit(1);
  }

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
    for (const [providerName, count] of Object.entries(args.agents)) {
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
  let sessionName;
  try {
    execSync(`tmux has-session -t ${SESSION_NAME} 2>/dev/null`);
    sessionName = findAvailableSessionName();
  } catch {
    sessionName = SESSION_NAME;
  }

  execSync(`tmux new-session -d -s ${sessionName} -x 200 -y 50`);
  try {
    execSync(`tmux set-option -t ${sessionName} -g mouse on 2>/dev/null`);
    execSync(`tmux set-option -t ${sessionName} pane-border-status top 2>/dev/null`);
    execSync(`tmux set-option -t ${sessionName} pane-border-format " #{pane_title} " 2>/dev/null`);
  } catch { /* older tmux */ }

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

  const agentPanes = {};

  for (const { name, provider: providerName } of agentList) {
    const provider = require(`./providers/${providerName}`);
    const logFile = path.join(sessionLogDir, `${name}.log`);
    fs.writeFileSync(logFile, '');

    console.log(`  Spawning ${name}...`);

    // Create pane with default shell (interactive, accepts send-keys)
    const paneId = execSync(
      `tmux split-window -t ${sessionName} -P -F "#{pane_id}"`
    ).toString().trim();

    // Set pane title
    try {
      execSync(`tmux select-pane -t ${paneId} -T "${name}" 2>/dev/null`);
    } catch { /* ignore */ }

    // Start logging BEFORE starting the CLI
    execSync(`tmux pipe-pane -t ${paneId} "cat >> ${logFile}"`);

    // Start the agent CLI (shell is ready for input)
    const cmd = `${provider.command} ${provider.startArgs.join(' ')}`.trim();
    execFileSync('tmux', ['send-keys', '-t', paneId, '-l', cmd]);
    execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter']);

    agentPanes[name] = { paneId, logFile, provider: providerName };
    console.log(`  ✅ ${name} launched`);
  }

  // Arrange layout
  try {
    execSync(`tmux select-layout -t ${sessionName} tiled 2>/dev/null`);
  } catch { /* ignore */ }

  // ── Create persistent running directory for journal ──
  const runningDir = path.join(require('os').homedir(), '.agent-ceo', 'running', sessionName);
  fs.mkdirSync(runningDir, { recursive: true });

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
  spawnSync('tmux', ['attach-session', '-t', sessionName], { stdio: 'inherit' });
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

  // ── Wait for agents to initialize ────────────────────
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

  // ── Start the chatroom REPL ──────────────────────────
  const chatroom = new Chatroom(agentManager, inboxManager, paneManager, capture, session, {
    tokenTracker,
    tagManager,
    privacy,
    journal,
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
// Main
// ═══════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.setup) {
    runSetup();
    process.exit(0);
  }

  // Internal mode — we are inside tmux pane 0
  if (args._chatroom) {
    await runChatroom(args._chatroomId);
    return;
  }

  // List saved sessions
  if (args.resume && !args.session) {
    const sessions = SessionManager.listSessions();
    if (sessions.length === 0) {
      console.log('No previous sessions found.');
      process.exit(0);
    }
    console.log('\nPrevious sessions:');
    sessions.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.name} (${s.messageCount} messages, saved ${new Date(s.savedAt).toLocaleString()})`);
    });
    console.log('\nRun: agent-ceo --session <name> to resume.\n');
    process.exit(0);
  }

  // Normal startup: create tmux, launch agents, attach
  launchInTmux(args);
}

main().catch(err => {
  console.error('Fatal error:', err);
  releaseLock();
  process.exit(1);
});
