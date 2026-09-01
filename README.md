<div align="center">

<img src="build/icon.png" width="96" alt="MemorySQL">

# MemorySQL

**面向个人开发者的本地优先知识库 —— agent 通过 MCP「连接即续接」**

[![CI](https://github.com/Logic647/MemorySQL/actions/workflows/ci.yml/badge.svg)](https://github.com/Logic647/MemorySQL/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Logic647/MemorySQL)](https://github.com/Logic647/MemorySQL/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows-0078d4)

[下载安装包](https://github.com/Logic647/MemorySQL/releases/latest) · [快速开始](#-快速开始) · [插件开发](#-插件开发规范) · [文档](#-文档)

</div>

---

你同时用三四个 AI agent(Codex / ZCode / Claude Code / Hermes …),换一个就得重新铺垫背景:项目讲到哪、你有什么偏好、踩过什么坑——全部重来。

**MemorySQL 解决这件事**:自动捕获所有 agent 的会话、维护你的记忆画像与项目状态,并在本机起一个 MCP 服务端。任何 agent 连上后一次 `memory_get_context` 调用,即可拿到完整上下文继续干活——连上一个 agent 干到哪、下一步是什么,都内联在返回里。

> **数据 100% 存本机**(SQLite + Markdown,除 LLM API 外零服务器依赖);任何导出/分享路径强制过脱敏模块;语义检索用本地 ONNX 模型,全程离线。

## ✨ 特性

- **会话自动捕获** —— 7 家 agent 开箱支持(Codex / ZCode / Hermes / Claude Code / Gemini / Cursor / OpenCode),增量监听零手动操作
- **MCP 续接包** —— 画像 + 长期记忆 + 项目状态 + 最近会话 + **上一棒交接摘要**,一次调用恢复全部上下文
- **交接简报** —— `memory_get_project_brief` 自动汇编项目当前进展/决策/待办,换 agent 接手零成本
- **语义检索** —— sqlite-vec + 本地 embedding(bge-small-zh),字面搜不到的概念性提问也能召回
- **收工汇报闭环** —— `memory_log_progress` 结构化记录做了什么/下一步/卡在哪,人工确认后进正式记忆
- **自动项目日志** —— `vault/devlog/` 按项目生成开发日志(时间线 + 决策 + 待办)
- **笔记 + 图谱** —— Markdown 笔记、[[双向链接]]、知识图谱,Obsidian 兼容
- **托盘常驻 + 全局秒搜** —— 关窗即驻留(MCP 保持在线),任意界面 `Alt+Shift+M` 唤起秒搜
- **记忆治理** —— 收工汇报候选确认、LLM 冲突检测、手动改名/归档/续接链管理

## 📦 安装

| 方式 | 命令 / 链接 |
|---|---|
| **winget**(审核中) | `winget install Logic647.MemorySQL` |
| **scoop** | `scoop bucket add logic647 https://github.com/Logic647/scoop-bucket && scoop install memorysql` |
| **安装包** | [Releases 最新版](https://github.com/Logic647/MemorySQL/releases/latest) 下载 `MemorySQL-Setup-*.exe` |
| **免安装** | Release 附件或 CI Artifacts 中的便携版 |

安装后应用自动驻留托盘;关闭窗口 = 最小化到托盘,MCP 服务保持在线。

## 🚀 快速开始

1. **启动 MemorySQL**(它就是 MCP 服务端,默认 `http://127.0.0.1:8642/mcp`)
2. **连接你的 agent**:设置 → 连接 Agent 向导 → 一键写入配置(自动备份原配置);或手工填端点
3. **重启 agent,新会话说一句「续接 <项目名>」** —— 上下文就回来了

验证连通:`curl http://127.0.0.1:8642/health`

## 🧩 MCP 工具(7 个)

| 工具 | 用途 |
|---|---|
| `memory_get_context` | 续接包:画像 + 记忆(agent 过滤)+ 项目 + 最近会话 + 上一棒摘要 |
| `memory_get_project_brief` | 项目交接简报 |
| `memory_list_sessions` | 会话枚举(项目/agent/时间过滤,带 id) |
| `memory_get_session` | 完整消息时间线回读(full 模式去截断) |
| `memory_search` | 全文检索会话/消息/记忆/笔记 + 本地语义补足 |
| `memory_write` | 写入长期记忆(agent 归因 / 标签 / 去重) |
| `memory_log_progress` | 收工汇报 → 候选记忆 → 交接简报可见 |

## 🔌 插件开发规范

一切功能皆插件:核心能力与会话捕获、语义检索一样,都是跑在同一套协议上的插件。外部插件与内置插件**走完全相同的加载协议**。

**目录结构** —— 把插件放进 `<数据目录>/plugins/<id>/`(设置 → 打开插件目录),重启即加载:

```
plugins/my-plugin/
├── manifest.json        # { "id": "my-plugin", "name": "...", "version": "0.1.0" }
└── main.js              # 单文件 CommonJS,默认导出插件对象
```

**代码规范** —— `main.js` 必须是**单文件 CommonJS**,默认导出实现以下接口的对象:

```js
module.exports = {
  manifest: {
    id: 'my-plugin',           // 全局唯一 [a-z0-9_-],同时是 IPC 通道前缀
    name: 'My Plugin',
    version: '1.0.0',
    requires: ['core-schema']  // 依赖的插件,宿主按此拓扑排序
  },
  init(ctx) {
    // 注册能力;此时依赖插件已 init
    ctx.ipc.handle('hello', () => 'world')              // 渲染进程可调 my-plugin:hello
    ctx.mcp.registerTool({                               // 注册 MCP 工具(name 仅 [a-zA-Z0-9_-])
      name: 'my_tool', description: '...', inputSchema: { type: 'object' },
      handler: (args) => 'result'
    })
    ctx.db.migrate([{ version: 1, up: 'CREATE TABLE ...' }])  // 插件命名空间的 schema 迁移
    const unwatch = ctx.watcher.watch(['D:/proj'], onChange, { match: /\.md$/ })  // 文件监听
  },
  start() { /* 可选:启动期(服务器/watcher) */ },
  stop() { /* 可选:逆序清理 */ }
}
```

**能力一览**(`init(ctx)` 提供,插件不得绕过它触碰宿主):

| 能力 | 说明 |
|---|---|
| `ctx.db.migrate / ctx.db.sqlite` | 命名空间迁移 + better-sqlite3 句柄 |
| `ctx.settings.get/set` | 持久化键值(键自动加 `<id>:` 前缀) |
| `ctx.ipc.handle / call` | 注册渲染端通道 / 调用其它插件 |
| `ctx.mcp.registerTool / list` | 注册 / 列出 MCP 工具 |
| `ctx.watcher.watch` | chokidar 封装,返回反注册函数 |
| `ctx.services.provide / use` | 插件间服务定位(靠 `requires` 保证顺序) |
| `ctx.events.on / emit` | 事件总线(`sessions:changed` 等内置事件) |
| `ctx.log / ctx.env` | 带前缀日志 / 数据目录布局 |

**生命周期**:`load → init(依赖序) → start → stop(逆序) → unload`。单个插件 init/start 异常被宿主隔离,不影响其它插件。

完整 API 见 [docs/plugins.md](docs/plugins.md)。

## 🛠 开发

```bash
npm install          # Node 24+
npm run dev          # 开发模式(热重载)
npm test             # vitest 单元测试
npm run typecheck    # tsc --noEmit
npm run dist         # 打包 Windows 安装包 + 免安装目录
npm run import:scan  # 无头扫描导入本机 agent 会话(验收用)
```

技术栈:Electron + TypeScript(strict) + React + better-sqlite3(FTS5) + sqlite-vec + CodeMirror 6。

## 📁 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 架构、数据模型、全部决策记录 |
| [docs/plugins.md](docs/plugins.md) | 插件 API 完整参考 |
| [docs/DEVLOG.md](docs/DEVLOG.md) | 开发日志(追加式) |
| [docs/RELEASE.md](docs/RELEASE.md) | 发版流程 |
| [docs/MCP_LISTING.md](docs/MCP_LISTING.md) | MCP 目录登记素材 |
| [AGENTS.md](AGENTS.md) | agent 接手开发的入口 |

## 📄 License

[MIT](LICENSE)
