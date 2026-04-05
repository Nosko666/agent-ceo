const fs = require('fs');
const path = require('path');

// Per-type required fields (hard-fail on missing during replay)
const EVENT_SCHEMAS = {
  msg:              ['from', 'text'],
  inbox_route:      ['msgSeq', 'to'],
  inbox_flush:      ['agent'],
  inbox_clear:      ['agent'],
  inbox_drop:       ['agent', 'count'],
  agent_session:    ['agent', 'sessionId'],
  agent_spawn:      ['agent', 'provider'],
  agent_kill:       ['agent'],
  agent_revive:     ['agent'],
  tag_add:          ['tag', 'text'],
  tag_suggest:      ['agent', 'tag'],
  mode_change:      ['agent', 'mode'],
  pin_add:          ['path'],
  pin_remove:       ['path'],
  session_name:     ['name'],
  group_create:     ['group', 'members'],
  group_remove:     ['group'],
  auto_start:       ['jobId', 'goal'],
  auto_pause:       ['jobId', 'reason'],
  auto_resume:      ['jobId'],
  auto_complete:    ['jobId'],
  auto_stop:        ['jobId'],
  codex_marker_sent: ['agent', 'marker'],
};

const KNOWN_TYPES = new Set(Object.keys(EVENT_SCHEMAS));

class Journal {
  constructor(dir) {
    this.dir = dir;
    this.journalPath = path.join(dir, 'journal.ndjson');
    this._seq = 0;
    this._eventsSinceSnapshot = 0;

    fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(this.journalPath)) {
      const content = fs.readFileSync(this.journalPath, 'utf-8').trim();
      if (content.length > 0) {
        const lines = content.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const event = JSON.parse(lines[i]);
            if (event.seq) { this._seq = event.seq; break; }
          } catch { /* last line might be truncated */ }
        }
        this._eventsSinceSnapshot = lines.length;
      }
    }

    // Always check snapshot for seq — journal may have been truncated after snapshot,
    // or may have events with lower seq numbers from a post-truncation restart.
    // Take the max of journal seq and snapshot seq to prevent seq going backwards.
    {
      const snapshotPath = path.join(dir, 'snapshot.json');
      if (fs.existsSync(snapshotPath)) {
        try {
          const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
          if (snap.seq && snap.seq > this._seq) {
            this._seq = snap.seq;
          }
        } catch { /* corrupt snapshot, ignore */ }
      }
    }
  }

  get nextSeq() { return this._seq + 1; }
  get eventCount() { return this._eventsSinceSnapshot; }
  get journalSize() {
    try { return fs.statSync(this.journalPath).size; } catch { return 0; }
  }

  append(event) {
    this._seq += 1;
    const entry = { seq: this._seq, t: Date.now(), ...event };
    fs.appendFileSync(this.journalPath, JSON.stringify(entry) + '\n');
    this._eventsSinceSnapshot += 1;
    return this._seq;
  }

  replay(afterSeq = 0) {
    if (!fs.existsSync(this.journalPath)) return [];
    const content = fs.readFileSync(this.journalPath, 'utf-8').trim();
    if (content.length === 0) return [];

    const lines = content.split('\n');
    const events = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;

      let event;
      try { event = JSON.parse(line); }
      catch (e) {
        if (i === lines.length - 1) break; // truncated last line OK
        throw new Error(`Journal corrupt at line ${i + 1}: ${e.message}`);
      }

      if (!event.type || !KNOWN_TYPES.has(event.type)) {
        throw new Error(`Unknown event type "${event.type}" at seq ${event.seq} (line ${i + 1}). Schema mismatch?`);
      }

      const requiredFields = EVENT_SCHEMAS[event.type];
      for (const field of requiredFields) {
        if (event[field] === undefined) {
          throw new Error(`Missing required field "${field}" for event type "${event.type}" at seq ${event.seq} (line ${i + 1})`);
        }
      }

      if (event.seq > afterSeq) events.push(event);
    }
    return events;
  }

  truncate() {
    fs.writeFileSync(this.journalPath, '');
    this._eventsSinceSnapshot = 0;
  }

  setSeq(seq) { this._seq = seq; }

  writeSnapshot(state) {
    const snapshotPath = path.join(this.dir, 'snapshot.json');
    const prevPath = path.join(this.dir, 'snapshot.prev.json');
    const tmpPath = path.join(this.dir, 'snapshot.json.tmp');

    if (fs.existsSync(snapshotPath)) {
      try { fs.copyFileSync(snapshotPath, prevPath); } catch { /* ignore */ }
    }

    const data = { seq: this._seq, ...state, snapshotAt: new Date().toISOString() };
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, snapshotPath);

    this.truncate();
  }

  loadSnapshot() {
    const snapshotPath = path.join(this.dir, 'snapshot.json');
    const prevPath = path.join(this.dir, 'snapshot.prev.json');

    if (fs.existsSync(snapshotPath)) {
      try { return JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')); }
      catch { /* corrupt, try prev */ }
    }

    if (fs.existsSync(prevPath)) {
      try { return JSON.parse(fs.readFileSync(prevPath, 'utf-8')); }
      catch { /* both corrupt */ }
    }

    return null;
  }

  needsSnapshot(maxEvents = 200, maxBytes = 1048576) {
    return this._eventsSinceSnapshot >= maxEvents || this.journalSize >= maxBytes;
  }
}

module.exports = Journal;
