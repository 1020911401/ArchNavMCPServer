#!/usr/bin/env bash
# ArchNav 快速安装脚本
# 用法: bash setup.sh /path/to/project

set -e

ARCHNAV_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="${1:-$PWD}"

echo "========================================"
echo "  ArchNav — Architecture-Aware Code Nav"
echo "========================================"
echo ""
echo "📦 安装位置: $ARCHNAV_DIR"
echo "🎯 目标项目: $TARGET_DIR"
echo ""

# 1. 安装依赖
echo "📥 安装依赖..."
cd "$ARCHNAV_DIR"
npm install --no-optional 2>&1 | tail -1

# 2. 分析目标项目
echo ""
echo "🔍 分析 $TARGET_DIR ..."
node src/index.js analyze "$TARGET_DIR" 2>&1

# 3. 注册 MCP（可选）
if command -v claude &> /dev/null; then
    echo ""
    echo "🔌 注册 Claude Code MCP..."
    claude mcp add archnav -- node "$ARCHNAV_DIR/src/mcp-server.js"
    echo "✅ Claude Code 已配置"
fi

echo ""
echo "========================================"
echo "  ✅ ArchNav 就绪！"
echo "========================================"
echo ""
echo "快速上手:"
echo "  cd $TARGET_DIR"
echo "  node $ARCHNAV_DIR/src/index.js locate getOrderById"
echo "  node $ARCHNAV_DIR/src/index.js arch"
echo "  node $ARCHNAV_DIR/src/index.js calls createOrder"
echo "  node $ARCHNAV_DIR/src/index.js impact calculateOrderTotal"
echo "  node $ARCHNAV_DIR/src/index.js export graph.html"
echo ""
echo "MCP Server:"
echo "  node $ARCHNAV_DIR/src/mcp-server.js"
echo "  然后 Claude Code / Hermes 可调用 22 个工具"
