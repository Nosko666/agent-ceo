const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Skip integration tests if tmux is not available OR not usable (restricted env)
let tmuxAvailable = false;
try {
  execSync('which tmux', { stdio: 'ignore' });
  // Also check tmux is actually usable (not just present)
  execSync('tmux list-sessions 2>/dev/null || (tmux new-session -d -s __tmux_test 2>/dev/null && tmux kill-session -t __tmux_test 2>/dev/null)', { stdio: 'ignore' });
  tmuxAvailable = true;
} catch { /* tmux missing or unusable */ }

const TEST_SESSION = 'agent-ceo-test';

function cleanupSession() {
  try { execSync(`tmux kill-session -t ${TEST_SESSION} 2>/dev/null`); } catch { /* ignore */ }
}

function cleanupRunningDir() {
  const runDir = path.join(os.homedir(), '.agent-ceo', 'running', TEST_SESSION);
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function cleanupLogDir() {
  const logDir = path.join('/tmp/agent-ceo', TEST_SESSION);
  try { fs.rmSync(logDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function cleanup() {
  cleanupSession();
  cleanupRunningDir();
  cleanupLogDir();
}

describe('tmux integration', { skip: !tmuxAvailable ? 'tmux not available' : false }, () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  test('can create and destroy a tmux session', () => {
    execSync(`tmux new-session -d -s ${TEST_SESSION} -x 80 -y 24`);

    // Verify session exists
    const sessions = execSync('tmux list-sessions -F "#{session_name}"').toString();
    assert.ok(sessions.includes(TEST_SESSION));

    // Kill it
    execSync(`tmux kill-session -t ${TEST_SESSION}`);

    // Verify gone
    try {
      execSync(`tmux has-session -t ${TEST_SESSION} 2>/dev/null`);
      assert.fail('Session should not exist');
    } catch {
      // Expected
    }
  });

  test('can set and read @agent_ceo user option', () => {
    execSync(`tmux new-session -d -s ${TEST_SESSION} -x 80 -y 24`);

    // Set tag
    execSync(`tmux set-option -t ${TEST_SESSION} @agent_ceo 1`);

    // Read tag
    const val = execSync(
      `tmux show-option -t ${TEST_SESSION} -v @agent_ceo`,
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();
    assert.strictEqual(val, '1');
  });

  test('can split panes and set titles', () => {
    execSync(`tmux new-session -d -s ${TEST_SESSION} -x 80 -y 24`);

    // Split a pane
    const paneId = execSync(
      `tmux split-window -t ${TEST_SESSION} -P -F "#{pane_id}"`
    ).toString().trim();

    assert.ok(paneId.startsWith('%'));

    // Set title
    try {
      execSync(`tmux select-pane -t ${paneId} -T "test-agent"`);
    } catch { /* older tmux */ }

    // List panes — should have 2
    const panes = execSync(
      `tmux list-panes -t ${TEST_SESSION} -F "#{pane_id}"`
    ).toString().trim().split('\n');
    assert.strictEqual(panes.length, 2);
  });

  test('send-keys with -l flag sends literal text', () => {
    execSync(`tmux new-session -d -s ${TEST_SESSION} -x 80 -y 24`);

    // Send literal text including special chars
    execFileSync('tmux', ['send-keys', '-t', TEST_SESSION, '-l', 'echo "hello $USER"']);
    execFileSync('tmux', ['send-keys', '-t', TEST_SESSION, 'Enter']);

    // Wait briefly for shell to process
    execSync('sleep 0.5');

    // Capture pane content
    const content = execSync(
      `tmux capture-pane -t ${TEST_SESSION} -p`
    ).toString();

    // The literal text should appear (send-keys -l doesn't interpret $USER)
    assert.ok(content.includes('echo "hello $USER"'));
  });

  test('pipe-pane captures output to file', () => {
    const logDir = path.join('/tmp/agent-ceo', TEST_SESSION);
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'test.log');
    fs.writeFileSync(logFile, '');

    execSync(`tmux new-session -d -s ${TEST_SESSION} -x 80 -y 24`);
    execSync(`tmux pipe-pane -t ${TEST_SESSION} "cat >> ${logFile}"`);

    // Send some text
    execFileSync('tmux', ['send-keys', '-t', TEST_SESSION, '-l', 'echo captured']);
    execFileSync('tmux', ['send-keys', '-t', TEST_SESSION, 'Enter']);

    // Wait for output
    execSync('sleep 1');

    const logContent = fs.readFileSync(logFile, 'utf-8');
    assert.ok(logContent.includes('captured'));
  });

  test('pane_current_command detects running process', () => {
    execSync(`tmux new-session -d -s ${TEST_SESSION} -x 80 -y 24`);

    // Pane 0 should be running a shell
    const cmd = execSync(
      `tmux display-message -t "${TEST_SESSION}:0.0" -p '#{pane_current_command}'`,
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();

    // Should be bash, zsh, sh, or similar
    assert.ok(['bash', 'zsh', 'sh', 'fish', 'dash'].some(s => cmd.includes(s)),
      `Expected a shell command, got: ${cmd}`);
  });
});

describe('session discovery integration', { skip: !tmuxAvailable ? 'tmux not available' : false }, () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  test('discoverActiveSessions finds tagged sessions', () => {
    // Create a tagged session
    execSync(`tmux new-session -d -s ${TEST_SESSION} -x 80 -y 24`);
    execSync(`tmux set-option -t ${TEST_SESSION} @agent_ceo 1`);

    // Write meta.json
    const runDir = path.join(os.homedir(), '.agent-ceo', 'running', TEST_SESSION);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({
      label: 'test-session',
      team: { claude1: 'claude' },
      projectDir: '/tmp',
      lastActive: new Date().toISOString(),
    }));

    const { discoverActiveSessions } = require('../src/menu');
    const sessions = discoverActiveSessions();
    const found = sessions.find(s => s.sessionName === TEST_SESSION);
    assert.ok(found, 'Should find the tagged session');
    assert.strictEqual(found.label, 'test-session');
  });

  test('discoverRecoverableSessions finds orphaned running dirs', () => {
    // Create a running dir with no tmux session
    const runDir = path.join(os.homedir(), '.agent-ceo', 'running', TEST_SESSION);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({
      label: 'orphaned',
      lastActive: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(runDir, 'journal.ndjson'), '');

    const { discoverRecoverableSessions } = require('../src/menu');
    const sessions = discoverRecoverableSessions();
    const found = sessions.find(s => s.sessionName === TEST_SESSION);
    assert.ok(found, 'Should find the orphaned running dir');
    assert.strictEqual(found.label, 'orphaned');
  });

  test('stale empty running dirs are cleaned up during discovery', () => {
    // Create an empty running dir (no meta, no journal)
    const runDir = path.join(os.homedir(), '.agent-ceo', 'running', TEST_SESSION);
    fs.mkdirSync(runDir, { recursive: true });

    const { discoverRecoverableSessions } = require('../src/menu');
    discoverRecoverableSessions();

    // Dir should be cleaned up
    assert.ok(!fs.existsSync(runDir), 'Empty running dir should be deleted');
  });
});
