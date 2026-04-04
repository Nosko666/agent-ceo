// src/display.js
// ─────────────────────────────────────────────────────────
// Terminal output formatting — colors, print helpers, bars
// ─────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  orange: '\x1b[38;5;208m',
};

function printWelcome(agents) {
  console.log(`
${C.bold}${C.cyan}╭─────────────────────────────────────────╮
│          ${C.white}agent-ceo${C.cyan}  v1.0.0              │
│     You're the CEO. Lead your team.     │
╰─────────────────────────────────────────╯${C.reset}
`);
  if (agents.length > 0) {
    console.log(`${C.dim}  Team: ${agents.map(a =>
      `${a.status === 'idle' ? C.green : C.yellow}◉${C.dim} ${a.displayName}`
    ).join('  ')}${C.reset}`);
  }
  console.log(`${C.dim}  Type /help for commands. Use @agent to talk.${C.reset}`);
  console.log();
}

function printCeo(text) {
  console.log(`${C.bold}${C.white}[CEO]${C.reset} ${text}`);
}

function printAgent(label, text, provider) {
  const color = provider === 'claude' ? C.orange : provider === 'codex' ? C.cyan : C.magenta;
  console.log();
  console.log(`${color}${C.bold}┌─ ${label} ──────────────────────────${C.reset}`);
  const lines = text.split('\n');
  for (const line of lines) {
    console.log(`${color}│${C.reset} ${line}`);
  }
  console.log(`${color}${C.bold}└──────────────────────────────────────${C.reset}`);
  console.log();
}

function printSystem(text) {
  console.log(`${C.dim}[system]${C.reset} ${text}`);
}

function printWarning(text) {
  console.log(`${C.yellow}[warn]${C.reset} ${text}`);
}

function printError(text) {
  console.log(`${C.red}[error]${C.reset} ${text}`);
}

function printDim(text) {
  console.log(`${C.dim}${text}${C.reset}`);
}

function progressBar(percent, width) {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

module.exports = { C, printWelcome, printCeo, printAgent, printSystem, printWarning, printError, printDim, progressBar };
