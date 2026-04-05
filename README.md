# agent-ceo

**You're the CEO. They're your team. One chatroom. You decide who speaks.**

A terminal-based multi-agent chatroom orchestrator. Run multiple AI coding agents (Claude Code, Codex, Gemini, and more) side by side in tmux. Talk to them individually, in groups, or all at once. They see everything but only respond when you ask.

Like a Slack channel where you're the boss — with private DMs on the side.

## Quick Start

```bash
# Clone and install
git clone <your-repo-url>
cd agent-ceo
bash setup.sh

# Run with default team (2 Claude + 2 Codex)
agent-ceo

# Custom team
agent-ceo --agents claude:3,codex:1
```

## How It Works

You get a shared chatroom prompt. All agents run as live interactive sessions in tmux panes. You control who speaks with `@` mentions:

```
CEO ▸ @all Check this XML file for turnover calculation errors

┌─ claude1 ──────────────────────────
│ I found an issue on line 47 where
│ the subtotal excludes returns...
└────────────────────────────────────

┌─ codex1 ───────────────────────────
│ Three discrepancies detected:
│ line 12 has a rounding error...
└────────────────────────────────────

CEO ▸ @all read each other's answers and find holes

CEO ▸ Good point about line 12.
      Also check the header dates.

      (nobody responds — both absorbed this)

CEO ▸ @claude1 what's your final verdict?
```

### Key Concepts

- **@agent** → only that agent responds
- **@all** → all agents respond in parallel
- **@claudes** / **@codexes** → provider groups
- **@custom-group** → groups you define
- **Plain text** → goes to all inboxes silently, nobody responds
- **@agent:stop** → interrupt mid-response

### Inbox System

Every message goes into every agent's inbox. But agents only read their inbox when you `@` them. Messages are batched — if you send 5 messages before addressing an agent, it receives all 5 at once. Zero wasted tokens.

### Live Sessions, Not One-Shot Calls

Agents run as persistent interactive CLI sessions. They maintain their own context naturally. We only send NEW messages into their session — no re-reading history, no wasted tokens.

## Features

| Feature | Status |
|---------|--------|
| @-mention routing | ✅ |
| Inbox batching | ✅ |
| tmux split panes | ✅ |
| Agent spawn/kill/revive | ✅ |
| Custom naming | ✅ |
| Custom groups | ✅ |
| Session save/resume | ✅ |
| File pinning | ✅ |
| Private DMs (@agent:dm) | ✅ |
| Write mode toggle | ✅ |
| Workflows (/debate, /plan, /review, /research) | ✅ |
| Token dashboard (/tokens, /status) | ✅ |
| Tag system (#decision, #todo) | ✅ |

## Commands

```
Addressing:
  @agent message        Send to one agent
  @all message          Send to all agents
  @claudes message      Send to all Claude instances
  @agent:stop           Stop agent mid-response
  @agent:write msg      Allow file writes for this message
  @agent:dm msg         Private DM (others won't see)

Agents:
  /agents               List all agents + status
  /spawn <provider>     Add new agent
  /kill <agent>         Remove agent
  /revive <agent>       Restart crashed agent
  /rename <old> <new>   Custom name

Groups:
  /group <name> a1 a2   Create group
  /ungroup <name>       Delete group
  /groups               List groups

Session:
  /session name <name>  Name this session
  /save                 Save to disk
  /history              Recent messages
  /help                 Full reference
  /quit                 Exit
```

## Adding a New Provider

Create a file in `src/providers/`:

```javascript
// src/providers/gemini.js
const { execSync } = require('child_process');
module.exports = {
  name: 'gemini',
  command: 'gemini',
  startArgs: [],
  promptPattern: /[❯>]\s*$/m,
  stripPatterns: [],
  startupDelay: 3000,
  exitCommand: 'exit',
  detect() {
    try { execSync('which gemini', { stdio: 'ignore' }); return true; }
    catch { return false; }
  },
};
```

Then: `agent-ceo --agents gemini:2,claude:1`

## Requirements

- **Node.js** 20+
- **tmux** (auto-installed by setup.sh)
- At least one AI CLI authenticated:
  - [Claude Code](https://claude.com/product/claude-code) (`claude` command)
  - [Codex CLI](https://github.com/openai/codex) (`codex` command)

## Architecture

```
agent-ceo (Node.js process)
  ├── tmux session "ceo"
  │     ├── pane 0: Chatroom (you type here)
  │     ├── pane 1: claude1 (live session)
  │     ├── pane 2: claude2 (live session)
  │     ├── pane 3: codex1 (live session)
  │     └── pane 4: codex2 (live session)
  ├── Inbox Manager (per-agent message buffers)
  ├── Log Watcher (byte-offset capture per agent)
  ├── Session Logger (markdown export)
  └── Health Monitor (crash detection + recovery)
```

Output capture uses `tmux pipe-pane` with byte-offset tracking — each agent's pane output goes to a log file, and we only read new bytes since last check. Zero re-reading.

## License

MIT
