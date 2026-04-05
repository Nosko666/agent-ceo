// src/agents.js
// ─────────────────────────────────────────────────────────
// Agent lifecycle: spawn, kill, revive, rename, status
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

// Load all providers from the providers directory
function loadProviders() {
  const providersDir = path.join(__dirname, 'providers');
  const providers = {};
  const files = fs.readdirSync(providersDir);
  for (const file of files) {
    if (file === 'template.js') continue;
    if (!file.endsWith('.js')) continue;
    const provider = require(path.join(providersDir, file));
    providers[provider.name] = provider;
  }
  return providers;
}

class AgentManager {
  constructor(paneManager, inboxManager) {
    this.paneManager = paneManager;
    this.inboxManager = inboxManager;
    this.providers = loadProviders();
    this.agents = new Map(); // agentName → { provider, originalName, customName, status }
    this.counters = {}; // provider → next number (e.g. claude → 3)
    this.groups = new Map(); // groupName → [agentName, ...]

    // Built-in groups are computed dynamically
  }

  // ── Spawning ───────────────────────────────────────────

  spawn(providerName) {
    const provider = this.providers[providerName];
    if (!provider) {
      return { error: `Unknown provider: ${providerName}. Available: ${Object.keys(this.providers).join(', ')}` };
    }
    if (!provider.detect()) {
      return { error: `${providerName} CLI not found. Is it installed?` };
    }

    // Generate numbered name
    if (!this.counters[providerName]) this.counters[providerName] = 1;
    const num = this.counters[providerName]++;
    const agentName = `${providerName}${num}`;

    // Generate native session ID for providers that support it
    const sessionId = provider.generateSessionId ? provider.generateSessionId() : null;

    // Build CLI args with session ID
    const cliArgs = provider.getStartArgs ? provider.getStartArgs(sessionId) : provider.startArgs;

    // Create pane
    const { paneId, logFile } = this.paneManager.createAgentPane(agentName, provider, 'right', 25, cliArgs);

    // Register inbox
    this.inboxManager.register(agentName);

    // Track agent
    this.agents.set(agentName, {
      provider: providerName,
      originalName: agentName,
      customName: null,
      status: 'starting',
      spawnedAt: new Date().toISOString(),
      sessionId,
    });

    // Mark as ready after startup delay
    setTimeout(() => {
      const agent = this.agents.get(agentName);
      if (agent && agent.status === 'starting') {
        agent.status = 'idle';
        const pane = this.paneManager.panes.get(agentName);
        if (pane) pane.status = 'idle';
      }
    }, provider.startupDelay);

    return { name: agentName, paneId, logFile };
  }

  spawnMultiple(providerName, count) {
    const results = [];
    for (let i = 0; i < count; i++) {
      results.push(this.spawn(providerName));
    }
    return results;
  }

  // ── Killing ────────────────────────────────────────────

  kill(agentName) {
    const resolved = this.resolve(agentName);
    if (!resolved) return { error: `Agent not found: ${agentName}` };

    this.paneManager.removePane(resolved);
    this.inboxManager.unregister(resolved);
    this.agents.delete(resolved);

    // Remove from custom groups
    for (const [groupName, members] of this.groups) {
      const idx = members.indexOf(resolved);
      if (idx >= 0) members.splice(idx, 1);
    }

    return { killed: resolved };
  }

  // ── Reviving ───────────────────────────────────────────

  revive(agentName, resume = true) {
    const resolved = this.resolve(agentName);
    if (!resolved) return { error: `Agent not found: ${agentName}` };

    const agent = this.agents.get(resolved);
    const provider = this.providers[agent.provider];

    // Build CLI args: use resume if sessionId exists and resume requested, else fresh start
    let cliArgs = null;
    if (resume && agent.sessionId && provider.getResumeArgs) {
      cliArgs = provider.getResumeArgs(agent.sessionId);
    } else if (agent.sessionId && provider.getStartArgs) {
      // Fresh start with session ID tracking
      cliArgs = provider.getStartArgs(agent.sessionId);
    }

    const success = this.paneManager.reviveAgent(resolved, cliArgs);
    if (success) {
      agent.status = 'starting';
      setTimeout(() => {
        if (agent && agent.status === 'starting') {
          agent.status = 'idle';
          const pane = this.paneManager.panes.get(resolved);
          if (pane) pane.status = 'idle';
        }
      }, provider.startupDelay);
      return { revived: resolved, resumed: resume && !!agent.sessionId };
    }
    return { error: `Failed to revive ${resolved}` };
  }

