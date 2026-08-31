# MemorySQL — 面向个人开发者的"可延续开发"知识库

> 本文件是任何 agent 接手本项目的**唯一入口**。读完本文件 + `docs/DEVLOG.md` 最新一条,即可无缝续接开发。

## 一句话定位

本地优先的 Electron 桌面应用:存储**个人记忆(人物画像)、AI agent 会话记录、开发过程**,通过 MCP 让任意 agent "连接即续接"——新会话一句话恢复全部上下文。除 LLM API 外零服务器依赖。

## 必读文档

| 文件 | 内容 |
|---|---|
| `docs/architecture.md` | 架构、插件系统、数据模型、适配器细节、全部决策记录 |
| `docs/DEVLOG.md` | 追加式进展日志,**最新一条 = 当前进度与下一步** |

## 技术栈(已定,勿改)

- Electron + TypeScript(strict)+ React + CodeMirror 6(M4 编辑器)
- 存储:笔记 = Markdown 文件(`vault/`);记忆/会话 = SQLite(better-sqlite3 + FTS5)
- 插件系统:**一步到位**,核心功能即内置插件(见 architecture.md)
- 构建:electron-vite;测试:vitest

## 目录结构

```
AGENTS.md                  ← 本文件
docs/architecture.md       ← 架构与决策记录
docs/DEVLOG.md             ← 进展日志(追加式)
src/main/                  ← 主进程:入口、插件宿主、DB
src/plugins/<id>/          ← 插件(manifest.json + index.ts)
src/preload/  src/renderer/  src/shared/
vault/                     ← MD 笔记库(Obsidian 兼容)
test/fixtures/             ← 脱敏真实会话样本(适配器测试用)
memory.db                  ← SQLite 数据库(运行时生成)
```

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # 开发模式(热重载)
npm run build        # 构建
npm run typecheck    # 类型检查
npm test             # vitest 单元测试
npm run import:scan  # 无头模式:扫描导入三个 agent 的真实会话(验收用)
npm run dist         # 打包 Windows 安装包 + 免安装目录(需 ELECTRON_BUILDER_BINARIES_MIRROR,见 DEVLOG)
```

## 开发铁律

1. **一切功能皆插件**:新增功能 = 新增 `src/plugins/<id>/`,通过 PluginContext 注册能力,禁止在宿主里写业务逻辑
2. **本地明文,出口脱敏**:入库不做脱敏,本地界面/MCP 全量可见;任何"导出/分享"路径必须过 `privacy-export` 模块
3. **处理默认本地规则**:LLM 永远是可切换的可选项,LLM 不可用时自动降级回规则
4. **不导入密钥文件**:各 agent 的 `.env`/`config.yaml`/`credentials*` 一律跳过
5. **原始文件只读**:所有适配器只读 agent 的数据,永不修改外部文件
6. **同步字段**:业务表必须带 `updated_at / device_id / deleted`(tombstone),为增量同步预留
7. 文档同步:每完成一个里程碑,追加 `docs/DEVLOG.md` 并更新本文件"当前状态"

## 当前状态(接手 agent 从这里开始)

- **M0–M6 全部完成**(2026-08-31):M5 = 审计修复 + 会话 ID + 七 agent 捕获矩阵 + 记忆 agent 维度/规则提炼/LLM 精炼 + 外部插件加载 + 液态玻璃 UI(细节见 DEVLOG);M5.2 = 外部测试修复(记忆/笔记进 MCP 全文检索、Hermes 记忆 § 分段、版本号、get_context 会话 id);**M6 = MCP 工具矩阵 v2(4→7 工具:get_context agent 过滤+交接摘要、memory_list_sessions、memory_get_session full、memory_search kind/agent/project/since 过滤、memory_write 归因+tags/project、memory_log_progress 收工汇报→候选记忆)+ 交接简报 memory_get_project_brief + 写入去重**(LLM 冲突检测顺延 M7)
- **M0–M7 完成;M8 大半完成**(2026-08-31):语义检索/托盘秒搜/项目日志/冲突检测均已上线;CI 已接(main 推送自动 ci+package);**v0.4.0 已发版**(GitHub Release 三件套,自动更新链路待下一版本验收);推送走服务器 bundle 中转(本机直连 github.com:443 被墙,见 DEVLOG);winget/scoop 提交未做(步骤在 docs/RELEASE.md)
- 精确进度:见 `docs/DEVLOG.md` 最后一条;下一步:验收 CI 绿灯与自动更新(需 v0.4.1)、winget/scoop 提交、demo 与社区发布
- 常用验证:`npm run import:scan`;`npx electron . --dispatch`;`npx electron . --sync <folder>`;`npx electron . --scan --export-archive <path>`;运行中 `curl http://127.0.0.1:8642/health`
- 验收数据(本机真实存在):Codex `~/.codex/sessions/**/rollout-*.jsonl`;ZCode `~/.zcode/cli/rollout/`;Hermes `D:\Hermes Agent CN Desktop\data\hermes-home\profiles\daily\state.db` + `memories/*.md`;其余四适配器(Claude/Gemini/Cursor/OpenCode)本机未装,合成样本单测覆盖
