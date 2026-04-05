module.exports = {
  name: 'my-agent',
  displayName: 'My Agent',
  installHint: 'npm install -g my-agent-cli',
  docsUrl: '',
  command: 'my-agent-cli',
  startArgs: [],
  promptPattern: /[>❯\$]\s*$/,
  stripPatterns: [],
  startupDelay: 3000,
  exitCommand: 'exit',

  detect() {
    try { require('child_process').execSync(`which ${this.command}`, { stdio: 'ignore' }); return true; }
    catch { return false; }
  },

  generateSessionId() { return null; },
  getStartArgs(sessionId) { return this.startArgs; },
  getResumeArgs(sessionId) { return this.startArgs; },
};
