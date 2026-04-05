const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ResponseCapture = require('../src/capture');

// Minimal mock PaneManager that uses real files
function mockPaneManager(dir) {
  const panes = new Map();
  return {
    panes,
    addPane(name, provider) {
      const logFile = path.join(dir, `${name}.log`);
      fs.writeFileSync(logFile, '');
      panes.set(name, { logFile, provider, byteOffset: 0, status: 'idle' });
    },
    readNewOutput(name) {
      const pane = panes.get(name);
      if (!pane) return null;
      try {
        const stats = fs.statSync(pane.logFile);
        if (stats.size <= pane.byteOffset) return null;
        const length = stats.size - pane.byteOffset;
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(pane.logFile, 'r');
        fs.readSync(fd, buffer, 0, length, pane.byteOffset);
        fs.closeSync(fd);
        pane.byteOffset = stats.size;
        return buffer.toString('utf-8');
      } catch { return null; }
    },
    peekNewOutput(name) {
      const pane = panes.get(name);
      if (!pane) return null;
      try {
        const stats = fs.statSync(pane.logFile);
        if (stats.size <= pane.byteOffset) return null;
        const length = stats.size - pane.byteOffset;
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(pane.logFile, 'r');
        fs.readSync(fd, buffer, 0, length, pane.byteOffset);
        fs.closeSync(fd);
        return buffer.toString('utf-8');
      } catch { return null; }
    },
    isPaneDead(name) { return !panes.has(name); },
    stripAnsi(text) {
      return text
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b\[[0-9;]*[HJK]/g, '')
        .replace(/\r/g, '');
    },
  };
}

describe('ResponseCapture', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('silence detection completes when output stops growing', async () => {
    const pm = mockPaneManager(dir);
    const provider = { promptPattern: /NEVER_MATCH/, stripPatterns: [] };
    pm.addPane('agent1', provider);

    const capture = new ResponseCapture(pm);

    // Simulate: output appears, then stops
    const logFile = pm.panes.get('agent1').logFile;
    setTimeout(() => {
      fs.appendFileSync(logFile, 'Hello world\nThis is the response\n');
    }, 200);

    const result = await capture.waitForResponse('agent1', {
      pollMs: 100,
      silenceMs: 1000,  // 1s silence = done
      timeoutMs: 10000,
    });

    assert.ok(result.text.includes('Hello world'));
    assert.ok(result.text.includes('response'));
    assert.strictEqual(result.timedOut, false);
  });

  test('prompt pattern detection completes immediately', async () => {
    const pm = mockPaneManager(dir);
    const provider = { promptPattern: /❯\s*$/, stripPatterns: [] };
    pm.addPane('agent1', provider);

    const capture = new ResponseCapture(pm);

    const logFile = pm.panes.get('agent1').logFile;
    setTimeout(() => {
      fs.appendFileSync(logFile, 'Response text\n❯ \n');
    }, 200);

    const result = await capture.waitForResponse('agent1', {
      pollMs: 100,
      silenceMs: 2000,
      timeoutMs: 10000,
    });

    assert.ok(result.text.includes('Response text'));
    assert.strictEqual(result.timedOut, false);
  });

  test('timeout fires when output keeps growing', async () => {
    const pm = mockPaneManager(dir);
    const provider = { promptPattern: /NEVER_MATCH/, stripPatterns: [] };
    pm.addPane('agent1', provider);

    const capture = new ResponseCapture(pm);

    const logFile = pm.panes.get('agent1').logFile;
    // Keep appending output every 200ms to prevent silence detection
    const interval = setInterval(() => {
      fs.appendFileSync(logFile, 'more output...\n');
    }, 200);

    const result = await capture.waitForResponse('agent1', {
      pollMs: 100,
      silenceMs: 1000,
      timeoutMs: 2000, // 2s hard timeout
    });

    clearInterval(interval);
    assert.strictEqual(result.timedOut, true);
    assert.ok(result.text.includes('more output'));
  });

  test('stripAnsi handles CSI sequences with ? prefix', () => {
    const pm = mockPaneManager(dir);
    const input = '\x1b[?2004h\x1b[?1004hHello\x1b[?2004l';
    const result = pm.stripAnsi(input);
    assert.strictEqual(result, 'Hello');
  });

  test('stripAnsi handles OSC title sequences', () => {
    const pm = mockPaneManager(dir);
    const input = '\x1b]0;✳ Claude Code\x07Response text';
    const result = pm.stripAnsi(input);
    assert.strictEqual(result, 'Response text');
  });
});
