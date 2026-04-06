const { execSync } = require('child_process');
const crypto = require('crypto');
const ClaudeCapture = require('../capture/claudeCapture');
const { claudeJsonlPath } = require('../capture/jsonlReader');

module.exports = {
  name: 'claude',
  displayName: 'Claude Code',
  installHint: 'npm install -g @anthropic-ai/claude-code',
  docsUrl: 'https://claude.ai/product/claude-code',
  command: 'claude',
  startArgs: [],
  promptPattern: /[❯>]\s*$/m,
  stripPatterns: [
    /╭[─┬].*?╮/g,
    /╰[─┴].*?╯/g,
    /│\s*$/gm,
  ],
  startupDelay: 4000,
  exitCommand: '/exit',

  detect() {
    try { execSync('which claude', { stdio: 'ignore' }); return true; }
    catch { return false; }
  },

  generateSessionId() {
    return crypto.randomUUID();
  },

  getStartArgs(sessionId) {
    if (!sessionId) return this.startArgs;
    return [...this.startArgs, '--session-id', sessionId];
  },

  getResumeArgs(sessionId) {
    if (!sessionId) return this.startArgs;
    return ['--resume', sessionId];
  },

  createCapture(sessionId, projectDir) {
    if (!sessionId || !projectDir) return null;
    const jsonlPath = claudeJsonlPath(sessionId, projectDir);
    return new ClaudeCapture(jsonlPath);
  },
};
