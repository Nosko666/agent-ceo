// src/tokens.js
// ─────────────────────────────────────────────────────────
// Token estimation + status bar dashboard
// Rough estimation: ~4 chars per token (English average)
// ─────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

const CONTEXT_LIMITS = {
  claude: 200000,
  codex: 400000,
};

class TokenTracker {
  constructor(agentManager, paneManager) {
    this.agentManager = agentManager;
    this.paneManager = paneManager;
    this.sent = {};     // agentName → total chars sent
    this.received = {}; // agentName → total chars received
  }

  // Track outgoing message to agent
  trackSent(agentName, text) {
    if (!this.sent[agentName]) this.sent[agentName] = 0;
    this.sent[agentName] += text.length;
  }

  // Track agent response
  trackReceived(agentName, text) {
    if (!this.received[agentName]) this.received[agentName] = 0;
    this.received[agentName] += text.length;
  }

  // Estimate tokens for an agent
  estimate(agentName) {
    const sent = this.sent[agentName] || 0;
    const received = this.received[agentName] || 0;
    const totalChars = sent + received;
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }

  // Get context limit for an agent's provider
  getLimit(agentName) {
    const agent = this.agentManager.agents.get(agentName);
    if (!agent) return 200000;
    return CONTEXT_LIMITS[agent.provider] || 200000;
  }

  // Get usage percentage
  usagePercent(agentName) {
    const tokens = this.estimate(agentName);
    const limit = this.getLimit(agentName);
    return Math.min(100, Math.round((tokens / limit) * 100));
  }

  // Check if agent is near limit
  isNearLimit(agentName, threshold = 70) {
    return this.usagePercent(agentName) >= threshold;
  }

  // Get full stats for all agents
  allStats() {
    const stats = [];
    for (const [name] of this.agentManager.agents) {
      const tokens = this.estimate(name);
      const limit = this.getLimit(name);
      const percent = this.usagePercent(name);
      stats.push({
        name,
        displayName: this.agentManager.displayName(name),
        tokens,
        limit,
        percent,
        sent: Math.ceil((this.sent[name] || 0) / CHARS_PER_TOKEN),
        received: Math.ceil((this.received[name] || 0) / CHARS_PER_TOKEN),
      });
    }
    return stats;
  }

  // Format status bar string
  statusBar() {
    const parts = [];
    for (const [name, agent] of this.agentManager.agents) {
      const status = agent.status;
      const tokens = this.estimate(name);
      const percent = this.usagePercent(name);
      const displayName = this.agentManager.displayName(name);

      let statusIcon;
      if (status === 'running') statusIcon = '\x1b[33m◉\x1b[0m'; // yellow
      else if (status === 'dead') statusIcon = '\x1b[31m◉\x1b[0m'; // red
      else statusIcon = '\x1b[32m◉\x1b[0m'; // green

      let tokenStr;
      if (tokens > 100000) tokenStr = `${(tokens / 1000).toFixed(0)}k`;
      else if (tokens > 1000) tokenStr = `${(tokens / 1000).toFixed(1)}k`;
      else tokenStr = `${tokens}`;

      // Color token count by usage
      let tokenColor = '';
      if (percent >= 80) tokenColor = '\x1b[31m'; // red
      else if (percent >= 50) tokenColor = '\x1b[33m'; // yellow
      else tokenColor = '\x1b[2m'; // dim

      parts.push(`${statusIcon} ${displayName}:${tokenColor}${tokenStr}\x1b[0m`);
    }
    return parts.join(' │ ');
  }

  // Get warnings for agents near context limit
  getWarnings() {
    const warnings = [];
    for (const [name] of this.agentManager.agents) {
      const percent = this.usagePercent(name);
      if (percent >= 80) {
        warnings.push({
          agent: name,
          percent,
          message: `${name} context: ~${percent}% full. Consider /summarize ${name}`,
          level: 'critical',
        });
      } else if (percent >= 50) {
        warnings.push({
          agent: name,
          percent,
          message: `${name} context: ~${percent}% used`,
          level: 'warning',
        });
      }
    }
    return warnings;
  }
}

module.exports = TokenTracker;
