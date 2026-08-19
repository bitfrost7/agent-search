#!/usr/bin/env bash
# Build agent-search, expose the CLI in PATH, and print agent integration hints.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

info() { printf '[info] %s\n' "$*"; }
ok() { printf '[ok] %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*" >&2; }
fail() {
  printf '[error] %s\n' "$*" >&2
  exit 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  printf 'Usage: ./install.sh\n'
  printf 'Builds agent-search, links the CLI, detects local agents, and runs doctor.\n'
  exit 0
fi
if [[ $# -gt 0 ]]; then
  fail "This installer does not accept options. Run ./install.sh"
fi

info "Checking Node.js"
command -v node >/dev/null 2>&1 || fail "Node.js >= 20 is required"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[[ "$NODE_MAJOR" -ge 20 ]] || fail "Node.js >= 20 is required; found $(node -v)"
ok "Node.js $(node -v)"

info "Installing dependencies"
npm install --silent

info "Building agent-search"
npm run build --silent

BIN_DIR="${AGENT_SEARCH_BIN_DIR:-$HOME/.local/bin}"
AGENT_SEARCH_BIN="$BIN_DIR/agent-search"

info "Linking agent-search into $BIN_DIR"
mkdir -p "$BIN_DIR"
ln -sfn "$SCRIPT_DIR/bin/agent-search.js" "$AGENT_SEARCH_BIN"
[[ -x "$AGENT_SEARCH_BIN" ]] || fail "Unable to create executable $AGENT_SEARCH_BIN"
ok "CLI available at $AGENT_SEARCH_BIN"

if ! command -v agent-search >/dev/null 2>&1; then
  warn "$BIN_DIR is not in PATH; add: export PATH=\"$BIN_DIR:\$PATH\""
fi

MCP_SERVER="$SCRIPT_DIR/bin/mcp-server.js"
FOUND_AGENT=false

printf '\nDetected agents and integration hints:\n'

if command -v pi >/dev/null 2>&1 || [[ -d "$HOME/.pi/agent" ]]; then
  FOUND_AGENT=true
  printf '\n[pi]\n'
  printf '  Add to ~/.pi/agent/mcp.json:\n'
  printf '  { "mcpServers": { "agent-search": { "command": "node", "args": ["%s"] } } }\n' "$MCP_SERVER"
fi

if command -v claude >/dev/null 2>&1; then
  FOUND_AGENT=true
  printf '\n[Claude Code]\n'
  printf '  Run:\n'
  printf '  claude mcp add --scope user agent-search -- node %q\n' "$MCP_SERVER"
elif [[ -d "$HOME/.claude" ]]; then
  FOUND_AGENT=true
  printf '\n[Claude]\n'
  printf '  Configure the generic MCP JSON shown below.\n'
fi

if command -v cursor >/dev/null 2>&1 || [[ -d "$HOME/.cursor" ]]; then
  FOUND_AGENT=true
  printf '\n[Cursor]\n'
  printf '  Add the generic MCP JSON shown below to ~/.cursor/mcp.json.\n'
fi

if command -v codex >/dev/null 2>&1; then
  FOUND_AGENT=true
  printf '\n[Codex]\n'
  printf '  Run:\n'
  printf '  codex mcp add agent-search -- node %q\n' "$MCP_SERVER"
elif [[ -d "$HOME/.codex" ]]; then
  FOUND_AGENT=true
  printf '\n[Codex]\n'
  printf '  Configure the generic MCP JSON shown below.\n'
fi

if command -v gemini >/dev/null 2>&1; then
  FOUND_AGENT=true
  printf '\n[Gemini CLI]\n'
  printf '  Run:\n'
  printf '  gemini mcp add --scope user agent-search node %q\n' "$MCP_SERVER"
fi

if command -v opencode2 >/dev/null 2>&1; then
  FOUND_AGENT=true
  printf '\n[OpenCode v2]\n'
  printf '  Run:\n'
  printf '  opencode2 mcp add agent-search --global -- node %q\n' "$MCP_SERVER"
elif command -v opencode >/dev/null 2>&1 || [[ -d "$HOME/.config/opencode" ]]; then
  FOUND_AGENT=true
  printf '\n[OpenCode]\n'
  printf '  Run the interactive setup and choose a local stdio server:\n'
  printf '  opencode mcp add agent-search\n'
  printf '  Command: node\n'
  printf '  Args: %s\n' "$MCP_SERVER"
fi

if [[ "$FOUND_AGENT" == false ]]; then
  printf '\n[Generic MCP agent]\n'
  printf '  Add the following server to the agent MCP configuration.\n'
fi

printf '\n[Generic MCP JSON]\n'
printf '  {\n'
printf '    "mcpServers": {\n'
printf '      "agent-search": {\n'
printf '        "command": "node",\n'
printf '        "args": ["%s"]\n' "$MCP_SERVER"
printf '      }\n'
printf '    }\n'
printf '  }\n'

printf '\n'
info "Running agent-search doctor"
if "$AGENT_SEARCH_BIN" doctor; then
  ok "Doctor completed"
else
  warn "Doctor reported unavailable channels; inspect the output above"
fi

printf '\n'
ok "Installation complete"
