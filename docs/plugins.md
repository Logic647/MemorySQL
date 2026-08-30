# MemorySQL 插件 API

> 插件系统是 MemorySQL 的骨架:**所有内置功能都是插件**,第三方插件与内置插件走同一套协议。本文件是插件开发者参考;内部实现见 `src/main/core/plugin-host.ts`。

## 插件解剖

一个插件 = `src/plugins/<id>/` 下的一个目录:

```
src/plugins/my-plugin/
├── manifest.json   # 元数据(文档用途;内置插件的权威 manifest 在代码里)
└── index.ts        # 默认导出 MemorySQLPlugin 对象
```

```ts
import type { MemorySQLPlugin } from '../../main/core/plugin-host'

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'my-plugin',            // 全局唯一,IPC 通道前缀
    name: 'My Plugin',
    version: '0.1.0',
    requires: ['core-schema']   // 依赖的插件 id,宿主按此拓扑排序启动
  },
  init(ctx) { /* 注册能力;此时依赖插件已 init */ },
  start()  { /* 可选:启动期行为(watcher、服务器) */ },
  stop()   { /* 可选:反向顺序关闭 */ }
}
export default plugin
```

生命周期:`load → init(按依赖序) → start(同序) → stop(逆序) → unload`。

## PluginContext

`init(ctx)` 提供全部能力,**插件不允许绕过它触碰宿主**:

| 能力 | 说明 |
|---|---|
| `ctx.id` / `ctx.log` | 插件 id / 带前缀日志(info/warn/error) |
| `ctx.env` | 数据目录布局:`{ dataDir, dbPath, vaultDir, settingsPath }` |
| `ctx.db.migrate(migrations)` | 按插件命名空间跑 schema 迁移 `{version, up}[]`(记录于 `schema_migrations`) |
| `ctx.db.sqlite` | better-sqlite3 句柄(主进程内同步;写操作建议 `db.transaction`) |
| `ctx.settings.get/set` | 持久化键值(`<dataDir>/settings.json`),键自动加 `<id>:` 前缀 |
| `ctx.events.on/emit` | 全局事件总线;内置事件:`sessions:changed`(数据变更,UI 自动刷新) |
| `ctx.ipc.handle(name, h)` | 注册渲染进程可调用的处理器,完整通道 = `<id>:<name>` |
| `ctx.ipc.call(channel, payload)` | 调用其它插件已注册的通道 |
| `ctx.mcp.registerTool(def)` | 注册 MCP 工具 `{name, description, inputSchema, handler}`,由 mcp-server 统一对外;**name 只允许 `[a-zA-Z0-9_-]`**,跨插件查重 |
| `ctx.mcp.list()` | 列出当前全部已注册工具 |
| `ctx.watcher.watch(targets, onChange, opts)` | chokidar 封装;`opts.match` 正则、`opts.debounceMs`;返回反注册函数 |
| `ctx.summarizer.registerProvider(p)` | 注册摘要 provider(先注册且 `available()` 为真者生效) |
| `ctx.summarizer.pickActive()` | 当前生效的 provider |
| `ctx.services.provide/use` | 插件间服务定位:`provide<T>(name, svc)` / `use<T>(name)`(依赖未就绪会抛错,靠 `requires` 保证顺序) |

## 内置插件清单

| 插件 | 职责 | 提供 |
|---|---|---|
| `summarizer-llm` | 可选 LLM 摘要(OpenAI/Anthropic/Ollama 模板) | summarizer provider(注册在 rules 前) |
| `summarizer-rules` | 本地规则摘要(永远可用,兜底) | summarizer provider |
| `core-schema` | 核心表 + 摄取管道 + trigram FTS | services: `ingest` / `search` / `memories`;MCP 工具 ×3 |
| `core-vault` | vault 笔记索引、双链/反链、FTS、图谱 | IPC `core-vault:notes:*` |
| `capture-codex` / `capture-zcode` / `capture-hermes` | 三家 agent 会话导入 + 增量监听 | IPC `<id>:status / scanNow` |
| `capture-watcher` | 项目目录 AGENTS/CLAUDE/MEMORY.md 只读导入 | IPC `capture-watcher:*` |
| `mcp-server` | MCP Streamable HTTP(127.0.0.1:8642) | `mcp-server:status / restart` |
| `privacy-export` | 出口脱敏 + 会话导出 MD | service `redact`;IPC `exportSession` |
| `sync-archive` | .msqlv 归档导出/导入 | IPC `export / import` |
| `memory-core` | 记忆 CRUD(tombstone) | IPC `save / delete / setStatus` |
| `memory-dispatch` | 记忆分发文件(vault/dispatch) | IPC `generate` |
| `sync-folder` | 网盘文件夹增量同步(自然键 + LWW) | IPC `status / configure / syncNow` |

## 关键约定

1. **一切业务逻辑皆插件** —— 宿主(`src/main/` 只有基础设施:env/settings/events/db/plugin-host/mcp-protocol/redact)
2. **本地明文,出口脱敏** —— 任何对外导出必须过 `privacy-export` 的 `redact` 服务
3. **原始文件只读** —— 适配器永不修改 agent 数据目录;写操作只进 `vault/`
4. **同步三件套** —— 新业务表必须带 `updated_at / device_id / deleted`
5. **渲染进程访问** —— preload 暴露 `window.memorysql.invoke(channel, payload)`,通道必须是已注册的 `<pluginId>:<name>`

## 最小示例:写一个 Hello 插件

```ts
// src/plugins/hello/index.ts
import type { MemorySQLPlugin } from '../../main/core/plugin-host'

const plugin: MemorySQLPlugin = {
  manifest: { id: 'hello', name: 'Hello', version: '0.1.0' },
  init(ctx) {
    ctx.ipc.handle('greet', (p) => `你好, ${String((p as { name?: string })?.name ?? '世界')}`)
    ctx.mcp.registerTool({
      name: 'hello_greet',
      description: '打招呼',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      handler: (args) => `你好, ${String(args.name ?? '世界')}`
    })
  }
}
export default plugin
```

渲染进程:`await window.memorysql.invoke('hello:greet', { name: 'MemorySQL' })`;
agent 侧:`tools/call hello_greet`。把它加进 `src/main/index.ts` 的 `BUILTIN_PLUGINS` 即生效。
外部目录加载(社区插件)规划于 M4 之后 —— 协议与此一致。
