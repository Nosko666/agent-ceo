const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const Journal = require('../src/journal');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
}

describe('Journal', () => {
  let dir;
  let journal;

  beforeEach(() => {
    dir = tmpDir();
    journal = new Journal(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('append writes NDJSON line with seq and t', () => {
    journal.append({ type: 'msg', from: 'ceo', text: 'hello' });
    const lines = fs.readFileSync(path.join(dir, 'journal.ndjson'), 'utf-8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.strictEqual(event.seq, 1);
    assert.strictEqual(event.type, 'msg');
    assert.strictEqual(event.from, 'ceo');
    assert.strictEqual(event.text, 'hello');
    assert.ok(event.t > 0);
  });

  test('seq increments monotonically', () => {
    journal.append({ type: 'msg', from: 'ceo', text: 'one' });
    journal.append({ type: 'msg', from: 'ceo', text: 'two' });
    journal.append({ type: 'msg', from: 'ceo', text: 'three' });
    const lines = fs.readFileSync(path.join(dir, 'journal.ndjson'), 'utf-8').trim().split('\n');
    assert.strictEqual(JSON.parse(lines[0]).seq, 1);
    assert.strictEqual(JSON.parse(lines[1]).seq, 2);
    assert.strictEqual(JSON.parse(lines[2]).seq, 3);
  });

  test('replay returns events in seq order', () => {
    journal.append({ type: 'msg', from: 'ceo', text: 'one' });
    journal.append({ type: 'msg', from: 'ceo', text: 'two' });
    const events = journal.replay();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].seq, 1);
    assert.strictEqual(events[1].seq, 2);
    assert.strictEqual(events[0].text, 'one');
  });

  test('replay after seq skips earlier events', () => {
    journal.append({ type: 'msg', from: 'ceo', text: 'one' });
    journal.append({ type: 'msg', from: 'ceo', text: 'two' });
    journal.append({ type: 'msg', from: 'ceo', text: 'three' });
    const events = journal.replay(2);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].seq, 3);
  });

  test('replay drops truncated last line', () => {
    journal.append({ type: 'msg', from: 'ceo', text: 'good' });
    fs.appendFileSync(path.join(dir, 'journal.ndjson'), '{"seq":2,"type":"ms\n');
    const events = journal.replay();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].text, 'good');
  });

  test('replay hard-fails on corrupt middle line', () => {
    journal.append({ type: 'msg', from: 'ceo', text: 'good' });
    const journalPath = path.join(dir, 'journal.ndjson');
    const content = fs.readFileSync(journalPath, 'utf-8');
    const corrupted = content + 'NOT_JSON\n' + '{"seq":3,"type":"msg","from":"ceo","text":"after","t":123}\n';
    fs.writeFileSync(journalPath, corrupted);
    assert.throws(() => journal.replay(), /corrupt.*line 2/i);
  });

  test('replay hard-fails on unknown event type', () => {
    const journalPath = path.join(dir, 'journal.ndjson');
    fs.writeFileSync(journalPath, '{"seq":1,"type":"alien_event","t":123}\n');
    assert.throws(() => journal.replay(), /unknown event type/i);
  });

  test('replay hard-fails on missing required field', () => {
    const journalPath = path.join(dir, 'journal.ndjson');
    fs.writeFileSync(journalPath, '{"seq":1,"type":"msg","from":"ceo","t":123}\n');
    assert.throws(() => journal.replay(), /missing required field.*text/i);
  });

  test('eventCount and journalSize track state', () => {
    assert.strictEqual(journal.eventCount, 0);
    assert.strictEqual(journal.journalSize, 0);
    journal.append({ type: 'msg', from: 'ceo', text: 'hello' });
    journal.append({ type: 'msg', from: 'ceo', text: 'world' });
    assert.strictEqual(journal.eventCount, 2);
    assert.ok(journal.journalSize > 0);
  });
});
