const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

// AgentManager needs a PaneManager + InboxManager. We mock PaneManager minimally.
function mockPaneManager() {
  const panes = new Map();
  return {
    panes,
    createAgentPane(name, provider, dir, pct, cliArgs) {
      panes.set(name, { paneId: `%mock-${name}`, logFile: `/tmp/mock-${name}.log`, provider, status: 'starting', byteOffset: 0 });
      return { paneId: `%mock-${name}`, logFile: `/tmp/mock-${name}.log` };
    },
    removePane(name) { panes.delete(name); },
    isPaneDead(name) { return !panes.has(name); },
    reviveAgent(name, cliArgs) { return panes.has(name); },
    arrangeLayout() {},
  };
}

const InboxManager = require('../src/inbox');
const AgentManager = require('../src/agents');

describe('AgentManager', () => {
  let pane, inbox, agents;

  beforeEach(() => {
    pane = mockPaneManager();
    inbox = new InboxManager();
    agents = new AgentManager(pane, inbox);
    // Manually add a provider so spawn works
    agents.providers.mock = {
      name: 'mock',
      command: 'echo',
      startArgs: [],
      startupDelay: 0,
      detect() { return true; },
      generateSessionId() { return 'mock-uuid-123'; },
      getStartArgs(id) { return id ? ['--session', id] : []; },
      getResumeArgs(id) { return id ? ['--resume', id] : []; },
    };
  });

  test('spawn creates agent with correct name', () => {
    const result = agents.spawn('mock');
    assert.strictEqual(result.name, 'mock1');
    assert.ok(agents.agents.has('mock1'));
  });

  test('spawn increments counter monotonically', () => {
    agents.spawn('mock');
    agents.spawn('mock');
    const r3 = agents.spawn('mock');
    assert.strictEqual(r3.name, 'mock3');
  });

  test('spawn sets sessionId from provider.generateSessionId', () => {
    agents.spawn('mock');
    assert.strictEqual(agents.getSessionId('mock1'), 'mock-uuid-123');
  });

  test('spawn registers inbox', () => {
    agents.spawn('mock');
    assert.strictEqual(inbox.count('mock1'), 0); // registered, empty
    inbox.pushTo('mock1', 'ceo', 'test');
    assert.strictEqual(inbox.count('mock1'), 1);
  });

  test('kill removes agent and inbox', () => {
    agents.spawn('mock');
    const result = agents.kill('mock1');
    assert.strictEqual(result.killed, 'mock1');
    assert.ok(!agents.agents.has('mock1'));
  });

  test('kill returns error for unknown agent', () => {
    const result = agents.kill('nonexistent');
    assert.ok(result.error);
  });

  test('rename changes custom name', () => {
    agents.spawn('mock');
    const result = agents.rename('mock1', 'architect');
    assert.strictEqual(result.to, 'architect');
    assert.strictEqual(agents.displayName('mock1'), 'architect');
  });

  test('resolve finds by original name', () => {
    agents.spawn('mock');
    assert.strictEqual(agents.resolve('mock1'), 'mock1');
  });

  test('resolve finds by custom name', () => {
    agents.spawn('mock');
    agents.rename('mock1', 'architect');
    assert.strictEqual(agents.resolve('architect'), 'mock1');
  });

  test('createGroup and resolveGroup', () => {
    agents.spawn('mock');
    agents.spawn('mock');
    const result = agents.createGroup('team', ['mock1', 'mock2']);
    assert.deepStrictEqual(result.members, ['mock1', 'mock2']);
    assert.deepStrictEqual(agents.resolveGroup('team'), ['mock1', 'mock2']);
  });

  test('resolveGroup "all" returns all agents', () => {
    agents.spawn('mock');
    agents.spawn('mock');
    const all = agents.resolveGroup('all');
    assert.strictEqual(all.length, 2);
  });

  test('setSessionId and getSessionId', () => {
    agents.spawn('mock');
    agents.setSessionId('mock1', 'new-uuid');
    assert.strictEqual(agents.getSessionId('mock1'), 'new-uuid');
  });

  test('monotonic IDs: kill does not reset counter', () => {
    agents.spawn('mock'); // mock1
    agents.kill('mock1');
    const r = agents.spawn('mock'); // should be mock2, not mock1
    assert.strictEqual(r.name, 'mock2');
  });

  test('serialize includes sessionId', () => {
    agents.spawn('mock');
    const data = agents.serialize();
    assert.strictEqual(data.agents.mock1.sessionId, 'mock-uuid-123');
  });

  test('revive returns resumed flag based on sessionId', () => {
    agents.spawn('mock');
    const result = agents.revive('mock1');
    assert.strictEqual(result.resumed, true); // has sessionId
  });

  test('revive with resume=false starts fresh', () => {
    agents.spawn('mock');
    const result = agents.revive('mock1', false);
    assert.strictEqual(result.resumed, false);
  });
});