  // ── Naming ─────────────────────────────────────────────

  rename(agentName, newName) {
    const resolved = this.resolve(agentName);
    if (!resolved) return { error: `Agent not found: ${agentName}` };
    if (this.resolve(newName) && this.resolve(newName) !== resolved) {
      return { error: `Name already taken: ${newName}` };
    }

    const agent = this.agents.get(resolved);
    agent.customName = newName;
    return { renamed: resolved, to: newName };
  }

  // ── Resolution ─────────────────────────────────────────
  // Resolve a user-typed name to the internal agent name.
  // Handles custom names, original names, and aliases.

  resolve(name) {
    const lower = name.toLowerCase();

    // Direct match
    if (this.agents.has(lower)) return lower;

    // Custom name match
    for (const [agentName, agent] of this.agents) {
      if (agent.customName && agent.customName.toLowerCase() === lower) {
        return agentName;
      }
    }

    return null;
  }

  // Resolve a group reference (@all, @claudes, @codexes, @customgroup)
  resolveGroup(groupRef) {
    const lower = groupRef.toLowerCase();

    if (lower === 'all') {
      return [...this.agents.keys()];
    }

    // Built-in provider groups: "claudes", "codexes"
    // Match plural: "claudes" → all agents with provider "claude"
    for (const providerName of Object.keys(this.providers)) {
      const plural = providerName + 's';
      if (lower === plural || lower === providerName + 'es') {
        return [...this.agents.entries()]
          .filter(([, a]) => a.provider === providerName)
          .map(([name]) => name);
      }
    }

    // Custom groups
    if (this.groups.has(lower)) {
      return [...this.groups.get(lower)];
    }

    return null;
  }

  // ── Groups ─────────────────────────────────────────────

  createGroup(groupName, memberNames) {
    const members = [];
    for (const name of memberNames) {
      const resolved = this.resolve(name);
      if (!resolved) return { error: `Agent not found: ${name}` };
      members.push(resolved);
    }
    this.groups.set(groupName.toLowerCase(), members);
    return { group: groupName, members };
  }

  removeGroup(groupName) {
    const lower = groupName.toLowerCase();
    if (!this.groups.has(lower)) return { error: `Group not found: ${groupName}` };
    this.groups.delete(lower);
    return { removed: groupName };
  }

  listGroups() {
    const result = {};
    for (const [name, members] of this.groups) {
      result[name] = [...members];
    }
    return result;
  }

  // ── Status ─────────────────────────────────────────────

  setStatus(agentName, status) {
    const agent = this.agents.get(agentName);
    if (agent) {
      agent.status = status;
      const pane = this.paneManager.panes.get(agentName);
      if (pane) pane.status = status;
    }
  }

  getStatus(agentName) {
    const agent = this.agents.get(agentName);
    return agent ? agent.status : null;
  }

  setSessionId(agentName, sessionId) {
    const agent = this.agents.get(agentName);
    if (agent) agent.sessionId = sessionId;
  }

  getSessionId(agentName) {
    const agent = this.agents.get(agentName);
    return agent ? agent.sessionId : null;
  }

  list() {
    const result = [];
    for (const [name, agent] of this.agents) {
      const dead = this.paneManager.isPaneDead(name);
      result.push({
        name,
        displayName: agent.customName || name,
        provider: agent.provider,
        status: dead ? 'dead' : agent.status,
        inbox: this.inboxManager.count(name),
      });
    }
    return result;
  }

  // ── Health check ───────────────────────────────────────

  checkHealth() {
    const issues = [];
    for (const [name] of this.agents) {
      if (this.paneManager.isPaneDead(name)) {
        const agent = this.agents.get(name);
        if (agent.status !== 'dead') {
          agent.status = 'dead';
          issues.push(name);
        }
      }
    }
    return issues;
  }

  // ── Display name helper ────────────────────────────────

  displayName(agentName) {
    const agent = this.agents.get(agentName);
    if (!agent) return agentName;
    return agent.customName || agentName;
  }

  // ── Serialization ──────────────────────────────────────

  serialize() {
    return {
      agents: Object.fromEntries(this.agents),
      counters: { ...this.counters },
      groups: Object.fromEntries(this.groups),
    };
  }
}

module.exports = AgentManager;
