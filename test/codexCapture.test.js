const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CodexCapture = require('../src/capture/codexCapture');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cap-'));
}

function writeRollout(dir, lines) {
  const sessionsDir = path.join(dir, 'sessions', '2026', '04', '06');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const rolloutPath = path.join(sessionsDir, 'rollout-test.jsonl');
  fs.writeFileSync(rolloutPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return rolloutPath;
}

describe('CodexCapture', () => {
  let dir;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('extracts text from task_complete (PRIMARY)', async () => {
    const capture = new CodexCapture(dir);
    writeRollout(dir, [
      { type: 'session_meta', payload: { id: 'test-session-id', cwd: '/tmp' } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Hello from Codex!' } },
    ]);

    const result = await capture.waitForResponse(0, { pollMs: 50, timeoutMs: 2000 });
    assert.strictEqual(result.text, 'Hello from Codex!');
    assert.strictEqual(result.timedOut, false);
  });

  test('extracts text from agent_message final_answer (FALLBACK 1)', async () => {
    const capture = new CodexCapture(dir);
    writeRollout(dir, [
      { type: 'session_meta', payload: { id: 'test-id', cwd: '/tmp' } },
      { type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: 'Fallback answer' } },
    ]);

    const result = await capture.waitForResponse(0, { pollMs: 50, timeoutMs: 2000 });
    assert.strictEqual(result.text, 'Fallback answer');
  });

  test('extracts text from response_item assistant (FALLBACK 2)', async () => {
    const capture = new CodexCapture(dir);
    writeRollout(dir, [
      { type: 'session_meta', payload: { id: 'test-id', cwd: '/tmp' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Response item text' }] } },
    ]);

    const result = await capture.waitForResponse(0, { pollMs: 50, timeoutMs: 2000 });
    assert.strictEqual(result.text, 'Response item text');
  });

  test('extracts session ID from session_meta', () => {
    const capture = new CodexCapture(dir);
    writeRollout(dir, [
      { type: 'session_meta', payload: { id: 'my-codex-session-123', cwd: '/tmp' } },
    ]);

    const sid = capture.getSessionId();
    assert.strictEqual(sid, 'my-codex-session-123');
  });

  test('times out when no completion signal', async () => {
    const capture = new CodexCapture(dir);
    writeRollout(dir, [
      { type: 'session_meta', payload: { id: 'test-id', cwd: '/tmp' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
    ]);

    const result = await capture.waitForResponse(0, { pollMs: 50, timeoutMs: 500 });
    assert.strictEqual(result.timedOut, true);
  });

  test('reads after offset skips earlier lines', async () => {
    const capture = new CodexCapture(dir);
    const rolloutPath = writeRollout(dir, [
      { type: 'session_meta', payload: { id: 'test-id', cwd: '/tmp' } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'First answer' } },
    ]);

    const firstSize = fs.statSync(rolloutPath).size;

    // Append a second answer
    fs.appendFileSync(rolloutPath, JSON.stringify(
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Second answer' } }
    ) + '\n');

    const result = await capture.waitForResponse(firstSize, { pollMs: 50, timeoutMs: 2000 });
    assert.strictEqual(result.text, 'Second answer');
  });
});
