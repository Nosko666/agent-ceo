// src/providers/claude.js
const { execSync } = require('child_process');

module.exports = {
  name: 'claude',
  command: 'claude',
  startArgs: [],
  promptPattern: /[❯>]\s*$/m,
  stripPatterns: [
    /╭[─┬].*?╮/g,    // box drawing top
    /╰[─┴].*?╯/g,    // box drawing bottom
    /│\s*$/gm,        // box drawing sides
  ],
  startupDelay: 4000,
  exitCommand: '/exit',

  detect() {
    try {
      execSync('which claude', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
};
