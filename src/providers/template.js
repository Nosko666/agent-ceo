// src/providers/template.js
// ─────────────────────────────────────────────────────────
// Copy this file to add a new AI provider.
// Fill in the fields and drop it in src/providers/
// ─────────────────────────────────────────────────────────

module.exports = {
  // Unique provider key (lowercase, no spaces)
  name: 'my-agent',

  // CLI command to start an interactive session
  command: 'my-agent-cli',

  // Arguments passed when starting the interactive session
  startArgs: [],

  // Regex that matches the CLI prompt when the agent is ready for input
  // This is how we detect "response finished"
  promptPattern: /[>❯\$]\s*$/,

  // Extra patterns to strip from captured output (beyond ANSI codes)
  stripPatterns: [],

  // Milliseconds to wait after spawning before sending first message
  startupDelay: 3000,

  // Command to gracefully exit the CLI
  exitCommand: 'exit',

  // Check if this CLI is installed and available
  detect() {
    try {
      require('child_process').execSync(`which ${this.command}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
};
