const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const PrivacyManager = require('../src/privacy');

function mockAgentManager() {
  const agents = new Map([
    ['claude1', { provider: 'claude' }],
    ['codex1', { provider: 'codex' }],
  ]);
  return {
    agents,
    resolve(name) { return agents.has(name) ? name : null; },
    displayName(name) { return name; },
  };
}

describe('PrivacyManager', () => {
  let privacy;

  beforeEach(() => {
    privacy = new PrivacyManager(mockAgentManager());
  });

  test('setTransparent and isTransparent', () => {
    privacy.setTransparent('claude1', true);
    assert.strictEqual(privacy.isTransparent('claude1'), true);
    assert.strictEqual(privacy.isTransparent('codex1'), false);
  });

  test('setTransparent false removes transparency', () => {
    privacy.setTransparent('claude1', true);
    privacy.setTransparent('claude1', false);
    assert.strictEqual(privacy.isTransparent('claude1'), false);
  });

  test('setWriteMode and hasWriteMode', () => {
    privacy.setWriteMode('claude1', true);
    assert.strictEqual(privacy.hasWriteMode('claude1'), true);
    assert.strictEqual(privacy.hasWriteMode('codex1'), false);
  });

  test('logPrivateMessage and getPrivateLog', () => {
    privacy.logPrivateMessage('claude1', 'ceo', 'secret message');
    const log = privacy.getPrivateLog('claude1');
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].text, 'secret message');
  });

  test('getLastPrivateMessages returns last N', () => {
    privacy.logPrivateMessage('claude1', 'ceo', 'msg1');
    privacy.logPrivateMessage('claude1', 'ceo', 'msg2');
    privacy.logPrivateMessage('claude1', 'ceo', 'msg3');
    const last2 = privacy.getLastPrivateMessages('claude1', 2);
    assert.strictEqual(last2.length, 2);
    assert.strictEqual(last2[0].text, 'msg2');
  });

  test('serialize and restore round-trips', () => {
    privacy.setTransparent('claude1', true);
    privacy.setWriteMode('codex1', true);
    privacy.logPrivateMessage('claude1', 'ceo', 'dm text');

    const data = privacy.serialize();
    const privacy2 = new PrivacyManager(mockAgentManager());
    privacy2.restore(data);

    assert.strictEqual(privacy2.isTransparent('claude1'), true);
    assert.strictEqual(privacy2.hasWriteMode('codex1'), true);
    assert.strictEqual(privacy2.getPrivateLog('claude1').length, 1);
  });

  test('setTransparent returns error for unknown agent', () => {
    const result = privacy.setTransparent('unknown', true);
    assert.ok(result.error);
  });
});
