# agent-ceo

**You're the CEO. They're your team. One chatroom. You decide who speaks.**

A terminal-based multi-agent chatroom orchestrator. Run multiple AI coding agents (Claude Code, Codex, Gemini, and more) side by side in tmux. Talk to them individually, in groups, or all at once. They see everything but only respond when you ask.

Like a Slack channel where you're the boss — with private DMs, autonomous workflows, crash recovery, and zero npm dependencies.

---

## The Problem

If you vibe-code with AI agents, you know this workflow:

1. Ask Claude to build something
2. Copy Claude's output
3. Paste it into Codex and say "review this"
4. Copy Codex's review
5. Paste it back into Claude and say "fix these issues"
6. Repeat 47 times
7. Lose track of which agent said what
8. Accidentally close a tab and lose 30 minutes of context

You're manually being the **message router** between AI agents. You're copy-pasting between terminals, keeping track of who said what, re-explaining context that one agent already knows. It's like being a Slack bot that manually forwards messages between channels.

**agent-ceo eliminates this entirely.**

All your AI agents sit in one chatroom. When Claude writes code, Codex automatically has it in their inbox. When you say `@codex1 review claude1's answer`, Codex already has the full context. No copy-paste. No lost tabs. No manual routing.

And with `/auto`, you don't even need to be in the loop. Tell them the goal, they plan it, debate it, build it, and review it — you come back to a finished result.

## Why agent-ceo?

### For vibe-coders and multi-agent users

| What you do now | What agent-ceo does |
|-----------------|---------------------|
| Copy-paste between Claude and Codex tabs | Agents share a chatroom — responses auto-route to inboxes |
| Manually re-explain context to each agent | Each agent sees everything (batched, only when you @-mention them) |
| Lose conversation when you close a terminal | Sessions persist — `/detach` and come back anytime |
| Start over when your VPS reboots | Journal + snapshots survive crashes, agents resume exact conversations |
| Manually orchestrate plan→build→review cycles | `/auto` runs the full pipeline autonomously |
| One agent at a time, sequential | Multiple agents in parallel, all visible in tmux panes |
| Can't easily get agents to critique each other | `@all read each other's answers and find holes` — one command |

### For teams and VPS workflows

- **SSH in from anywhere** — `agent-ceo` finds your running sessions regardless of directory
- **Detach and reattach** — agents keep working while you're disconnected
- **Multiple projects** — run separate sessions for different repos simultaneously
- **Crash-safe** — write-ahead journal means you never lose work, even on power loss

### Key advantages

- **Zero dependencies** — pure Node.js, no npm install needed
- **Provider agnostic** — Claude Code, Codex, Gemini, or any CLI agent with a terminal interface
- **Persistent sessions** — detach, come back later, agents keep running on VPS
- **Crash recovery** — journal system survives chatroom crashes and VPS reboots
- **Native session resume** — Claude/Codex resume their exact conversation context after restart
- **Autonomous mode** — `/auto` runs multi-step pipelines without manual turn-by-turn input
- **No token waste** — agents only receive messages when you `@` them, not on every keystroke

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/Nosko666/agent-ceo.git
cd agent-ceo
bash setup.sh

# Run (interactive menu)
agent-ceo

# Or create a new session directly
agent-ceo --new --agents claude:2,codex:1

# Custom project directory
agent-ceo --new --cd /path/to/your/repo --name my-project
```

On first run, you'll see the **startup menu**:

```
  Active sessions:
    1. ceo  (2x claude, 1x codex) — my-project

  [1] Join  |  [N] New  |  [R] Resume saved...  |  [Q] Quit

  >
```

---

## How It Works

You get a shared chatroom prompt in tmux pane 0. All agents run as live interactive sessions in other panes. You control who speaks with `@` mentions:

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

      (nobody responds — both absorbed this into their inbox)

