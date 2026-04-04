// src/providers/codex.js
const { execSync } = require('child_process');

module.exports = {
  name: 'codex',
  command: 'codex',
  startArgs: [],
  promptPattern: /[>$]\s*$/m,
  stripPatterns: [],
  startupDelay: 4000,
  exitCommand: 'exit',

  detect() {
    try {
      execSync('which codex', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
};
