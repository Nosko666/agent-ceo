// src/menu.js
// ─────────────────────────────────────────────────────────
// Interactive startup menu + session discovery
// ─────────────────────────────────────────────────────────
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const BASE_DIR = path.join(os.homedir(), '.agent-ceo');
const RUNNING_DIR = path.join(BASE_DIR, 'running');
const SESSIONS_DIR = path.join(BASE_DIR, 'sessions');

// ── Project directory detection ─────────────────────────

function detectProjectDir(cwd) {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return root;
  } catch {
    return cwd;
  }
}

function detectGitRepoName(projectDir) {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return path.basename(root);
  } catch {
    return null;
  }
}

function buildSessionLabel({ customName, projectDir, gitRepoName }) {
  if (customName) return customName;
  if (gitRepoName) return gitRepoName;
  return path.basename(projectDir);
}

// ── Session discovery ───────────────────────────────────

function discoverActiveSessions() {
  const sessions = [];

  try {
    const output = execSync(
      'tmux list-sessions -F "#{session_name}" 2>/dev/null',
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();

    if (output) {
      for (const sessionName of output.split('\n')) {
        let isAgentCeo = false;

        // Check @agent_ceo tag
        try {
          const tagged = execSync(
            `tmux show-option -t "${sessionName}" -v @agent_ceo 2>/dev/null`,
            { stdio: ['ignore', 'pipe', 'ignore'] }
          ).toString().trim();
          if (tagged === '1') isAgentCeo = true;
        } catch { /* not tagged */ }

        // Fallback: check running dir
        if (!isAgentCeo) {
          const runningPath = path.join(RUNNING_DIR, sessionName);
          if (fs.existsSync(runningPath)) isAgentCeo = true;
        }

        if (isAgentCeo) {
          sessions.push(buildActiveSessionInfo(sessionName));
        }
      }
    }
  } catch { /* no tmux server */ }

  // Sort by lastActive descending
  sessions.sort((a, b) => {
    const ta = a.lastActive ? new Date(a.lastActive).getTime() : 0;
    const tb = b.lastActive ? new Date(b.lastActive).getTime() : 0;
    return tb - ta;
  });

  return sessions;
}

function buildActiveSessionInfo(sessionName) {
  const metaDir = path.join(RUNNING_DIR, sessionName);
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(metaDir, 'meta.json'), 'utf-8'));
  } catch { /* no meta */ }

  // Chatroom alive check: lock PID + pane 0 command
  let chatroomAlive = false;
  const lockPath = path.join(metaDir, 'lock');
  try {
    if (fs.existsSync(lockPath)) {
      const pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
      process.kill(pid, 0); // throws if dead
      // Verify pane 0 is running node
      try {
        const paneCmd = execSync(
          `tmux display-message -t "${sessionName}:0.0" -p '#{pane_current_command}' 2>/dev/null`,
          { stdio: ['ignore', 'pipe', 'ignore'] }
        ).toString().trim();
        chatroomAlive = (paneCmd === 'node');
      } catch {
        chatroomAlive = true; // can't check pane, trust PID
      }
    }
  } catch { /* pid dead */ }

  return {
    sessionName,
    label: meta.label || sessionName,
    team: meta.team || null,
    projectDir: meta.projectDir || null,
    lastActive: meta.lastActive || null,
    chatroomAlive,
    autoJob: meta.autoJob || null,
  };
}

function discoverRecoverableSessions() {
  const recoverable = [];
  if (!fs.existsSync(RUNNING_DIR)) return recoverable;

  // Get active tmux sessions
  const tmuxSessions = new Set();
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null',
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (output) output.split('\n').forEach(s => tmuxSessions.add(s));
  } catch { /* no tmux */ }

  for (const dirName of fs.readdirSync(RUNNING_DIR)) {
    if (tmuxSessions.has(dirName)) continue;
    const dirPath = path.join(RUNNING_DIR, dirName);
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue;
    } catch { continue; }

    const hasJournal = fs.existsSync(path.join(dirPath, 'journal.ndjson'));
    const hasMeta = fs.existsSync(path.join(dirPath, 'meta.json'));
    const hasSnapshot = fs.existsSync(path.join(dirPath, 'snapshot.json'));

    if (hasJournal || hasMeta || hasSnapshot) {
      let meta = {};
      if (hasMeta) {
        try { meta = JSON.parse(fs.readFileSync(path.join(dirPath, 'meta.json'), 'utf-8')); }
        catch { /* corrupt meta */ }
      }
      recoverable.push({
        sessionName: dirName,
        label: meta.label || dirName,
        projectDir: meta.projectDir || null,
        lastActive: meta.lastActive || null,
      });
    } else {
      // Empty/stale dir — clean up
      try { fs.rmSync(dirPath, { recursive: true }); } catch { /* ignore */ }
    }
  }

  return recoverable;
}

// ── Readline prompt helper ──────────────────────────────

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Meta.json management ────────────────────────────────

function writeMeta(dir, meta) {
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, 'meta.json.tmp');
  const metaPath = path.join(dir, 'meta.json');
  fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 2));
  fs.renameSync(tmpPath, metaPath);
}

function readMeta(dir) {
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')); }
  catch { return null; }
}

module.exports = {
  detectProjectDir,
  detectGitRepoName,
  buildSessionLabel,
  discoverActiveSessions,
  discoverRecoverableSessions,
  buildActiveSessionInfo,
  prompt,
  writeMeta,
  readMeta,
  BASE_DIR,
  RUNNING_DIR,
  SESSIONS_DIR,
};
