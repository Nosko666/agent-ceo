const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const InboxManager = require('../src/inbox');

describe('InboxManager', () => {
  let inbox;

  beforeEach(() => {
    inbox = new InboxManager();
    inbox.register('claude1');
    inbox.register('codex1');
  });

  test('pushTo adds message to agent inbox', () => {
    inbox.pushTo('claude1', 'ceo', 'hello');
    assert.strictEqual(inbox.count('claude1'), 1);
  });

  test('pushToAll adds to all except excludeAgent', () => {
    inbox.pushToAll('ceo', 'hello', 'claude1');
    assert.strictEqual(inbox.count('claude1'), 0);
    assert.strictEqual(inbox.count('codex1'), 1);
  });

  test('flush returns formatted text and clears inbox', () => {
    inbox.pushTo('claude1', 'ceo', 'hello');
    inbox.pushTo('claude1', 'codex1', 'world');
    const result = inbox.flush('claude1');
    assert.ok(result.includes('[CEO]: hello'));
    assert.ok(result.includes('[CODEX1]: world'));
    assert.strictEqual(inbox.count('claude1'), 0);
  });

  test('clear empties inbox without returning', () => {
    inbox.pushTo('claude1', 'ceo', 'hello');
    inbox.clear('claude1');
    assert.strictEqual(inbox.count('claude1'), 0);
  });

  test('ring buffer drops oldest when maxMessages exceeded', () => {
    inbox.setLimits({ maxMessages: 3 });
    inbox.pushTo('claude1', 'ceo', 'msg1');
    inbox.pushTo('claude1', 'ceo', 'msg2');
    inbox.pushTo('claude1', 'ceo', 'msg3');
    inbox.pushTo('claude1', 'ceo', 'msg4');
    assert.strictEqual(inbox.count('claude1'), 3);
    const result = inbox.flush('claude1');
    assert.ok(!result.includes('msg1'));
    assert.ok(result.includes('msg4'));
  });

  test('ring buffer drops oldest when maxChars exceeded', () => {
    inbox.setLimits({ maxChars: 20 });
    inbox.pushTo('claude1', 'ceo', 'aaaaaaaaaa'); // 10 chars
    inbox.pushTo('claude1', 'ceo', 'bbbbbbbbbb'); // 10 chars — total 20
    inbox.pushTo('claude1', 'ceo', 'cccccccccc'); // 10 chars — total 30, drops oldest
    assert.strictEqual(inbox.count('claude1'), 2);
    const result = inbox.flush('claude1');
    assert.ok(!result.includes('aaaa'));
    assert.ok(result.includes('cccc'));
  });

  test('droppedCount tracks drops per agent', () => {
    inbox.setLimits({ maxMessages: 2 });
    inbox.pushTo('claude1', 'ceo', 'msg1');
    inbox.pushTo('claude1', 'ceo', 'msg2');
    inbox.pushTo('claude1', 'ceo', 'msg3');
    assert.strictEqual(inbox.droppedCount('claude1'), 1);
  });

  test('flush prepends drop warning if items were dropped', () => {
    inbox.setLimits({ maxMessages: 2 });
    inbox.pushTo('claude1', 'ceo', 'msg1');
    inbox.pushTo('claude1', 'ceo', 'msg2');
    inbox.pushTo('claude1', 'ceo', 'msg3');
    const result = inbox.flush('claude1');
    assert.ok(result.includes('[SYSTEM]: 1 earlier message'));
    assert.strictEqual(inbox.droppedCount('claude1'), 0); // reset after flush
  });

  test('serialize and restore round-trips', () => {
    inbox.pushTo('claude1', 'ceo', 'hello');
    const data = inbox.serialize();
    const inbox2 = new InboxManager();
    inbox2.restore(data);
    assert.strictEqual(inbox2.count('claude1'), 1);
  });
});
