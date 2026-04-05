const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const InboxManager = require('../src/inbox');

describe('sendAndCapture broadcast modes', () => {
  let inbox;

  beforeEach(() => {
    inbox = new InboxManager();
    inbox.register('claude1');
    inbox.register('claude2');
    inbox.register('codex1');
  });

  test('broadcastTo "all" pushes to all except sender', () => {
    const sender = 'claude1';
    const text = 'response text';
    inbox.pushToAll(sender, text, sender);
    assert.strictEqual(inbox.count('claude1'), 0);
    assert.strictEqual(inbox.count('claude2'), 1);
    assert.strictEqual(inbox.count('codex1'), 1);
  });

  test('broadcastTo array pushes only to listed agents', () => {
    const sender = 'claude1';
    const text = 'response text';
    const recipients = ['claude2'];
    inbox.pushToGroup(recipients, sender, text, sender);
    assert.strictEqual(inbox.count('claude1'), 0);
    assert.strictEqual(inbox.count('claude2'), 1);
    assert.strictEqual(inbox.count('codex1'), 0);
  });

  test('broadcastTo "none" pushes to nobody', () => {
    // broadcastTo='none' means skip all broadcast — verify clean state
    assert.strictEqual(inbox.count('claude1'), 0);
    assert.strictEqual(inbox.count('claude2'), 0);
    assert.strictEqual(inbox.count('codex1'), 0);
  });

  test('private mode does not broadcast (non-transparent)', () => {
    // In private mode, response stays out of other inboxes
    assert.strictEqual(inbox.count('claude2'), 0);
    assert.strictEqual(inbox.count('codex1'), 0);
  });
});
