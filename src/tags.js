// src/tags.js
// ─────────────────────────────────────────────────────────
// Tagging system: manual #tags + agent-suggested tags
// ─────────────────────────────────────────────────────────

class TagManager {
  constructor(session) {
    this.session = session;
    this.pendingSuggestions = []; // { agentName, tag, text, timestamp }
  }

  // Extract tags from user text (#decision, #todo, #rejected, etc.)
  extractTags(text) {
    const matches = text.match(/#([a-zA-Z]\w*)/g);
    if (!matches) return [];
    return matches.map(m => m.slice(1).toLowerCase());
  }

  // Check if agent response contains a tag suggestion
  // Format: [suggested: #tagname] or [suggest: #tagname]
  extractSuggestions(agentName, text) {
    const suggestions = [];
    const pattern = /\[suggest(?:ed)?:\s*#(\w+)\]/gi;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      suggestions.push({
        agentName,
        tag: match[1].toLowerCase(),
        text: text.substring(0, 100),
        timestamp: new Date().toISOString(),
      });
    }
    return suggestions;
  }

  // Add a pending suggestion for user to confirm
  addSuggestion(suggestion) {
    this.pendingSuggestions.push(suggestion);
  }

  // Get pending suggestions without clearing
  peekPendingSuggestions() {
    return [...this.pendingSuggestions];
  }

  // Get and clear pending suggestions
  getPendingSuggestions() {
    const suggestions = [...this.pendingSuggestions];
    this.pendingSuggestions = [];
    return suggestions;
  }

  // Confirm a suggested tag
  confirmSuggestion(index) {
    if (index >= 0 && index < this.pendingSuggestions.length) {
      const suggestion = this.pendingSuggestions.splice(index, 1)[0];
      this.session.tags.push({
        tag: suggestion.tag,
        text: suggestion.text,
        timestamp: suggestion.timestamp,
        index: this.session.chatLog.length - 1,
        suggestedBy: suggestion.agentName,
      });
      return suggestion;
    }
    return null;
  }

  // Dismiss a suggested tag
  dismissSuggestion(index) {
    if (index >= 0 && index < this.pendingSuggestions.length) {
      return this.pendingSuggestions.splice(index, 1)[0];
    }
    return null;
  }

  // Search tags
  search(filter = null) {
    return this.session.searchTags(filter);
  }

  // Get tag summary
  summary() {
    const counts = {};
    for (const t of this.session.tags) {
      counts[t.tag] = (counts[t.tag] || 0) + 1;
    }
    return counts;
  }
}

module.exports = TagManager;
