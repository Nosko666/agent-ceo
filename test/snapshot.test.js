const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const Journal = require('../src/journal');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
}

describe('Snapshots', () => {
  let dir;
  let journal;

  beforeEach(() => {
    dir = tmpDir();
    journal = new Journal(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writeSnapshot creates atomic snapshot.json', () => {
    journal.append({ type: 'msg', from: 'ceo', text: 'hello' });
    const state = { inboxes: {}, agents: {}, tags: [], seq: journal.nextSeq - 1 };
    journal.writeSnapshot(state);
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf-8'));
    assert.strictEqual(snap.seq, 1);
    assert.deepStrictEqual(snap.inboxes, {});
  });

  test('writeSnapshot rotates to snapshot.prev.json', () => {
    const state1 = { seq: 1, data: 'first' };
    journal.writeSnapshot(state1);
    const state2 = { seq: 2, data: 'second' };
    journal.writeSnapshot(state2);
    const current = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf-8'));
    const prev = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.prev.json'), 'utf-8'));
    assert.strictEqual(current.data, 'second');
    assert.strictEqual(prev.data, 'first');
  });

  test('writeSnapshot replaces prev on third write', () => {
    journal.writeSnapshot({ seq: 1, data: 'first' });
    journal.writeSnapshot({ seq: 2, data: 'second' });
    journal.writeSnapshot({ seq: 3, data: 'third' });
    const current = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf-8'));
    const prev = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.prev.json'), 'utf-8'));
    assert.strictEqual(current.data, 'third');
    assert.strictEqual(prev.data, 'second');
  });

  test('loadSnapshot returns null if no snapshot', () => {
    assert.strictEqual(journal.loadSnapshot(), null);
  });

  test('loadSnapshot reads current snapshot', () => {
    journal.writeSnapshot({ seq: 5, test: true });
    const snap = journal.loadSnapshot();
    assert.strictEqual(snap.seq, 5);
    assert.strictEqual(snap.test, true);
  });

  test('loadSnapshot falls back to prev if current is corrupt', () => {
    journal.writeSnapshot({ seq: 5, good: true });
    fs.writeFileSync(path.join(dir, 'snapshot.json'), 'NOT_JSON{{{');
    fs.writeFileSync(path.join(dir, 'snapshot.prev.json'), JSON.stringify({ seq: 4, fallback: true }));
    const snap = journal.loadSnapshot();
    assert.strictEqual(snap.seq, 4);
    assert.strictEqual(snap.fallback, true);
  });

  test('writeSnapshot truncates journal after success', () => {
    journal.append({ type: 'msg', from: 'ceo', text: 'one' });
    journal.append({ type: 'msg', from: 'ceo', text: 'two' });
    assert.strictEqual(journal.eventCount, 2);
    journal.writeSnapshot({ seq: 2 });
    assert.strictEqual(journal.eventCount, 0);
    assert.strictEqual(journal.journalSize, 0);
  });

  test('needsSnapshot returns true based on thresholds', () => {
    assert.strictEqual(journal.needsSnapshot(), false);
    for (let i = 0; i < 201; i++) {
      journal.append({ type: 'msg', from: 'ceo', text: `msg-${i}` });
    }
    assert.strictEqual(journal.needsSnapshot(), true);
  });
});
