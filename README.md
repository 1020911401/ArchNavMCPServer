# ArchNav MCP Server

> **Architecture-Aware Code Navigation** — Line-level precision · Architecture-layer awareness · Confidence-based staleness · Dual-engine MCP (22 tools)

[English](#english) | [中文](#chinese)

---

<a name="english"></a>

## 🇬🇧 English

ArchNav is an **architecture-aware code navigation** system designed for AI agents (Claude Code, Hermes, Cursor, Codex). It combines:

- **ArchNav native engine** — 12 language AST parser (zero native compilation), line-level symbol location, layered architecture detection, gradient confidence scoring
- **GitNexus dual-engine** — Proxies 13 GitNexus MCP tools for deep scope resolution, PDG data flow, and cross-repo analysis
- **Hybrid merge mode** — Key tools (`impact`, `calls`, `trace`) automatically merge results from both engines

### ✨ Features

| Feature | ArchNav | GitNexus | Graphify |
|---------|---------|----------|----------|
| Line-level navigation (file:line) | ✅ **exact** | ❌ no | ❌ file-only |
| Architecture layers (8 named) | ✅ **API/Service/Repository/...** | ⚠️ communities | ❌ none |
| Gradient staleness (28%-100%) | ✅ **per-symbol** | binary | ❌ none |
| Read-before-edit verification | ✅ **reads from disk** | ❌ graph-only | ❌ graph-only |
| Languages supported | **12** (JS/TS/Python/Go/Rust/Java/PHP/C/C++/C#/Ruby/Bash/PowerShell) | JS/TS + C++ build | 36+ WASM |
| Windows compatibility | ✅ **all tools work** | ⚠️ query crash | ✅ |
| MCP protocol tools | **22** (9 native + 13 proxy) | 17 | ❌ none |
| Interactive graph HTML | ✅ D3 visualization | web UI | ✅ D3 |
| Install size | **~15MB, zero compile** | ~54MB + C++ build | ~30MB pip |

### 🚀 Quick Start

```bash
# 1. Clone & install
git clone https://github.com/1020911401/ArchNavMCPServer.git
cd ArchNavMCPServer
npm install

# 2. Analyze your project
node src/index.js analyze /path/to/your-project

# 3. Navigate
node src/index.js locate "getOrderById"       # Find symbol → file:line
node src/index.js arch                          # Show architecture layers
node src/index.js calls "createOrder"           # Show call graph
node src/index.js impact "calculateOrderTotal"  # Blast radius

# 4. Start MCP Server (for Claude Code / Hermes)
node src/mcp-server.js
```

### 🏗️ Architecture Detection

ArchNav automatically detects 8 architecture layers from your codebase's directory structure:

```
src/controllers/  → API (Controller)   — Express routes, REST handlers
src/services/     → Business (Service)  — Business logic, orchestrators
src/repositories/ → Data (Repository)   — Database access
src/models/       → Model/Validation    — Schemas, validators
src/middleware/    → Middleware          — Auth, logging, error handling
src/config/       → Configuration       — App settings
src/utils/        → Utilities           — Shared helpers
```

### 🔌 MCP Tools (22 total)

**ArchNav native (9):**

| Tool | Description |
|------|-------------|
| `archnav_locate` | Locate a symbol → exact file:line range + confidence |
| `archnav_read` | Read actual source code from disk (verification pattern) |
| `archnav_arch` | Show layered architecture map |
| `archnav_trace` | Trace shortest call path (ArchNav + GitNexus merged) |
| `archnav_impact` | Blast radius analysis (ArchNav layer + GitNexus risk) |
| `archnav_calls` | Outgoing call graph (ArchNav edges + GitNexus UIDs) |
| `archnav_callers` | Incoming callers (ArchNav edges + GitNexus UIDs) |
| `archnav_status` | Index staleness check |
| `archnav_analyze` | Build/update knowledge graph |

**GitNexus proxy (13):** `gn_query`, `gn_context`, `gn_cypher`, `gn_impact`, `gn_route_map`, `gn_rename`, `gn_detect_changes`, `gn_shape_check`, `gn_api_impact`, `gn_tool_map`, `gn_group_list`, `gn_group_sync`, `gn_list_repos`

### 🧠 Dual-Engine Hybrid Mode

Key tools automatically merge results from both engines:

```
$ archnav_impact "calculateOrderTotal"

💥 Impact: calculateOrderTotal

🏗️  Layer (ArchNav): Business (Service)       ← ArchNav: layer + confidence
📊 Confidence: 100%

🔴 Direct (ArchNav):                           ← ArchNav: 152 call edges
   createOrder → src/services/orderService.js:21

🔍 Risk (GitNexus): LOW                        ← GitNexus: depth analysis
   Direct: 1
   Processes affected: 1
   By depth: {"1":1,"2":1,"3":1}
```

### 📊 Comparison: GitNexus vs Graphify vs ArchNav

| Metric | GitNexus | Graphify | **ArchNav** |
|--------|----------|----------|-------------|
| Total nodes | 161 | 165 | **163** |
| Total edges | 294 | 222 | **663** |
| Architecture | 11 communities (unnamed) | none | **8 named layers** |
| Line-level | ❌ no | ❌ file-level | **✅ every symbol** |
| Staleness | binary (stale/fresh) | ❌ none | **✅ gradient 28%-100%** |
| Languages | JS+TS (native build) | 36+ (WASM) | **✅ 12 languages** |
| Windows | ⚠️ query tools crash | ✅ | **✅ all tools** |
| MCP tools | 17 | ❌ none | **✅ 22 tools** |
| Install | ~54MB + C++ build | ~30MB pip | **~15MB npm, no build** |

### 📁 Project Structure

```
├── src/
│   ├── index.js              # CLI entry (11 commands)
│   ├── mcp-server.js         # MCP Server (22 tools)
│   ├── analyzer.js           # Code analysis + knowledge graph
│   ├── navigation.js         # Navigation commands
│   ├── reader.js             # Disk-read verification
│   ├── confidence.js         # Staleness + confidence scoring
│   ├── kgraph.js             # Knowledge graph queries + HTML export
│   ├── treewalker.js         # JS AST parser (acorn)
│   └── parsers/
│       ├── dispatcher.js     # Unified parser router
│       ├── typescript.js     # TypeScript parser
│       ├── python.js         # Python parser (ast module)
│       └── wasmParser.js     # Go/Rust/Java/PHP/C/C++/C#/Ruby/Bash/PowerShell
├── scripts/
│   ├── py_ast_parser.py      # Python AST helper
│   └── register-mcp.sh       # MCP registration script
└── package.json
```

### 🛠️ Requirements

- **Node.js** 18+ (for native JS/WASM parsers)
- **Python** 3.10+ (optional, for Python file parsing)
- **GitNexus** (optional, for dual-engine mode) `npm install -g gitnexus`

---

<a name="chinese"></a>

## 🇨🇳 中文

ArchNav 是一个**架构感知的代码导航系统**，专为 AI 编程助手（Claude Code、Hermes、Cursor、Codex）设计。它融合了两个引擎：

- **ArchNav 原生引擎** — 12 语言 AST 解析器（零编译）、行级符号定位、分层架构检测、渐变置信度评分
- **GitNexus 双引擎** — 代理 13 个 GitNexus MCP 工具，用于深度作用域解析、PDG 数据流和跨仓库分析
- **混合合并模式** — 关键工具（`impact`、`calls`、`trace`）自动合并两个引擎的结果

### ✨ 功能亮点

| 特性 | ArchNav | GitNexus | Graphify |
|------|---------|----------|----------|
| 行级导航 (file:line) | ✅ **精确** | ❌ 无 | ❌ 文件级 |
| 架构层 (8 层命名) | ✅ **API/Service/Repository/...** | ⚠️ 社区聚类 | ❌ 无 |
| 渐变过期检测 (28%-100%) | ✅ **每符号独立** | 二进制 | ❌ 无 |
| 修改前读代码验证 | ✅ **从磁盘读取** | ❌ 纯图谱 | ❌ 纯图谱 |
| 支持语言 | **12 种** (JS/TS/Python/Go/Rust/Java/PHP/C/C++/C#/Ruby/Bash/PowerShell) | JS/TS + C++编译 | 36+ WASM |
| Windows 兼容 | ✅ **全功能** | ⚠️ 查询崩溃 | ✅ |
| MCP 协议工具数 | **22** (9 原生 + 13 代理) | 17 | ❌ 无 |
| 交互式图谱 HTML | ✅ D3 可视化 | Web UI | ✅ D3 |
| 安装体积 | **~15MB，零编译** | ~54MB + C++编译 | ~30MB pip |

### 🚀 快速开始

```bash
# 1. 克隆安装
git clone https://github.com/1020911401/ArchNavMCPServer.git
cd ArchNavMCPServer
npm install

# 2. 分析你的项目
node src/index.js analyze /path/to/your-project

# 3. 导航
node src/index.js locate "getOrderById"       # 定位符号 → 文件:行号
node src/index.js arch                          # 查看架构层
node src/index.js calls "createOrder"           # 查看调用图
node src/index.js impact "calculateOrderTotal"  # 影响分析

# 4. 启动 MCP Server (供 Claude Code / Hermes 调用)
node src/mcp-server.js
```

### 🏗️ 架构检测

ArchNav 自动从目录结构检测 8 层架构：

```
src/controllers/  → API (Controller)   — Express 路由、REST 处理器
src/services/     → Business (Service)  — 业务逻辑、编排器
src/repositories/ → Data (Repository)   — 数据库访问
src/models/       → Model/Validation    — 模式、校验器
src/middleware/    → Middleware          — 认证、日志、错误处理
src/config/       → Configuration       — 应用配置
src/utils/        → Utilities           — 共享工具函数
```

### 🔌 MCP 工具 (共 22 个)

**ArchNav 原生 (9 个):**

| 工具 | 说明 |
|------|------|
| `archnav_locate` | 定位符号 → 精确 文件:行号范围 + 置信度 |
| `archnav_read` | 从磁盘读取实际代码（验证模式） |
| `archnav_arch` | 显示分层架构地图 |
| `archnav_trace` | 追踪最短调用路径（ArchNav + GitNexus 合并） |
| `archnav_impact` | 影响分析（ArchNav 层 + GitNexus 风险） |
| `archnav_calls` | 出站调用图（ArchNav 边 + GitNexus UID） |
| `archnav_callers` | 入站调用者（ArchNav 边 + GitNexus UID） |
| `archnav_status` | 索引新鲜度检查 |
| `archnav_analyze` | 构建/更新知识图谱 |

**GitNexus 代理 (13 个):** `gn_query`, `gn_context`, `gn_cypher`, `gn_impact`, `gn_route_map`, `gn_rename`, `gn_detect_changes`, `gn_shape_check`, `gn_api_impact`, `gn_tool_map`, `gn_group_list`, `gn_group_sync`, `gn_list_repos`

### 🧠 双引擎混合模式

关键工具自动合并两个引擎的结果：

```
$ archnav_impact "calculateOrderTotal"

💥 影响分析: calculateOrderTotal

🏗️  架构层 (ArchNav): Business (Service)      ← ArchNav: 层 + 置信度
📊 置信度: 100%

🔴 直接影响 (ArchNav):                         ← ArchNav: 152 条调用边
   createOrder → src/services/orderService.js:21

🔍 风险评估 (GitNexus): LOW                    ← GitNexus: 深度分析
   直接: 1
   影响流程: 1
   按深度: {"1":1,"2":1,"3":1}
```

### 📊 三方工具对比

| 指标 | GitNexus | Graphify | **ArchNav** |
|------|----------|----------|-------------|
| 总节点数 | 161 | 165 | **163** |
| 总边数 | 294 | 222 | **663** |
| 架构层 | 11 社区(无命名) | 无 | **8 层命名** |
| 行级 | ❌ 无 | ❌ 文件级 | **✅ 每个符号** |
| 过期检测 | 二进制 | ❌ 无 | **✅ 渐变 28%-100%** |
| 支持语言 | JS/TS (需编译) | 36+ (WASM) | **✅ 12 种** |
| Windows | ⚠️ 查询崩溃 | ✅ | **✅ 全功能** |
| MCP 工具 | 17 | ❌ 无 | **✅ 22 个** |
| 安装 | ~54MB + C++编译 | ~30MB pip | **~15MB npm, 零编译** |

### 📁 项目结构

```
├── src/
│   ├── index.js              # CLI 入口 (11 个命令)
│   ├── mcp-server.js         # MCP Server (22 个工具)
│   ├── analyzer.js           # 代码分析 + 知识图谱
│   ├── navigation.js         # 导航命令
│   ├── reader.js             # 磁盘读取验证
│   ├── confidence.js         # 过期检测 + 置信度打分
│   ├── kgraph.js             # 知识图谱查询 + HTML 导出
│   ├── treewalker.js         # JS AST 解析器 (acorn)
│   └── parsers/
│       ├── dispatcher.js     # 统一解析器路由
│       ├── typescript.js     # TypeScript 解析器
│       ├── python.js         # Python 解析器 (ast 模块)
│       └── wasmParser.js     # Go/Rust/Java/PHP/C/C++/C#/Ruby/Bash/PowerShell
├── scripts/
│   ├── py_ast_parser.py      # Python AST 辅助脚本
│   └── register-mcp.sh       # MCP 注册脚本
└── package.json
```

### 🛠️ 系统要求

- **Node.js** 18+ (用于原生 JS/WASM 解析器)
- **Python** 3.10+ (可选，用于 Python 文件解析)
- **GitNexus** (可选，用于双引擎模式) `npm install -g gitnexus`

---

### 📄 License

MIT
