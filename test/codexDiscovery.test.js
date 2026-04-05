const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CodexDiscovery = require('../src/native/codexDiscovery');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-disc-'));
}

describe('CodexDiscovery', () => {
  let dir;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('generateMarker creates unique marker string', () => {
    const m1 = CodexDiscovery.generateMarker('codex1');
    const m2 = CodexDiscovery.generateMarker('codex1');
    assert.ok(m1.startsWith('AGENT_CEO_MARKER=codex1:'));
    assert.notStrictEqual(m1, m2);
  });

  test('scanForMarker finds marker in text', () => {
    const marker = 'AGENT_CEO_MARKER=codex1:abc-123';
    const text = `some output\n${marker}\nmore output`;
    assert.strictEqual(CodexDiscovery.scanForMarker(text, marker), true);
  });

  test('scanForMarker returns false when not found', () => {
    const marker = 'AGENT_CEO_MARKER=codex1:abc-123';
    assert.strictEqual(CodexDiscovery.scanForMarker('no marker here', marker), false);
  });

  test('scanFileChunk finds marker in file', () => {
    const marker = 'AGENT_CEO_MARKER=codex1:test-uuid-1234';
    const filePath = path.join(dir, 'rollout.jsonl');
    const padding = 'x'.repeat(100);
    fs.writeFileSync(filePath, padding + marker + '\nmore data\n');

    const result = CodexDiscovery.scanFileChunk(filePath, 0, marker);
    assert.strictEqual(result.found, true);
    assert.ok(result.bytesRead > 0);
  });

  test('scanFileChunk handles overlap across reads', () => {
    const marker = 'AGENT_CEO_MARKER=codex1:overlap-test';
    const filePath = path.join(dir, 'rollout.jsonl');
    const halfPoint = Math.floor(marker.length / 2);
    const firstPart = marker.substring(0, halfPoint);
    fs.writeFileSync(filePath, 'data\n' + firstPart);

    // First scan: not found (marker incomplete)
    const r1 = CodexDiscovery.scanFileChunk(filePath, 0, marker);
    assert.strictEqual(r1.found, false);

    // Append rest of marker
    const secondPart = marker.substring(halfPoint);
    fs.appendFileSync(filePath, secondPart + '\nmore\n');

    // Second scan with overlap from r1
    const r2 = CodexDiscovery.scanFileChunk(filePath, r1.bytesRead, marker, r1.overlapBuffer);
    assert.strictEqual(r2.found, true);
  });

  test('findCandidateFiles returns files matching pattern', () => {
    const subDir = path.join(dir, '2026', '04', '05');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'rollout-abc.jsonl'), 'data');
    fs.writeFileSync(path.join(subDir, 'other.txt'), 'data');

    const cutoff = Date.now() - 60000;
    const files = CodexDiscovery.findCandidateFiles(dir, cutoff);
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].path.includes('rollout-abc.jsonl'));
  });
});
