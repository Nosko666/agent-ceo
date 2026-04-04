#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# agent-ceo installer
# ═══════════════════════════════════════════════════════════
set -e

echo ""
echo "  ╭─────────────────────────────────────╮"
echo "  │     agent-ceo installer v1.0.0      │"
echo "  ╰─────────────────────────────────────╯"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; }

# ── Check OS ──────────────────────────────────────────────
if [[ "$OSTYPE" != "linux-gnu"* ]] && [[ "$OSTYPE" != "linux" ]]; then
  warn "Detected OS: $OSTYPE (tested on Ubuntu/WSL)"
fi

# ── Check/install tmux ────────────────────────────────────
if command -v tmux &>/dev/null; then
  ok "tmux already installed ($(tmux -V))"
else
  echo "  Installing tmux..."
  if command -v apt &>/dev/null; then
    sudo apt update -qq && sudo apt install -y -qq tmux
    ok "tmux installed"
  elif command -v yum &>/dev/null; then
    sudo yum install -y tmux
    ok "tmux installed"
  else
    fail "Cannot install tmux. Please install manually."
    exit 1
  fi
fi

# ── Check Node.js ─────────────────────────────────────────
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -ge 18 ]; then
    ok "Node.js $(node -v)"
  else
    fail "Node.js 18+ required. You have $(node -v)"
    echo "  Install with: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
    exit 1
  fi
else
  fail "Node.js not found."
  echo "  Install with: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi

# ── Check Claude Code CLI ─────────────────────────────────
if command -v claude &>/dev/null; then
  ok "Claude Code CLI found"
else
  warn "Claude Code CLI not found (optional — install from https://claude.com/product/claude-code)"
fi

# ── Check Codex CLI ───────────────────────────────────────
if command -v codex &>/dev/null; then
  ok "Codex CLI found"
else
  warn "Codex CLI not found (optional — install with: npm install -g @openai/codex)"
fi

# ── Install agent-ceo ────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/package.json" ]; then
  # Running from cloned repo
  echo ""
  echo "  Installing from local repository..."
  cd "$SCRIPT_DIR"
  npm link 2>/dev/null || {
    # If npm link fails (permissions), install to ~/.local/bin
    mkdir -p "$HOME/.local/bin"
    ln -sf "$SCRIPT_DIR/bin/agent-ceo" "$HOME/.local/bin/agent-ceo"
    chmod +x "$SCRIPT_DIR/bin/agent-ceo"
    if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
      echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
      warn "Added ~/.local/bin to PATH in .bashrc — run: source ~/.bashrc"
    fi
  }
  ok "agent-ceo installed"
else
  # Running via curl pipe — download and install
  REPO_URL="${AGENT_CEO_REPO_URL:-}"
  if [ -z "$REPO_URL" ]; then
    fail "Not running from a cloned repo and AGENT_CEO_REPO_URL is not set."
    echo "  Clone the repo first, then run setup.sh from inside it."
    echo "  Or set AGENT_CEO_REPO_URL to the git URL of your fork."
    exit 1
  fi
  echo ""
  echo "  Cloning repository..."
  git clone "$REPO_URL" "$HOME/.agent-ceo-src" 2>/dev/null || {
    cd "$HOME/.agent-ceo-src" && git pull
  }
  cd "$HOME/.agent-ceo-src"
  npm link 2>/dev/null || {
    mkdir -p "$HOME/.local/bin"
    ln -sf "$HOME/.agent-ceo-src/bin/agent-ceo" "$HOME/.local/bin/agent-ceo"
    chmod +x "$HOME/.agent-ceo-src/bin/agent-ceo"
  }
  ok "agent-ceo installed"
fi

# ── Create config dir ─────────────────────────────────────
mkdir -p "$HOME/.agent-ceo/presets"
mkdir -p "$HOME/.agent-ceo/sessions"
ok "Config directory created: ~/.agent-ceo/"

# ── Done ──────────────────────────────────────────────────
echo ""
echo "  ╭─────────────────────────────────────╮"
echo "  │          Setup complete!             │"
echo "  │                                      │"
echo "  │   Run:  agent-ceo                    │"
echo "  │   Help: agent-ceo --help             │"
echo "  ╰─────────────────────────────────────╯"
echo ""