CEO ▸ @claude1 what's your final verdict?
```

### Core Concepts

| Concept | How it works |
|---------|-------------|
| **@agent message** | Only that agent responds |
| **@all message** | All agents respond |
| **@claudes / @codexes** | Provider group mentions |
| **@custom-group** | Groups you define with `/group` |
| **Plain text** | Goes to all inboxes silently — nobody responds |
| **@agent:stop** | Interrupt mid-response |
| **@agent:dm** | Private message — other agents don't see it |
| **@agent:write** | One-time write permission for that message |

### Inbox Batching

Every message goes into every agent's inbox. But agents only read their inbox when you `@` them. Messages are batched — if you send 5 messages before addressing an agent, it receives all 5 at once. Zero wasted tokens.

### Live Sessions

Agents run as persistent interactive CLI sessions. They maintain their own context naturally. We only send NEW messages into their session — no re-reading history, no wasted tokens. Detach and reattach anytime — agents keep running.

---

## Autonomous Pipeline (`/auto`)

The killer feature. Start a multi-step workflow and let agents handle it:

```
CEO ▸ /auto Build a REST API for the receipt parser with auth and rate limiting

  [system] Auto job 1 started: Build a REST API...
  [system] Pipeline: plan → debate → consensus → implement → review
  [system] Participants: claude1, claude2, codex1

  [Round 1/10] plan | claude1 | Proposed 3-endpoint architecture... (247 tok)
  [Round 2/10] debate | claude2 | CONSENSUS: NO — JWT is overkill... (183 tok)
  [Round 3/10] debate | codex1 | CONSENSUS: YES (92 tok)
  [Round 4/10] plan | claude1 | Revised: API keys instead of JWT... (312 tok)
  [Round 5/10] debate | claude2 | CONSENSUS: YES (45 tok)
  [system] Plan approved. Implementing...
  [Round 6/10] implement | claude1 | Writing 3 files... (1,204 tok)
  [Round 7/10] review | codex1 | REVIEW: APPROVE (389 tok)
  [system] Auto job 1: completed (7 rounds).
