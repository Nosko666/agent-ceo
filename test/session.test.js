const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SessionManager = require('../src/session');

describe('SessionManager', () => {
  let session;

  beforeEach(() => {
    session = new SessionManager();
  });

  test('logMessage adds to chatLog', () => {
    session.logMessage('ceo', 'hello');
    assert.strictEqual(session.chatLog.length, 1);
    assert.strictEqual(session.chatLog[0].from, 'ceo');
    assert.strictEqual(session.chatLog[0].text, 'hello');
  });

  test('logMessage extracts #tags', () => {
    session.logMessage('ceo', 'This is a #decision about #auth');
    assert.strictEqual(session.tags.length, 2);
    assert.strictEqual(session.tags[0].tag, 'decision');
    assert.strictEqual(session.tags[1].tag, 'auth');
  });

  test('setName sanitizes special characters', () => {
    session.setName('my project/name!@#');
    assert.ok(!session.name.includes('/'));
    assert.ok(!session.name.includes('!'));
  });

  test('addFileReference and filesReferenced', () => {
    session.addFileReference('/path/to/file.js');
    assert.ok(session.filesReferenced.has('/path/to/file.js'));
  });

  test('searchTags filters by tag name', () => {
    session.logMessage('ceo', '#decision approved');
    session.logMessage('ceo', '#todo fix bug');
    const decisions = session.searchTags('decision');
    assert.strictEqual(decisions.length, 1);
  });

  test('restoreState restores chatLog and tags', () => {
    const savedState = {
      chatLog: [{ from: 'ceo', text: 'restored', timestamp: new Date().toISOString(), tags: [] }],
      tags: [{ tag: 'test', text: 'test', timestamp: new Date().toISOString(), index: 0 }],
      filesReferenced: ['/restored/file.js'],
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    session.restoreState(savedState);
    assert.strictEqual(session.chatLog.length, 1);
    assert.strictEqual(session.chatLog[0].text, 'restored');
    assert.strictEqual(session.tags.length, 1);
    assert.ok(session.filesReferenced.has('/restored/file.js'));
  });
});

describe('SessionManager save/load', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
    // Monkey-patch the sessions dir for testing
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  test('saveNativeIds writes native.json', () => {
    const session = new SessionManager();
    const mockAgentManager = {
      agents: new Map([
        ['claude1', { provider: 'claude', sessionId: 'uuid-123' }],
        ['codex1', { provider: 'codex', sessionId: null }],
      ]),
    };
    const dir = path.join(tmpBase, 'test-session');
    fs.mkdirSync(dir, { recursive: true });
    session.saveNativeIds(dir, mockAgentManager);

    const native = JSON.parse(fs.readFileSync(path.join(dir, 'native.json'), 'utf-8'));
    assert.strictEqual(native.claude1.sessionId, 'uuid-123');
    assert.ok(!native.codex1); // null sessionId not included
  });
});
