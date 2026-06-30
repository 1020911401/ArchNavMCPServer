#!/usr/bin/env bash
# Register ArchNav MCP server with Claude Code, Hermes, Cursor
# Usage: bash register-mcp.sh [claude|hermes|cursor|all]

MCP_CMD="node $HOME/projects/archnav/src/mcp-server.js"

register_claude() {
  echo "Registering with Claude Code..."
  claude mcp add archnav -- $MCP_CMD 2>/dev/null && echo "✅ Claude Code registered" || echo "⚠️ claude CLI not found"
}

register_hermes() {
  echo "To register with Hermes, add to your ~/.config/hermes/config.yaml:"
  echo ""
  echo "  mcpServers:"
  echo "    archnav:"
  echo "      command: node"
  echo "      args: [$HOME/projects/archnav/src/mcp-server.js]"
  echo ""
}

register_cursor() {
  local cursor_config="$HOME/.cursor/mcp.json"
  echo "Registering with Cursor..."
  if [ -f "$cursor_config" ]; then
    node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$cursor_config', 'utf-8'));
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers.archnav = { command: 'node', args: ['$HOME/projects/archnav/src/mcp-server.js'] };
      fs.writeFileSync('$cursor_config', JSON.stringify(cfg, null, 2));
      console.log('✅ Cursor MCP config updated');
    "
  else
    echo "  Creating $cursor_config..."
    mkdir -p "$HOME/.cursor"
    node -e "
      const fs = require('fs');
      const cfg = { mcpServers: { archnav: { command: 'node', args: ['$HOME/projects/archnav/src/mcp-server.js'] } } };
      fs.writeFileSync('$cursor_config', JSON.stringify(cfg, null, 2));
      console.log('✅ Cursor MCP config created');
    "
  fi
}

case "${1:-all}" in
  claude) register_claude ;;
  hermes) register_hermes ;;
  cursor) register_cursor ;;
  all|*)
    register_claude
    register_cursor
    register_hermes
    echo ""
    echo "✨ ArchNav MCP ready! Start the server:"
    echo "   node $HOME/projects/archnav/src/mcp-server.js"
    ;;
esac
