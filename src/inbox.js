// src/inbox.js
// ─────────────────────────────────────────────────────────
// Per-agent message buffers with batched delivery
// Messages accumulate silently. Flushed only when you @ an agent.
// ─────────────────────────────────────────────────────────

class InboxManager {
  constructor() {
    this.inboxes = new Map(); // agentName → [{ from, text, timestamp }]
  }

  register(agentName) {
    if (!this.inboxes.has(agentName)) {
      this.inboxes.set(agentName, []);
    }
  }

  unregister(agentName) {
    this.inboxes.delete(agentName);
  }

  // Push a message into one agent's inbox
  pushTo(agentName, from, text) {
    const inbox = this.inboxes.get(agentName);
    if (inbox) {
      inbox.push({
        from,
        text,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Push a message into ALL agents' inboxes (except sender)
  pushToAll(from, text, excludeAgent = null) {
    for (const [name] of this.inboxes) {
      if (name !== excludeAgent) {
        this.pushTo(name, from, text);
      }
    }
  }

  // Push to specific list of agents (except sender)
  pushToGroup(agents, from, text, excludeAgent = null) {
    for (const name of agents) {
      if (name !== excludeAgent) {
        this.pushTo(name, from, text);
      }
    }
  }

  // Flush inbox → returns formatted prompt string, clears inbox
  flush(agentName) {
    const inbox = this.inboxes.get(agentName);
    if (!inbox || inbox.length === 0) return null;

    const messages = [...inbox];
    inbox.length = 0; // clear

    return this.format(messages);
  }

  // Clear inbox without returning contents (used by /clear)
  clear(agentName) {
    const inbox = this.inboxes.get(agentName);
    if (inbox) inbox.length = 0;
  }

  // Peek at inbox without clearing
  peek(agentName) {
    const inbox = this.inboxes.get(agentName);
    if (!inbox || inbox.length === 0) return null;
    return this.format(inbox);
  }

  // Format messages for delivery to an agent
  format(messages) {
    const lines = [];
    for (const msg of messages) {
      const label = msg.from.toUpperCase();
      lines.push(`[${label}]: ${msg.text}`);
    }
    return lines.join('\n');
  }

  // Get message count for an agent
  count(agentName) {
    const inbox = this.inboxes.get(agentName);
    return inbox ? inbox.length : 0;
  }

  // Get counts for all agents
  allCounts() {
    const result = {};
    for (const [name, inbox] of this.inboxes) {
      result[name] = inbox.length;
    }
    return result;
  }

  // Serialize for session save
  serialize() {
    const data = {};
    for (const [name, inbox] of this.inboxes) {
      data[name] = [...inbox];
    }
    return data;
  }

  // Restore from saved state
  restore(data) {
    for (const [name, messages] of Object.entries(data)) {
      this.inboxes.set(name, messages);
    }
  }
}

module.exports = InboxManager;