```

### Pipeline Steps

| Step | What happens |
|------|-------------|
| **plan** | Planner proposes → critics critique → planner revises → consensus vote. Loops until all agree. Extracts `PLAN_SUMMARY` + `ACCEPTANCE_CRITERIA`. |
| **debate** | Each agent critiques the others' responses. Sequential, deterministic. |
| **consensus** | All agents vote `CONSENSUS: YES\|NO`. All YES = advance. Any NO = loop back to debate. |
| **implement** | Single writer (with WRITE permission) implements the plan. Others stay read-only. |
| **review** | Single reviewer gates with `REVIEW: APPROVE\|REQUEST_CHANGES`. Changes = loop back to implement. |

### /auto Controls

```
/auto <goal>                    Start with default pipeline (plan→debate→consensus→implement→review)
/auto --pipeline debate         Custom pipeline (only listed steps run)
/auto --rounds 20               Max agent responses (default 10)
/auto --minutes 60              Max time (default 30m)
/auto --verbose                 Show full agent output (default: compact)
/auto --no-roles                All agents participate equally (no role assignment)
/auto --participants a,b        Limit to specific agents
/auto --planner claude2         Override role assignments
/auto status                    Show current job status
/auto pause                     Pause pipeline (Enter also pauses)
/auto resume                    Resume from where it stopped
/auto resume --rounds 5         Add more rounds and resume
/auto stop                      End job
/auto verbose on|off            Toggle output mode mid-run
/auto rounds <n>                Adjust max rounds mid-run
/full auto                      Full transcript of last auto run
/full auto 2                    Full transcript of job #2
/full auto --round 3            Filter by round
/full auto --agent claude1      Filter by agent
```

### Role Assignment

With 3+ agents, roles are assigned automatically:
- **Planner/Implementer**: first agent (e.g., claude1)
- **Critics**: all other agents
- **Reviewer**: first non-implementer (e.g., codex1)

Override with flags: `--planner codex1 --reviewer claude2`

Use `--no-roles` for equal participation (round-robin, all agents on every step).

Solo mode (1-2 agents): self-critique and self-review — same pipeline, same gates.

---

## Private DMs

Send messages only one agent sees:

```
CEO ▸ @claude1:dm I think codex1 is wrong about the auth approach. What do you think?
  (private — codex1 doesn't see this)

CEO ▸ /share claude1 conclusion
  (shares claude1's DM response to everyone)
```

- `/transparent <agent>` — DM responses broadcast to all
- `/private <agent>` — DMs stay private until `/share`

---

## Session Management

### Detach and Reattach

```bash
CEO ▸ /detach              # Leave — agents keep running on VPS
$ agent-ceo                 # Come back later — menu shows your session
```

### Save and Resume

```bash
CEO ▸ /save                 # Save session to ~/.agent-ceo/sessions/
CEO ▸ /save --native        # Also save provider session IDs for exact resume

$ agent-ceo --session my-project           # Resume with fresh agent sessions
$ agent-ceo --session my-project --native  # Resume with exact native conversations
```

### Crash Recovery

If the chatroom crashes but tmux is alive:
```
  Active sessions:
    1. ceo  (2x claude) — my-project  ⚠ chatroom down

  [1] Recover chatroom  |  [N] New
```

Recovery respawns the chatroom, re-wires capture, detects agent status (idle/busy/dead).

If the VPS reboots (tmux gone):
```
  ⚠ Recoverable (tmux lost):
    1. ceo — my-project (last active Apr 5 16:30)

  [1] Recover  |  [N] New
```

Recovery replays the journal, spawns fresh agents with native session IDs (Claude `--resume`, Codex `resume`), restores full chatroom state.

---

## All Commands

```
Addressing:
  @agent message        Talk to one agent
  @all message          All agents respond
  @claudes / @codexes   Provider groups
  @mygroup message      Custom group
  @agent:stop           Stop mid-response
  @agent:write msg      One-time write permission
  @agent:dm msg         Private DM (others won't see)
  plain text            Queued silently for all

Agents:
  /agents               List all agents + status
  /spawn <provider>     Add new agent mid-session
  /kill <agent>         Remove agent
  /revive <agent>       Restart crashed agent (resumes native session)
  /clear <agent>        Full reset (new session, seed with summary)
  /rename <old> <new>   Custom name
  /status               Combined status + token usage

Groups:
  /group <name> a1 a2   Create group
  /ungroup <name>       Delete group
  /groups               List groups

Privacy & Modes:
  /dm <agent> <msg>          Private DM
  /mode <agent> write|read   Persistent write toggle
  /transparent <agent>       DM responses broadcast to all
  /private <agent>           DMs stay private until /share
  /share <agent> [mode]      Share private to chatroom
    modes: conclusion, summary, last N, all

Workflows:
  /debate [agents] [topic]   Cross-critique
  /plan <a1> <a2> <topic>    Architect + critic
  /review <a1> <a2> <task>   Implement + review
  /research [agents] <topic> Parallel investigation
  /preset                    List available workflows

Autonomous:
  /auto <goal>               Start autonomous pipeline
  /auto --pipeline p,d,c     Custom steps
  /auto --rounds N           Max agent responses (default 10)
  /auto --no-roles           All agents equal
  /auto status               Show current job status
  /auto pause / resume       Pause/resume pipeline
  /auto stop                 End job
  /auto verbose on|off       Toggle full output
  /auto rounds <n>           Adjust max rounds mid-run
  /full auto [jobId]         Full transcript of auto run

Tags:
  #decision #todo #rejected  Manual tags in messages
  /tags [filter]             Search tags
  /tag list                  Show pending suggestions
  /tag confirm [n]           Confirm agent suggestion
  /tag dismiss [n]           Dismiss suggestion

Files:
  /pin <filepath>            Pin file (inlined in agent prompts)
  /unpin <filepath>          Unpin file
  /pins                      List pinned files

Session:
  /session name <name>       Name this session
  /save [--native]           Save (--native includes provider session IDs)
  /detach                    Leave (agents keep running)
  /history                   Recent messages
  /tokens                    Token usage per agent
  /summarize <agent>         Ask agent to self-summarize
  /full <agent>              Show full last response
  /help                      Full command reference
  /quit                      Exit (confirms first)
```

---

## CLI Flags

```bash
agent-ceo                              # Interactive menu (join/new/resume)
agent-ceo --new                        # Skip menu, create new session
agent-ceo --new --agents claude:3      # Custom team composition
agent-ceo --new --name my-project      # Set session label
agent-ceo --new --cd /path/to/repo     # Set project directory
agent-ceo --attach ceo                 # Join existing session directly
agent-ceo --resume                     # List saved sessions
agent-ceo --session <name>             # Resume a saved session
agent-ceo --session <name> --native    # Resume with native provider sessions
agent-ceo setup                        # Check dependencies
agent-ceo --help                       # Show help
```

---

## Adding a New Provider

Create a file in `src/providers/`:

```javascript
// src/providers/gemini.js
const { execSync } = require('child_process');
const crypto = require('crypto');

module.exports = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  installHint: 'npm install -g @google/gemini-cli',
  docsUrl: 'https://github.com/google/gemini-cli',
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

  // Session ID methods (optional — enable native resume)
  generateSessionId() { return crypto.randomUUID(); },
  getStartArgs(sessionId) { return sessionId ? ['--session-id', sessionId] : []; },
  getResumeArgs(sessionId) { return sessionId ? ['--resume', sessionId] : []; },
};
```

Then: `agent-ceo --new --agents gemini:2,claude:1`

The provider automatically appears in the team composition prompt and startup menu.

---

## Architecture

```
agent-ceo (external mode)
  ├── Interactive startup menu (join/new/resume/recover)
  ├── Creates tmux session (tagged @agent_ceo)
  ├── Splits panes for each agent
  ├── Launches chatroom in pane 0
  └── Attaches to tmux (or switch-client if already inside tmux)

agent-ceo --_chatroom <session> (internal mode, pane 0)
  ├── Reads setup state
  ├── Initializes all managers
  ├── Write-ahead journal (NDJSON, synchronous append)
  ├── Periodic snapshots (atomic .tmp→rename)
  ├── Starts readline REPL (CEO ▸ prompt)
  └── On /quit: snapshot → save → release lock → destroy tmux

tmux session "ceo"
  ├── pane 0: Chatroom REPL (you type here)
  ├── pane 1: claude1 (live Claude Code session)
  ├── pane 2: claude2 (live Claude Code session)
  ├── pane 3: codex1 (live Codex CLI session)
  └── pane 4: codex2 (live Codex CLI session)
```

### Key Design Decisions

| Decision | Choice |
|----------|--------|
| Dependencies | Zero npm dependencies. Pure Node.js + node:test. |
| Agent communication | tmux `load-buffer` + `paste-buffer -p -r` (bracketed paste, preserves newlines) |
| Output capture | `tmux pipe-pane` → log files → byte-offset tracking → silence detection |
| State durability | Write-ahead NDJSON journal + atomic snapshots. Survives process crashes. |
| Session IDs | Claude: deterministic UUID at spawn (`--session-id`). Codex: per-agent CODEX_HOME + rollout JSONL capture. |
| Config | `~/.agent-ceo/config.json` (user prefs) + `defaults.json` (per-project team defaults) |
| File layout | Capture logs in `/tmp/agent-ceo/<session>/`. Journal/meta in `~/.agent-ceo/running/<session>/`. Saved sessions in `~/.agent-ceo/sessions/<name>/`. |

### Source Modules

| File | Lines | Role |
|------|-------|------|
| `src/index.js` | ~1350 | Entry point, startup menu, session creation, recovery |
| `src/chatroom.js` | ~970 | REPL, @routing, sendAndCapture API, /auto wiring |
| `src/commands.js` | ~680 | All /command handlers |
| `src/auto.js` | ~620 | AutoRunner — pipeline state machine, consensus/review gates |
| `src/agents.js` | ~310 | Agent lifecycle, groups, naming, session IDs |
| `src/panes.js` | ~320 | tmux pane management, paste-buffer send, capture |
| `src/session.js` | ~320 | Save/resume to disk, native IDs |
| `src/workflows.js` | ~230 | Built-in prompt templates (/debate, /plan, /review, /research) |
| `src/menu.js` | ~220 | Session discovery, meta.json, project dir detection |
| `src/journal.js` | ~170 | Write-ahead NDJSON journal + atomic snapshots |
| `src/native/codexDiscovery.js` | ~190 | Codex session ID discovery (legacy fallback) |
| `src/capture.js` | ~150 | Response completion detection (silence + prompt pattern) |
| `src/inbox.js` | ~150 | Per-agent message buffers with ring buffer overflow |
| `src/privacy.js` | ~140 | DM logs, transparent/private modes |
| `src/tokens.js` | ~140 | Token estimation, usage bars, warnings |
| `src/tags.js` | ~90 | Tag extraction, agent suggestions |
| `src/config.js` | ~80 | Config loading, defaults, parse error handling |
| `src/display.js` | ~75 | Terminal output formatting |

### Test Suite

155 tests across 16 files:
- **Unit tests** (136): journal, snapshots, inbox, tags, config, menu, providers, agents, privacy, session, auto runner, recovery, capture, sendAndCapture
- **Integration tests** (6): tmux session lifecycle, tagging, pane splitting, send-keys, session discovery
- **Smoke tests** (13): real Claude + Codex agents, @messaging, /agents, /status, /quit, /detach, 4-agent layout

---

## Requirements

- **Node.js** 18+
- **tmux** 3.0+ (auto-installed by setup.sh)
- At least one AI CLI installed and authenticated:
  - [Claude Code](https://claude.ai/product/claude-code) (`claude` command)
  - [Codex CLI](https://github.com/openai/codex) (`codex` command)

---

## Roadmap

### Done (v2.0)
- Full chatroom with @mentions, groups, DMs
- Autonomous pipeline (/auto) with plan/debate/consensus/implement/review
- Write-ahead journal with crash recovery
- Provider native session resume (Claude UUID, Codex per-agent CODEX_HOME)
- Interactive startup menu with session management
- Config system with per-project defaults

### Planned
- Window rollover layout (agentsPerWindow config for large teams)
- First-run setup wizard
- One Codex scanner per session (currently per-agent)
- /full auto reconstruction from journal (currently in-memory)
- Agent death mid-workflow auto-revive
- More providers (Gemini, local LLMs)

---

## License

MIT
