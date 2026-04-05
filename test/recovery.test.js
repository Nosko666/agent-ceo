const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const Journal = require('../src/journal');
const InboxManager = require('../src/inbox');

describe('Recovery replay', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('replay msg events reconstructs message list', () => {
    const journal = new Journal(dir);
    journal.append({ type: 'msg', from: 'ceo', text: 'hello' });
    journal.append({ type: 'msg', from: 'claude1', text: 'hi there' });

    const events = journal.replay();
    const msgs = events.filter(e => e.type === 'msg');
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].from, 'ceo');
    assert.strictEqual(msgs[1].from, 'claude1');
  });

  test('replay inbox_route events reconstruct inbox state', () => {
    const journal = new Journal(dir);
    journal.append({ type: 'msg', from: 'ceo', text: 'hello' });
    journal.append({ type: 'inbox_route', msgSeq: 1, to: ['claude1', 'codex1'] });
    journal.append({ type: 'inbox_flush', agent: 'claude1' });

    const events = journal.replay();
    const inbox = new InboxManager();
    inbox.register('claude1');
    inbox.register('codex1');

    for (const e of events) {
      if (e.type === 'inbox_route') {
        const msg = events.find(m => m.type === 'msg' && m.seq === e.msgSeq);
        if (msg) {
          for (const agent of e.to) {
            inbox.pushTo(agent, msg.from, msg.text);
          }
        }
      } else if (e.type === 'inbox_flush') {
        inbox.flush(e.agent);
      }
    }

    assert.strictEqual(inbox.count('claude1'), 0);
    assert.strictEqual(inbox.count('codex1'), 1);
  });

  test('snapshot + replay gives consistent state', () => {
    const journal = new Journal(dir);
    journal.append({ type: 'msg', from: 'ceo', text: 'before snapshot' });
    journal.writeSnapshot({ seq: 1, inboxes: { claude1: [{ from: 'ceo', text: 'before snapshot' }] } });

    journal.append({ type: 'msg', from: 'ceo', text: 'after snapshot' });

    const snapshot = journal.loadSnapshot();
    const events = journal.replay(snapshot.seq);

    assert.strictEqual(snapshot.seq, 1);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].text, 'after snapshot');
  });

  test('agent_session events are captured in replay', () => {
    const journal = new Journal(dir);
    journal.append({ type: 'agent_session', agent: 'claude1', sessionId: 'uuid-123' });

    const events = journal.replay();
    const sessions = events.filter(e => e.type === 'agent_session');
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].sessionId, 'uuid-123');
  });
});
