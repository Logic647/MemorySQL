/**
 * 生成一个**完全虚构**的演示库,用来拍 README / 宣传截图。
 * 所有项目名、路径、记忆内容都是编的,不含任何真实数据。
 *
 * 用法: node --experimental-strip-types scripts/seed-demo.ts <数据目录>
 *   然后: MEMORYSQL_DATA_DIR=<数据目录> npx electron . --remote-debugging-port=9225
 *
 * 同时会写一份 settings.json 把**所有 capture 插件关掉** —— 否则第一次启动
 * 就会把本机真实 agent 会话导进演示库,截图直接变成隐私事故。
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations.ts'

const dir = process.argv[2]
if (!dir) throw new Error('usage: seed-demo.ts <dataDir>')
fs.mkdirSync(dir, { recursive: true })

// 演示 profile:关捕获、关 MCP 监听(避免和正在运行的实例抢 8642)、固定深色
const demoPlugins = [
  'capture-codex', 'capture-zcode', 'capture-hermes', 'capture-claudecode',
  'capture-qwencode', 'capture-kimicli', 'capture-codebuddy', 'capture-workbuddy',
  'capture-qoder', 'capture-gemini', 'capture-cursor', 'capture-opencode',
  'capture-dsh', 'capture-watcher'
]
const settings: Record<string, unknown> = { 'ui:theme': 'dark' }
for (const id of demoPlugins) settings[`plugin.${id}.enabled`] = false
settings['plugin.mcp-server.enabled'] = false
settings['plugin.project-digest.enabled'] = false
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8')

const dbPath = path.join(dir, 'memory.db')
fs.rmSync(dbPath, { force: true })
const db = new Database(dbPath)
// 元数据表必须自己建并登记版本,否则应用启动会重跑迁移 -> "table projects already exists" -> core-schema init 失败
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  plugin TEXT NOT NULL, version INTEGER NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (plugin, version))`)
const recMig = db.prepare('INSERT INTO schema_migrations (plugin, version, applied_at) VALUES (?,?,?)')
for (const m of CORE_MIGRATIONS) {
  db.exec(m.up)
  recMig.run('core-schema', m.version, Date.now())
}

// ---- projects -------------------------------------------------------------
const projects = [
  { name: 'nebula-notes', path: 'C:/dev/nebula-notes', stack: 'Electron + TypeScript + SQLite' },
  { name: 'pulse-api', path: 'C:/dev/pulse-api', stack: 'Go + PostgreSQL' },
  { name: 'garden-bot', path: 'D:/dev/garden-bot', stack: 'Python + Raspberry Pi' }
]
const insProject = db.prepare(
  'INSERT INTO projects (path, name, tech_stack, updated_at, device_id) VALUES (?,?,?,?,?)'
)
const projectId: Record<string, number> = {}
for (const p of projects) {
  projectId[p.name] = Number(insProject.run(p.path, p.name, p.stack, Date.now(), 'local').lastInsertRowid)
}

// ---- sessions -------------------------------------------------------------
interface Msg {
  role: string
  content: string
  tool?: string
  ago: number // seconds before now
}
interface Sess {
  agent: string
  ext: string
  project?: string
  title: string
  summary: string
  daysAgo: number
  sub?: boolean
  parent?: string
  messages: Msg[]
}

const T = (daysAgo: number, hour: number): number => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, 15, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

const sessions: Sess[] = [
  {
    agent: 'zcode',
    ext: 'sess_demo_a1',
    project: 'nebula-notes',
    title: '给笔记加全文检索',
    summary: '把 FTS5 接进笔记库,支持中英文混排;顺手修了分词器在中途崩溃的问题',
    daysAgo: 0,
    messages: [
      { role: 'user', content: '笔记越来越多了,搜索只能按标题匹配。把正文也接进 FTS5 吧,中文要能搜到。', ago: 4200 },
      { role: 'assistant', content: '先看了一下现有 schema:notes 表没有索引,正文存在 md 字段里。计划用 FTS5 的 trigram 分词器,它对中文按三字切分,不需要额外词典。', ago: 4100 },
      { role: 'tool', tool: 'Read', content: '{"file_path":"C:/dev/nebula-notes/src/db/schema.ts"}', ago: 4000 },
      { role: 'assistant', content: '改了三个地方:\n1. 新增 notes_fts 虚拟表(trigram)\n2. 用触发器同步 notes 的增删改\n3. 搜索接口改成两段式:先精确匹配,再走 FTS\n\n注意 trigram 要求查询词 ≥3 字符,两个字的中文查不到 —— 这条我在 UI 上加了提示。', ago: 3600 },
      { role: 'user', content: '两个字怎么办?我经常搜「同步」「部署」这种。', ago: 3300 },
      { role: 'assistant', content: '两个字走 LIKE 全表扫。实测 8000 篇笔记 41ms,可以接受;等量级再涨就上 bigram 索引。已经写进代码注释了,免得以后当成 bug。', ago: 3200 }
    ]
  },
  {
    agent: 'zcode',
    ext: 'sess_demo_a2',
    project: 'nebula-notes',
    title: '子代理:检查渲染层有没有重复渲染',
    summary: '只读分析 React 渲染路径,结论是列表项缺少 memo,滚动时每帧重渲染 300 行',
    daysAgo: 0,
    sub: true,
    parent: 'sess_demo_a1',
    messages: [
      { role: 'user', content: '你是只读分析子代理:检查 src/renderer 的列表渲染路径,找出不必要的重复渲染。只报告,不要改代码。', ago: 3800 },
      { role: 'assistant', content: '结论:NoteList 的每一项都在父组件内联生成 onClick/onChange 回调,导致 memo 失效;滚动时 300 行全部重渲染,单帧 12.4ms。\n\n证据:React DevTools Profiler 火焰图 + 手动加 console.count 验证。', ago: 3700 }
    ]
  },
  {
    agent: 'opencode',
    ext: 'sess_demo_b1',
    project: 'pulse-api',
    title: '网关的限流改成令牌桶',
    summary: '固定窗口在边界会放双倍流量,换成令牌桶;压测 2000 QPS 时 P99 从 180ms 降到 42ms',
    daysAgo: 1,
    messages: [
      { role: 'user', content: '线上偶尔出现瞬时超限,固定窗口在边界翻倍放行。换令牌桶。', ago: 90000 },
      { role: 'assistant', content: '改了 middleware/ratelimit.go:\n- 每 IP 一个桶,容量 = 限额,速率 = 限额/60\n- 桶用 sharded map 存,避免全局锁\n\n压测脚本在 scripts/bench/ratelimit.sh,2000 QPS 下 P99 42ms。', ago: 89000 },
      { role: 'tool', tool: 'Bash', content: '{"command":"go test ./middleware -run TestTokenBucket -count=1"}', ago: 88800 },
      { role: 'user', content: '顺手把配置项挪到 yaml 里,别写死在代码。', ago: 88000 },
      { role: 'assistant', content: '已挪到 config/ratelimit.yaml,支持按路由覆盖。默认值保持和原来一致,不改行为。', ago: 87800 }
    ]
  },
  {
    agent: 'opencode',
    ext: 'sess_demo_b2',
    project: 'pulse-api',
    title: '子代理:核查配置加载顺序',
    summary: '确认 yaml 覆盖顺序为 default → env → 文件,并给出三处隐患',
    daysAgo: 1,
    sub: true,
    parent: 'sess_demo_b1',
    messages: [
      { role: 'user', content: '你是子代理:核查配置加载顺序,列出优先级和潜在隐患,不要修改任何文件。', ago: 88500 },
      { role: 'assistant', content: '顺序:内置默认值 → 环境变量 → 配置文件。隐患三处:环境变量无法覆盖数组、配置文件里的拼写错误被静默忽略、热重载不校验必填项。', ago: 88400 }
    ]
  },
  {
    agent: 'codex',
    ext: 'rollout-demo-c1',
    project: 'garden-bot',
    title: '浇灌任务的重试逻辑',
    summary: '传感器偶发超时导致整轮跳过;改成单点重试 + 跳过失败点继续',
    daysAgo: 2,
    messages: [
      { role: 'user', content: '有几次浇水没执行,日志里只有一个超时。查一下。', ago: 170000 },
      { role: 'assistant', content: '找到原因:sense_all() 里任何一个传感器超时都会抛异常,外层 try 直接跳过整轮。改成每个传感器独立 try,失败记一次 warning 并跳过该点,其余照常。', ago: 169000 },
      { role: 'tool', tool: 'Bash', content: '{"command":"pytest tests/test_scheduler.py -q"}', ago: 168500 },
      { role: 'assistant', content: '补了两个用例:单点超时不影响其它点、连续三次超时触发告警。全部通过(14 passed)。', ago: 168000 }
    ]
  },
  {
    agent: 'codex',
    ext: 'rollout-demo-c2',
    project: 'garden-bot',
    title: '把日志从 print 换成结构化',
    summary: '统一成 JSON 行日志,便于用 jq 过滤;保留人读格式的开关',
    daysAgo: 4,
    messages: [
      { role: 'user', content: 'print 满天飞,查问题很痛苦。换成结构化日志。', ago: 300000 },
      { role: 'assistant', content: '统一走 logger.info({event, duration_ms, ...})。默认输出 JSON 行,设置 GARDEN_LOG=pretty 时切回人读格式,方便本地调试。', ago: 299000 }
    ]
  },
  {
    agent: 'hermes',
    ext: 'hermes-demo-1',
    project: 'nebula-notes',
    title: '导出功能的文件命名',
    summary: '导出 Markdown 时用标题做文件名,遇到特殊字符会失败;改成安全化 + 冲突去重',
    daysAgo: 3,
    messages: [
      { role: 'user', content: '导出时标题带 / 就报错。', ago: 240000 },
      { role: 'assistant', content: '文件名做了三层处理:替换非法字符 → 截断到 80 字节 → 同名追加序号。另外保留原始标题在 frontmatter 里,不丢信息。', ago: 239000 }
    ]
  },
  {
    agent: 'claudecode',
    ext: 'claude-demo-1',
    project: 'pulse-api',
    title: 'CI 上的偶发失败',
    summary: '测试依赖本地时区,CI 是 UTC;统一注入 TZ 后稳定',
    daysAgo: 5,
    messages: [
      { role: 'user', content: 'CI 上这个用例十次挂两次,本地永远过。', ago: 420000 },
      { role: 'assistant', content: '用例断言的是"今天"的统计,但本地是 UTC+8、CI 是 UTC,跨零点时结果不同。测试里显式注入 TZ=Asia/Shanghai,并在 CI 里跑两遍(00:30 和 12:30 各一次)验证。', ago: 419000 }
    ]
  },
  {
    agent: 'zcode',
    ext: 'sess_demo_a3',
    project: 'nebula-notes',
    title: '暗色主题的对比度',
    summary: '按 WCAG 逐项检查正文/次要文字/边框,把灰阶整体提亮一档',
    daysAgo: 6,
    messages: [
      { role: 'user', content: '晚上看久了眼睛累,正文对比度是不是不够?', ago: 500000 },
      { role: 'assistant', content: '正文 #94a3b8 在 #0c111b 上是 6.1:1,够 AA;但次要文字 #64748b 只有 3.4:1,低于 4.5:1。把次要文字提到 #8b9bb0(4.6:1),边框从 0.08 提到 0.12 让层次更清楚。', ago: 499000 }
    ]
  },
  {
    agent: 'codex',
    ext: 'rollout-demo-c3',
    title: '整理一下今天的待办',
    summary: '把三件事按优先级排好,两个本周完成,一个下周',
    daysAgo: 7,
    messages: [
      { role: 'user', content: '帮我理一下这周要做的。', ago: 600000 },
      { role: 'assistant', content: '按"阻塞别人 > 自己顺手 > 可以延后"排:\n1. 网关限流上线(阻塞测试环境)\n2. 笔记搜索的中文分词验证\n3. 浇灌告警接企业微信(下周)', ago: 599000 }
    ]
  },
  {
    agent: 'opencode',
    ext: 'sess_demo_b3',
    project: 'pulse-api',
    title: '接口文档自动生成',
    summary: '从路由注解生成 OpenAPI,挂到 /docs;存量接口先手写补注释',
    daysAgo: 8,
    messages: [
      { role: 'user', content: '文档总是落后于代码。能不能从注解生成?', ago: 700000 },
      { role: 'assistant', content: '用 swag 从注解生成,CI 里加一步校验:生成的 spec 与仓库里的不一致就报错。存量 12 个接口先补注释,分两次提交。', ago: 699000 }
    ]
  },
  {
    agent: 'zcode',
    ext: 'sess_demo_a4',
    project: 'nebula-notes',
    title: '打包体积又涨回去了',
    summary: '排查发现误把两个 devDependencies 打进生产包;排除后回落到 92MB',
    daysAgo: 9,
    messages: [
      { role: 'user', content: '安装包怎么又 110MB 了?之前不是 95?', ago: 800000 },
      { role: 'assistant', content: '对比了两次构建的 asar 内容,多出来的是 codemirror 和 cytoscape —— 它们已经不在依赖里,但 lockfile 里残留了旧版本,electron-builder 按 node_modules 实际内容打包。删掉 lockfile 里的孤儿项并重装,回到 92MB。', ago: 799000 }
    ]
  },
  {
    agent: 'hermes',
    ext: 'hermes-demo-2',
    project: 'garden-bot',
    title: '传感器校准脚本',
    summary: '土壤湿度读数偏高 8%,写了一个两点校准脚本并记录到设备上',
    daysAgo: 10,
    messages: [
      { role: 'user', content: '湿度读数感觉偏高,浇水太频繁了。', ago: 900000 },
      { role: 'assistant', content: '干态读数 812、湿态 233,换算后比标准值高 8%。加了校准参数并写入设备配置文件,重启后生效;脚本留在 tools/calibrate.py,下次换传感器直接跑。', ago: 899000 }
    ]
  }
]

const insSession = db.prepare(
  `INSERT INTO sessions (agent_type, external_id, project_id, cwd, started_at, ended_at, last_message_at,
     title, summary, raw_path, content_hash, message_count, tool_call_count, updated_at, device_id,
     is_subagent, parent_external_id)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
)
const insMsg = db.prepare(
  'INSERT INTO session_messages (session_id, seq, role, content, ts, tool_name) VALUES (?,?,?,?,?,?)'
)

let seqNo = 0
for (const s of sessions) {
  seqNo += 1
  const hours = [10, 14, 16, 21, 9, 11, 15, 20, 13, 17, 10, 16, 14]
  const start = T(s.daysAgo, hours[seqNo % hours.length])
  const step = 240
  const last = start + Math.max(0, s.messages.length - 1) * step
  const toolCount = s.messages.filter((m) => m.role === 'tool').length
  const sid = Number(
    insSession.run(
      s.agent,
      s.ext,
      s.project ? projectId[s.project] : null,
      s.project ? `C:/dev/${s.project}` : null,
      start,
      last,
      last,
      s.title,
      s.summary,
      '/demo/source',
      `demo-hash-${seqNo}`,
      s.messages.length,
      toolCount,
      Date.now(),
      'local',
      s.sub ? 1 : 0,
      s.parent ?? null
    ).lastInsertRowid
  )
  s.messages.forEach((m, i) => {
    insMsg.run(sid, i, m.role, m.content, start + i * step, m.tool ?? null)
  })
}
// 子会话的父 id 回填
db.exec(`UPDATE sessions SET parent_session_id = (
  SELECT p.id FROM sessions p WHERE p.agent_type = sessions.agent_type AND p.external_id = sessions.parent_external_id
) WHERE is_subagent = 1 AND parent_external_id IS NOT NULL`)

// ---- memories -------------------------------------------------------------
const memories: Array<[string, string, string]> = [
  ['persona', '独立开发者,主要写桌面工具与内部服务;偏好 TypeScript strict,后端 Go/Python 都能上手。', 'profile'],
  ['persona', '作息偏夜间,下午到凌晨是主力时间;上午一般不安排需要深度思考的任务。', 'profile'],
  ['preference', '先写最小可跑闭环,再逐步补健壮性;不接受一上来就设计大而全的抽象层。', 'distill:zcode:12'],
  ['preference', '测试优先:改行为先补用例,修 bug 先写复现。提交前必跑 typecheck + test。', 'distill:codex:31'],
  ['preference', '文案要短句、口语化,不写说明书式长段落;UI 上的提示尽量一句话说清。', 'distill:hermes:8'],
  ['preference', '不喜欢隐式魔法:配置显式、能让读代码的人一眼看懂调用链。', 'distill:opencode:19'],
  ['fact', 'nebula-notes 的全文检索用 FTS5 trigram;两字中文查询走 LIKE 兜底(须 ≥3 字符才走 FTS)。', 'distill:zcode:44'],
  ['fact', 'pulse-api 的限流是每 IP 令牌桶,配置在 config/ratelimit.yaml,可按路由覆盖。', 'distill:opencode:23'],
  ['fact', 'garden-bot 跑在树莓派上,传感器每 10 分钟采一次;连续三次超时会推告警。', 'distill:codex:57'],
  ['fact', '本机开发环境:Windows + Node 24,构建产物在 out/,打包用 electron-builder。', 'distill:codex:52'],
  ['decision', '笔记数据全部存本地 SQLite,不引入账号体系(2026-08-28 决定),保持零服务器依赖。', 'distill:zcode:7'],
  ['decision', '网关限流改成令牌桶而不是滑动窗口(2026-11-03 决定):实现简单、边界行为可解释。', 'distill:opencode:24'],
  ['decision', '文档从注解生成并纳入 CI 校验,避免文档与代码脱节(2026-11-01 决定)。', 'distill:opencode:26'],
  ['fact', 'CI 跑在 GitHub Actions;macOS 分 arm64 / Intel 两个 job 分别出包。', 'distill:codex:60']
]
const insMem = db.prepare(
  'INSERT INTO memories (kind, content, source, confidence, status, updated_at, device_id) VALUES (?,?,?,?,?,?,?)'
)
memories.forEach(([kind, content, source], i) => {
  insMem.run(kind, content, source, 1.0, 'active', Date.now() - i * 3600_000, 'local')
})
// 两条待确认候选
insMem.run(
  'preference',
  '把「每周五整理一次待办」固化成习惯:周五下班前用 memory_log_progress 汇报,下周直接接上。',
  'agent:mcp:log_progress',
  0.8,
  'candidate',
  Date.now() - 7200_000,
  'local'
)
insMem.run(
  'fact',
  'nebula-notes 的导出文件名做了安全化(替换非法字符 + 截断 80 字节 + 同名加序号)。',
  'agent:mcp:log_progress',
  0.8,
  'candidate',
  Date.now() - 5400_000,
  'local'
)

// ---- FTS ------------------------------------------------------------------
db.exec(`INSERT INTO sessions_fts (rowid, title, summary) SELECT id, title, summary FROM sessions`)
db.exec(`INSERT INTO messages_fts (rowid, content) SELECT id, content FROM session_messages`)

const n = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
const m = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
console.log(`demo db: ${dbPath}  sessions=${n.n} memories=${m.n}`)
db.close()
