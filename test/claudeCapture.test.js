const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ClaudeCapture = require('../src/capture/claudeCapture');
const { claudeJsonlPath } = require('../src/capture/jsonlReader');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cap-'));
}

describe('ClaudeCapture', () => {
  let dir;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('extracts text from assistant end_turn response', async () => {
    const jsonlPath = path.join(dir, 'session.jsonl');
    const capture = new ClaudeCapture(jsonlPath);

    // Write a user line then an assistant end_turn response
    fs.writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Hello! How can I help?' }],
        },
      }),
    ].join('\n') + '\n');

    const result = await capture.waitForResponse(0, { pollMs: 50, timeoutMs: 2000 });
    assert.strictEqual(result.text, 'Hello! How can I help?');
    assert.strictEqual(result.timedOut, false);
  });

  test('ignores thinking blocks and extracts only text', async () => {
    const jsonlPath = path.join(dir, 'session.jsonl');
    const capture = new ClaudeCapture(jsonlPath);

    fs.writeFileSync(jsonlPath, [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: null,
          content: [{ type: 'thinking', thinking: 'let me think...' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: 'done thinking' },
            { type: 'text', text: 'The answer is 42.' },
          ],
        },
      }),
    ].join('\n') + '\n');

    const result = await capture.waitForResponse(0, { pollMs: 50, timeoutMs: 2000 });
    assert.strictEqual(result.text, 'The answer is 42.');
  });

  test('reads only after given offset', async () => {
    const jsonlPath = path.join(dir, 'session.jsonl');
    const capture = new ClaudeCapture(jsonlPath);

    const line1 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'First answer' }] },
    }) + '\n';

    const line2 = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Second answer' }] },
    }) + '\n';

    fs.writeFileSync(jsonlPath, line1 + line2);

    // Read from offset after first line — should get second answer
    const result = await capture.waitForResponse(Buffer.byteLength(line1), { pollMs: 50, timeoutMs: 2000 });
    assert.strictEqual(result.text, 'Second answer');
  });

  test('times out when no end_turn appears', async () => {
    const jsonlPath = path.join(dir, 'session.jsonl');
    const capture = new ClaudeCapture(jsonlPath);

    fs.writeFileSync(jsonlPath, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', stop_reason: null, content: [{ type: 'thinking', thinking: 'hmm' }] },
    }) + '\n');

    const result = await capture.waitForResponse(0, { pollMs: 50, timeoutMs: 500 });
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.text, '');
  });

  test('handles file not existing yet (polls until created)', async () => {
    const jsonlPath = path.join(dir, 'delayed.jsonl');
    const capture = new ClaudeCapture(jsonlPath);

    // Create file after 200ms
    setTimeout(() => {
      fs.writeFileSync(jsonlPath, JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Delayed response' }] },
      }) + '\n');
    }, 200);

    const result = await capture.waitForResponse(0, { pollMs: 50, timeoutMs: 3000 });
    assert.strictEqual(result.text, 'Delayed response');
    assert.strictEqual(result.timedOut, false);
  });
});

describe('claudeJsonlPath', () => {
  test('encodes project dir correctly', () => {
    const result = claudeJsonlPath('abc-123', '/mnt/d/Projects/AI CEO');
    assert.ok(result.includes('-mnt-d-Projects-AI-CEO'));
    assert.ok(result.endsWith('abc-123.jsonl'));
  });
});
