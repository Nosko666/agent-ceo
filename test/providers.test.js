const { test, describe } = require('node:test');
const assert = require('node:assert');

const claude = require('../src/providers/claude');
const codex = require('../src/providers/codex');

describe('Claude provider', () => {
  test('has required metadata fields', () => {
    assert.strictEqual(claude.displayName, 'Claude Code');
    assert.ok(claude.installHint);
    assert.ok(claude.docsUrl);
  });

  test('generateSessionId returns a UUID', () => {
    const id = claude.generateSessionId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('generateSessionId returns unique values', () => {
    const a = claude.generateSessionId();
    const b = claude.generateSessionId();
    assert.notStrictEqual(a, b);
  });

  test('getStartArgs includes --session-id when given', () => {
    const args = claude.getStartArgs('abc-123');
    assert.ok(args.includes('--session-id'));
    assert.ok(args.includes('abc-123'));
  });

  test('getResumeArgs includes --resume', () => {
    const args = claude.getResumeArgs('abc-123');
    assert.ok(args.includes('--resume'));
    assert.ok(args.includes('abc-123'));
  });

  test('getStartArgs with no sessionId returns default startArgs', () => {
    const args = claude.getStartArgs(null);
    assert.deepStrictEqual(args, claude.startArgs);
  });
});

describe('Codex provider', () => {
  test('has required metadata fields', () => {
    assert.strictEqual(codex.displayName, 'Codex CLI');
    assert.ok(codex.installHint);
  });

  test('getStartArgs returns default startArgs', () => {
    const args = codex.getStartArgs(null);
    assert.deepStrictEqual(args, codex.startArgs);
  });

  test('getResumeArgs includes resume command', () => {
    const args = codex.getResumeArgs('xyz-789');
    assert.ok(args.includes('resume'));
    assert.ok(args.includes('xyz-789'));
  });

  test('has codex discovery config', () => {
    assert.ok(codex.markerPrefix);
  });
});
