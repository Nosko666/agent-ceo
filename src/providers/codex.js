const { execSync } = require('child_process');

module.exports = {
  name: 'codex',
  displayName: 'Codex CLI',
  installHint: 'npm install -g @openai/codex',
  docsUrl: 'https://github.com/openai/codex',
  command: 'codex',
  startArgs: [],
  promptPattern: /[>$]\s*$/m,
  stripPatterns: [],
  startupDelay: 4000,
  exitCommand: 'exit',

  sessionsDir: null,
  markerPrefix: 'AGENT_CEO_MARKER',

  detect() {
    try { execSync('which codex', { stdio: 'ignore' }); return true; }
    catch { return false; }
  },

  generateSessionId() { return null; },

  getStartArgs(sessionId) { return this.startArgs; },

  getResumeArgs(sessionId) {
    if (!sessionId) return this.startArgs;
    return ['resume', sessionId];
  },
};
