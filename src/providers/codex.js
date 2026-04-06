const { execSync } = require('child_process');
const CodexCapture = require('../capture/codexCapture');

module.exports = {
  name: 'codex',
  displayName: 'Codex CLI',
  installHint: 'npm install -g @openai/codex',
  docsUrl: 'https://github.com/openai/codex',
  command: 'codex',
  startArgs: [],
  promptPattern: /[>$]\s*$/m,
  stripPatterns: [
    /^›.*$/gm,                          // Codex prompt/command hints (›Implement, ›Use /skills)
    /^.*gpt-[\d.]+.*left.*$/gm,         // Status bar (gpt-5.4 xhigh · 100% left · /path)
    /^[•●]\s*(Working|Explored|Searching).*$/gm, // Progress indicators
    /^\s*esc to interrupt\s*$/gm,        // Interrupt hint
  ],
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

  createCapture(codexHome) {
    if (!codexHome) return null;
    const fs = require('fs');
    if (!fs.existsSync(codexHome)) return null;
    return new CodexCapture(codexHome);
  },
};
