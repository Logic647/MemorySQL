import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, type CuratorStatusInfo } from './api'
import { LLM_PRESETS, presetById } from '../../shared/llm-presets'
import { groupedPlugins } from './plugin-groups'

type Provider = 'none' | 'openai' | 'anthropic' | 'ollama'

/**
 * 设置页的操作反馈(who was changed → shown right under that control)。
 *
 * 以前所有消息都堆在页面末尾的一个「kb-msg」里:改的是顶部的主题,提示却
 * 出现在滚动到底才能看见的地方;切换分类后还会跟着新页面一起显示。
 * 现在按「插槽」存放,`<NoticeLine slot=…>` 就地渲染,切页时整体清空。
 */
type Notice = { text: string; tone: 'ok' | 'err' }
interface NoticeApi {
  notices: Record<string, Notice>
  push: (slot: string, text: string) => void
}

const NoticeContext = createContext<NoticeApi | null>(null)

function useNotice(): NoticeApi {
  // Provider 总会包住设置页;兜底成 no-op,避免子组件单独渲染时炸掉
  return useContext(NoticeContext) ?? { notices: {}, push: () => {} }
}

function NoticeLine({ slot }: { slot: string }) {
  const { notices } = useNotice()
  const notice = notices[slot]
  if (!notice) return null
  return <div className={`inline-msg ${notice.tone}`}>{notice.text}</div>
}

const PROVIDER_LABEL: Record<Provider, string> = {
  none: '本地规则(默认,无 LLM)',
  openai: 'OpenAI 兼容 API(智谱/SiliconFlow/DeepSeek/MiMo/本地反代…)',
  anthropic: 'Anthropic API',
  ollama: 'Ollama 本地模型'
}

const CATEGORIES = ['通用', '会话捕获', '智能引擎', '同步与备份', '插件', '关于'] as const
type Category = (typeof CATEGORIES)[number]

const PLUGIN_DESC: Record<string, string> = {
  'core-schema': '核心数据层 —— 表结构、会话入库、全文检索',
  'core-launcher': '开机自启动 —— 写入系统登录项,可选启动后驻留托盘',
  'capture-codex': 'Codex CLI 会话捕获',
  'capture-zcode': 'ZCode 会话捕获',
  'capture-hermes': 'Hermes 桌面版会话捕获',
  'capture-claudecode': 'Claude Code 会话捕获(CLI + 桌面版)',
  'capture-qwencode': 'Qwen Code(通义千问 CLI)会话捕获',
  'capture-kimicli': 'Kimi CLI 会话捕获',
  'capture-codebuddy': 'CodeBuddy Code(腾讯)会话捕获',
  'capture-workbuddy': 'WorkBuddy(腾讯)会话捕获',
  'capture-qoder': 'Qoder CLI / Qoder CN(阿里)会话捕获',
  'capture-gemini': 'Gemini CLI 会话捕获',
  'capture-cursor': 'Cursor 会话捕获(实验性)',
  'capture-opencode': 'OpenCode / Copilot CLI 会话捕获',
  'capture-dsh': 'DeepSeek Harness(dsh)会话捕获',
  'capture-watcher': '项目文件监听(AGENTS.md 等只读导入)',
  'import-chat': '对话导入 —— 粘贴/导入对话文本,覆盖加密与云端 agent',
  'mcp-server': 'MCP 服务端 —— 所有 agent 的连接入口',
  'privacy-export': '出口脱敏 —— 导出分享前自动遮蔽密钥',
  'sync-archive': '归档备份 —— .msqlv 一键导出/导入',
  'sync-folder': '增量同步 —— 通过网盘文件夹多机合并',
  'memory-core': '记忆管理 —— 增删改、冲突检测',
  'memory-dispatch': '记忆分发 —— 生成各 agent 可用的记忆文件',
  'project-devlog': '自动项目日志 —— 按项目生成 Markdown 日志文件(vault/devlog)',
  'project-digest': '项目总结 —— 滚动总结+待办(hindsight 式),LLM 可选、默认关闭',
  'memory-curator': '项目记忆自动整理 —— 从项目总结提炼全局/项目记忆,用户可编辑锁定',
  'semantic-search': '语义检索 —— 本地向量模型,字面未命中时补足召回',
  'summarizer-llm': 'LLM 摘要引擎(可选,自动降级)',
  'summarizer-rules': '本地规则摘要(默认,零依赖)'
}

export default function SettingsView() {
  const [cfg, setCfg] = useState<Record<string, unknown> | null>(null)
  const [folder, setFolder] = useState('')
  const [syncInfo, setSyncInfo] = useState<{ deviceId: string; lastSyncAt: number; plaintextAck: boolean } | null>(null)
  const [notices, setNotices] = useState<Record<string, Notice>>({})
  const push = useCallback((slot: string, text: string): void => {
    // 错误语气只影响配色,不改变文案;判定靠现有文案里的固定词,免得
    // 把 40 多个调用点全部改成 (text, tone) 二元签名
    const tone: Notice['tone'] = /失败|错误|异常|未通过/.test(text) ? 'err' : 'ok'
    setNotices((prev) => ({ ...prev, [slot]: { text, tone } }))
  }, [])
  const noticeApi = useMemo<NoticeApi>(() => ({ notices, push }), [notices, push])
  const [mcpPort, setMcpPort] = useState('')
  /**
   * MCP 端点是否对外服务。
   *
   * 这个开关以前**不存在**,而隐私披露里不得不写"目前没有关闭路径,只能退出应用" ——
   * 一份安全文档承认自己的控制缺失,比缺这个控件更糟。
   *
   * 写的是 `mcp-server:enabled` 而不是 `plugin.mcp-server.enabled`,这是刻意的:
   * 后者会让插件宿主整个跳过 mcp-server,于是 /status 与 /restart 通道消失,
   * 用户在界面里**再也打不开**(只能改文件重启)。前者只让端口不再监听,
   * 插件仍在、开关可逆。`startServer()` 本来就尊重这个键(见 mcp-server/index.ts)。
   */
  const [mcpOn, setMcpOn] = useState(true)
  const [dataDir, setDataDir] = useState('')
  const [pluginList, setPluginList] = useState<Array<{ id: string; name: string; version: string; enabled: boolean; external: boolean }>>([])
  const [loadErrors, setLoadErrors] = useState<string[]>([])
  const [pluginsDir, setPluginsDir] = useState('')
  // 分组折叠状态:纯 UI 偏好存 localStorage;默认仅「核心数据」展开,
  // 其余折叠 —— 13 个捕获插件是列表噪音的大头
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('msql.pluginGroups') ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })
  const [category, setCategory] = useState<Category>('通用')
  const [themeSetting, setThemeSetting] = useState<'dark' | 'light' | 'system'>('dark')
  const [llmTesting, setLlmTesting] = useState(false)
  const [llmTest, setLlmTest] = useState<{ ok: boolean; message: string } | null>(null)

  const load = useCallback(async () => {
    setCfg(await api.llmGetConfig())
    const s = await api.syncStatus()
    setFolder(s.folder)
    setSyncInfo(s)
    try {
      const hp = await api.hostPlugins()
      setPluginList(hp.plugins)
      setLoadErrors(hp.loadErrors ?? [])
      setPluginsDir(hp.pluginsDir ?? '')
    } catch {
      /* host channels unavailable */
    }
    try {
      const m = await api.mcpStatus()
      setMcpPort(String(m.requestedPort ?? m.port))
      setMcpOn(m.enabled !== false)
    } catch {
      // 注意:这里捕的是 **host 通道不可用**(如开发环境下部分通道未注册),
      // 不是"MCP 被禁用"。旧注释写成后者会误导排查方向。
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 切页即清空:提示属于"刚才在哪个分类里做了什么",不该跨页存活
  useEffect(() => {
    setNotices({})
  }, [category])

  // 外观主题:主进程是真相源,设置页打开时读一次当前值
  useEffect(() => {
    void api
      .theme()
      .then((t) => setThemeSetting(t.setting))
      .catch(() => {
        /* host 通道不可用时保持默认值 */
      })
    // 顶栏的日月按钮也能切主题 —— 不订阅的话这里的 chip 会停留在他处切换前的值
    return window.memorysql.on('push:theme', (state) => {
      const setting = (state as { setting?: unknown } | undefined)?.setting
      if (setting === 'dark' || setting === 'light' || setting === 'system') setThemeSetting(setting)
    })
  }, [])

  const set = (key: string, value: string): void => setCfg((c) => (c ? { ...c, [key]: value } : c))

  const togglePlugin = useCallback((p: { id: string; name: string }, next: boolean): void => {
    // optimistic:先翻开关再等 IPC;失败回滚,不能让界面显示一个并未生效的状态
    setPluginList((prev) => prev.map((q) => (q.id === p.id ? { ...q, enabled: next } : q)))
    push(`plugin:${p.id}`, `${p.name} 已${next ? '启用' : '停用'},重启生效`)
    void api.hostPluginEnable(p.id, next).catch((err) => {
      setPluginList((prev) => prev.map((q) => (q.id === p.id ? { ...q, enabled: !next } : q)))
      push(`plugin:${p.id}`, `操作失败: ${String(err)}`)
    })
  }, [push])

  const saveLlm = useCallback(async () => {
    if (!cfg) return
    await api.llmSetConfig(cfg)
    setCfg(await api.llmGetConfig())
    push('llm', `LLM 引擎已保存(${String(cfg.provider)})`)
  }, [cfg, push])

  const testConn = useCallback(async () => {
    if (!cfg) return
    setLlmTesting(true)
    setLlmTest(null)
    try {
      // 直接测界面当前值(未保存的草稿也生效;掩码 Key 在主进程被跳过不覆盖)
      setLlmTest(await api.llmTestConnection(cfg))
    } catch (e) {
      setLlmTest({ ok: false, message: `测试请求失败: ${String(e)}` })
    } finally {
      setLlmTesting(false)
    }
  }, [cfg])

  if (!cfg) return <div className="empty detail-empty">加载中…</div>

  const provider = String(cfg.provider) as Provider

  return (
    <div className="settings-pane">
      <div className="pane-title">设置</div>
      <aside className="sidebar settings-sidebar">
        {CATEGORIES.map((c) => (
          <button key={c} className={`side-item ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>
            {c}
          </button>
        ))}
      </aside>
      <NoticeContext.Provider value={noticeApi}>
      <div className="settings-main">
      <div className="settings-body">
        {category === '通用' && (
          <>
            <section>
              <h3>外观</h3>
              <p className="hint">
                深色适合长时间阅读;浅色在白天/投屏/打印场景更清楚。选「跟随系统」会随操作系统的外观设置自动切换。切换对所有窗口(含秒搜)立即生效。
              </p>
              <div className="field-row">
                {(
                  [
                    ['dark', '深色'],
                    ['light', '浅色'],
                    ['system', '跟随系统']
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={`chip ${themeSetting === value ? 'chip-active' : ''}`}
                    onClick={() => {
                      setThemeSetting(value)
                      void api
                        .setTheme(value)
                        .catch((e) => push('theme', `主题切换失败: ${String(e)}`))
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <NoticeLine slot="theme" />
            </section>

            <section>
              <h3>启动</h3>
              <p className="hint">
                开机自动运行 MemorySQL(写入系统登录项,即时生效)。启动后隐藏到托盘时窗口不弹出,MCP 服务照常可用,点托盘图标或全局秒搜热键唤起。
              </p>
              <LaunchSection />
            </section>

            <section>
              <h3>存储位置</h3>
              <p className="hint">
                整个知识库(数据库 + 生成文件 + 设置)的存放目录。迁移会复制全部数据到新目录并在重启后切换,原目录保留可回退。
              </p>
              <label className="field">
                <span>新目录</span>
                <input value={dataDir} onChange={(e) => setDataDir(e.target.value)} placeholder="D:\MemorySQL-Data" />
              </label>
              <div className="field-row">
                <button
                  className="btn btn-small"
                  disabled={!dataDir.trim()}
                  onClick={() =>
                    void api
                      .hostDataDir(dataDir.trim())
                      .then(() => push('storage', '迁移完成,应用即将重启…'))
                      .catch((e) => push('storage', `迁移失败: ${String(e)}`))
                  }
                >
                  迁移到新目录
                </button>
                <button
                  className="btn btn-small"
                  onClick={() =>
                    void api
                      .hostDataDir(undefined, true)
                      .then(() => push('storage', '将恢复默认位置,应用即将重启…'))
                      .catch((e) => push('storage', `操作失败: ${String(e)}`))
                  }
                >
                  恢复默认位置
                </button>
              </div>
              <NoticeLine slot="storage" />
            </section>

            <section>
              <h3>MCP 服务</h3>
              {/*
                端点开关。这个端点**故意不做鉴权**(免去本机 agent 的凭据交换),
                代价是本机任何进程都能读走全部记忆与会话 —— 隐私披露里写明了这一点。
                既然如此,「关掉它」就必须是一个**用户点得到**的控件,而不是
                「去改 settings.json 或退出应用」。缺这个控件时,披露文档只能写
                「目前没有关闭路径」,那是产品缺陷,不是诚实。
              */}
              <div className="field-row">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={mcpOn}
                    onChange={(e) => {
                      const next = e.target.checked
                      const prev = mcpOn
                      // 先改 UI 再等 IPC:开关的手感不能等一次磁盘写
                      setMcpOn(next)
                      void api
                        .hostPluginSetting('mcp-server', 'enabled', next)
                        // restart 让它当场生效 —— 插件的 startServer 本来就尊重这个键,
                        // 而 ipc 早就有 stop+start 通道,只是界面从没用过
                        .then(() => api.mcpRestart())
                        .then((r) => {
                          push(
                            'mcp',
                            next
                              ? r.running
                                ? 'MCP 端点已开启'
                                : '已开启设置,但服务没能监听(看侧栏端口提示)'
                              : 'MCP 端点已关闭:本机进程读不到你的记忆库,agent 也无法续接上下文'
                          )
                        })
                        .catch((err) => {
                          // 失败必须回滚,不能让界面显示一个并未生效的状态
                          setMcpOn(prev)
                          push('mcp', `操作失败: ${String(err)}`)
                        })
                    }}
                  />
                  <span className="slider" />
                </label>
                <span className="mono-tag">{mcpOn ? '已开启 · agent 可连' : '已关闭 · 本机进程也读不到'}</span>
              </div>
              <NoticeLine slot="mcp" />
              <p className="hint">
                <strong>对外提供 MCP 端点</strong>
                :agent 连接端点 http://127.0.0.1:端口/mcp。端口被占用时自动向后顺延并在侧栏提示。
                {' '}
                端点<strong>故意不做鉴权</strong>(免去本机 agent 的凭据交换),
                所以关闭开关会真的让本机任何进程都读不到你的记忆与会话,
                代价是 agent 无法自动续接上下文。详见
                <a
                  href="https://github.com/Logic647/MemorySQL/blob/main/PRIVACY.md"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {' '}
                  隐私与安全说明
                </a>
                。
              </p>
              <div className="mcp-guide">
                <div className="guide-title">使用指引</div>
                <ol>
                  <li>保持 MemorySQL 运行(它就是 MCP 服务端,可最小化到托盘)。</li>
                  <li>
                    支持 Streamable HTTP 的 agent:把 <code>http://127.0.0.1:端口/mcp</code> 填入其 MCP 配置,
                    或直接用上方「连接 Agent 向导」一键写入。
                  </li>
                  <li>
                    仅支持 stdio 的 agent:配置命令行
                    <code>node &lt;应用目录&gt;/scripts/mcp-bridge.mjs</code>(环境变量 MEMORYSQL_MCP_PORT=端口)。
                  </li>
                  <li>
                    验证连通:浏览器或终端访问 <code>http://127.0.0.1:端口/health</code>,返回 ok 即在线。
                  </li>
                  <li>工具调用入口:memory_get_context(续接包)、memory_search、memory_write 等 8 个工具。</li>
                </ol>
              </div>
              <label className="field">
                <span>端口</span>
                <input
                  value={mcpPort}
                  onChange={(e) => setMcpPort(e.target.value.replace(/\D/g, ''))}
                  placeholder="8642"
                />
              </label>
              <button
                className="btn btn-small"
                onClick={() =>
                  void api
                    .hostPluginSetting('mcp-server', 'port', Number(mcpPort) || 8642)
                    .then(() => push('mcp-port', '端口已保存,重启生效'))
                    .catch((e) => push('mcp-port', `保存失败: ${String(e)}`))
                }
              >
                保存端口
              </button>
              <NoticeLine slot="mcp-port" />
            </section>
          </>
        )}

        {category === '会话捕获' && (
          <>
            <section>
              <h3>连接 Agent 向导</h3>
              <p className="hint">
                应用运行中时,点「一键连接」把 MemorySQL 的 MCP 服务写入对应 agent 的配置文件(自动备份原配置),
                重启该 agent 后即可使用 memory_get_context / memory_search 等工具。「复制配置」给出可手工粘贴的片段。
              </p>
              <p className="hint">
                「写入规则」往该 agent 认的规则文件里追加一段带标记的工作协议,让 agent 在你没开口时就主动查记忆、记决策、做收工汇报。
                写哪个文件由台账决定(金丝雀实测/源码/官方文档测定,不许猜);幂等、可逆。只认项目级规则的 agent(qoder/codebuddy 等)需要下面的目录;
                认用户级规则的(codex/claudecode/kimi/dsh 等)留空即可对所有项目生效。
              </p>
              <AgentConnectSection />
            </section>

            <section>
              <h3>Agent 会话捕获</h3>
              <p className="hint">启停各家 agent 的会话自动导入(关闭后重启应用生效);数据路径可改。未检测到数据目录的 agent 会显示「未检测到」,装好后点立即扫描或等增量监听。</p>
              <AgentCaptureSection />
            </section>

            <section>
              <h3>自定义 agent 登记</h3>
              <p className="hint">
                使用未内置支持的 agent?登记它的项目目录与要捕获的文件(如 AGENTS.md / CLAUDE.md / MEMORY.md / *.jsonl),
                命中文件将只读导入为该 agent 的记忆。
              </p>
              <WatcherSection />
            </section>
          </>
        )}

        {category === '智能引擎' && (
          <>
            <section>
              <h3>LLM 引擎</h3>
              <p className="hint">
                默认本地规则,零成本零依赖。配置后由 会话摘要、项目总结(开启后)、记忆精炼 共用;LLM 不可用时自动降级回本地规则,数据不出本机。
              </p>
              <label className="field">
                <span>引擎</span>
                <select value={provider} onChange={(e) => set('provider', e.target.value)}>
                  {(Object.keys(PROVIDER_LABEL) as Provider[]).map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_LABEL[p]}
                    </option>
                  ))}
                </select>
              </label>

              {provider === 'openai' && (
                <>
                  <label className="field">
                    <span>预设(选后自动填 Base URL 与模型,可手改)</span>
                    <select
                      value={String(cfg.preset ?? '')}
                      onChange={(e) => {
                        const id = e.target.value
                        const p = presetById(id)
                        setCfg((c) => {
                          if (!c) return c
                          if (!p) return { ...c, preset: '' }
                          return {
                            ...c,
                            preset: id,
                            openaiBaseUrl: p.baseUrl || c.openaiBaseUrl,
                            openaiModel: p.model
                          }
                        })
                      }}
                    >
                      <option value="">(不使用预设,手填)</option>
                      {LLM_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {presetById(String(cfg.preset ?? ''))?.note && (
                    <p className="hint">{presetById(String(cfg.preset ?? ''))?.note}</p>
                  )}
                  <label className="field">
                    <span>
                      API Key
                      {presetById(String(cfg.preset ?? ''))?.keyless
                        ? '(该预设无需 Key,可留空)'
                        : Boolean(cfg.hasOpenaiKey) && '(已保存,留空保持不变)'}
                    </span>
                    <input
                      type="password"
                      value={String(cfg.openaiKey ?? '')}
                      onChange={(e) => set('openaiKey', e.target.value)}
                      placeholder="sk-…"
                    />
                  </label>
                  <label className="field">
                    <span>Base URL(可填兼容网关)</span>
                    <input value={String(cfg.openaiBaseUrl ?? '')} onChange={(e) => set('openaiBaseUrl', e.target.value)} />
                  </label>
                  <ModelField
                    value={String(cfg.openaiModel ?? '')}
                    onChange={(v) => set('openaiModel', v)}
                    onFetch={() =>
                      api.llmListModels().then((r) => {
                        if (r.ok && r.models) {
                          setCfg((c) => (c ? { ...c, _models: r.models } : c))
                          push('llm', `已获取 ${r.models.length} 个模型`)
                        } else push('llm', r.message ?? '获取失败')
                      })
                    }
                    models={(cfg._models as string[] | undefined) ?? []}
                  />
                </>
              )}

              {provider === 'anthropic' && (
                <>
                  <label className="field">
                    <span>API Key{Boolean(cfg.hasAnthropicKey) && '(已保存,留空保持不变)'}</span>
                    <input
                      type="password"
                      value={String(cfg.anthropicKey ?? '')}
                      onChange={(e) => set('anthropicKey', e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Base URL</span>
                    <input value={String(cfg.anthropicBaseUrl ?? '')} onChange={(e) => set('anthropicBaseUrl', e.target.value)} />
                  </label>
                  <ModelField
                    value={String(cfg.anthropicModel ?? '')}
                    onChange={(v) => set('anthropicModel', v)}
                    onFetch={() =>
                      api.llmListModels().then((r) => {
                        if (r.ok && r.models) {
                          setCfg((c) => (c ? { ...c, _models: r.models } : c))
                          push('llm', `已获取 ${r.models.length} 个模型`)
                        } else push('llm', r.message ?? '获取失败')
                      })
                    }
                    models={(cfg._models as string[] | undefined) ?? []}
                  />
                </>
              )}

              {provider === 'ollama' && (
                <>
                  <label className="field">
                    <span>Ollama 地址</span>
                    <input value={String(cfg.ollamaUrl ?? '')} onChange={(e) => set('ollamaUrl', e.target.value)} />
                  </label>
                  <ModelField
                    value={String(cfg.ollamaModel ?? '')}
                    onChange={(v) => set('ollamaModel', v)}
                    onFetch={() =>
                      api.llmListModels().then((r) => {
                        if (r.ok && r.models) {
                          setCfg((c) => (c ? { ...c, _models: r.models } : c))
                          push('llm', `已获取 ${r.models.length} 个模型`)
                        } else push('llm', r.message ?? '获取失败')
                      })
                    }
                    models={(cfg._models as string[] | undefined) ?? []}
                  />
                </>
              )}

              <div className="field-row">
                <button className="btn btn-accent btn-small" onClick={() => void saveLlm()}>
                  保存 LLM 引擎
                </button>
                <button className="btn btn-small" disabled={llmTesting} onClick={() => void testConn()}>
                  {llmTesting ? '测试中…' : '测试连接'}
                </button>
                {llmTest && <span className={llmTest.ok ? 'ok-tag' : 'hint'}>{llmTest.message}</span>}
              </div>
              <NoticeLine slot="llm" />
              {Boolean(cfg.available) && provider !== 'none' && (
                <span className="ok-tag">✓ 已就绪 · 会话摘要与记忆精炼将使用 LLM</span>
              )}
            </section>

            <section>
              <h3>语义检索(本地向量)</h3>
              <p className="hint">
                sqlite-vec + bge-small-zh 本地 embedding(全程离线):memory_search 字面未命中时按语义补足召回。
                为缩小安装包,原生推理组件(约 15MB)与模型(约 100MB)都在首次启用时下载,缓存于数据目录;
                停用后纯关键词检索照常。
              </p>
              <SemanticSection />
            </section>

            <section>
              <h3>项目总结(滚动摘要 + 待办)</h3>
              <p className="hint">
                定期把每个项目「上次总结之后的新会话」滚动总结成 摘要+待办+决策:会话页项目组头显示总结状态并可展开查看;
                agent 用 memory_get_project_digest 读这一份即可接手,不必翻大量历史会话。
                <strong>默认关闭</strong>;开启后,LLM 引擎可用时素材<strong>脱敏后</strong>发送至所选 provider,
                未配置 LLM 则用本地规则总结(零外发)。
              </p>
              <DigestSection />
            </section>

            <section>
              <h3>项目记忆(LLM 自动整理)</h3>
              <p className="hint">
                每次某个项目的总结完成后,LLM 把总结与最近进展提炼成「全局记忆 / 项目记忆」(画像、偏好、事实、决策),
                下次 memory_get_context 会先给记忆再看总结。<strong>自动整理直接生效</strong>,你编辑过的条目会自动锁定、不再被覆盖;
                总结和记忆素材经脱敏后发送到「LLM 引擎」所选 provider,未配置 LLM 时不会执行。
              </p>
              <MemoryCuratorSection />
            </section>
          </>
        )}

        {category === '同步与备份' && (
          <>
            <section>
              <h3>增量同步(通过同步文件夹)</h3>
              <p className="hint">
                选择 OneDrive / 坚果云等网盘同步的文件夹,多台机器各自指向同一文件夹即可双向合并(按自然键并集 + LWW;删除不传播,整库迁移用导出/导入备份)。
              </p>
              <label className="field">
                <span>同步文件夹</span>
                <input
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="D:\OneDrive\memorysql-sync-root"
                />
              </label>
              <div className="field-row">
                <button
                  className="btn btn-small"
                  onClick={() =>
                    void api
                      .syncConfigure(folder)
                      .then(() => push('sync', '同步文件夹已保存'))
                      .catch((e) => push('sync', `保存失败: ${String(e)}`))
                  }
                >
                  保存文件夹
                </button>
                <button
                  className="btn btn-small"
                  disabled={!syncInfo?.plaintextAck}
                  onClick={() =>
                    void api.syncNow().then(
                      (r) =>
                        push(
                          'sync',
                          `同步完成:拉取 ${r.filesPulled} 个文件,新增会话 ${r.sessionsAdded},更新 ${r.sessionsUpdated},新增记忆 ${r.memoriesAdded}`
                        ),
                      (e) => push('sync', `同步失败: ${String(e)}`)
                    )
                  }
                >
                  立即同步
                </button>
              </div>
              <NoticeLine slot="sync" />
              <label
                className="hint"
                style={{ display: 'flex', gap: 6, alignItems: 'flex-start', cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={syncInfo?.plaintextAck ?? false}
                  onChange={(e) =>
                    void api
                      .hostPluginSetting('sync-folder', 'plaintextAck', e.target.checked)
                      .then(() => {
                        setSyncInfo((prev) => (prev ? { ...prev, plaintextAck: e.target.checked } : prev))
                        push('sync-ack', e.target.checked ? '已确认：云同步将不做脱敏(明文写入网盘目录)' : '已撤销确认')
                      })
                      .catch((err) => push('sync-ack', `操作失败: ${String(err)}`))
                  }
                />
                我已知晓:云同步不做脱敏,会话与记忆明文写入网盘目录(两机数据一致所需)
              </label>
              <NoticeLine slot="sync-ack" />
              {syncInfo && (
                <p className="hint">
                  设备 ID: {syncInfo.deviceId} · 上次同步: {syncInfo.lastSyncAt ? new Date(syncInfo.lastSyncAt).toLocaleString('zh-CN') : '从未'}
                </p>
              )}
            </section>

            <BackupPathsSection />
          </>
        )}

        {category === '插件' && (
          <section>
            <h3>插件管理</h3>
            <p className="hint">
              外部插件放 <code>{pluginsDir || '<数据目录>/plugins'}</code> 下(每个插件一个文件夹:manifest.json + main.js),
              规范见 README。启停重启后生效。
            </p>
            {loadErrors.length > 0 && (
              <div className="kb-msg">
                {loadErrors.map((e) => (
                  <div key={e}>⚠ {e}</div>
                ))}
              </div>
            )}
            {groupedPlugins(pluginList).map(({ group, plugins }) => {
              const isCollapsed = collapsed[group.id] ?? group.id !== 'core'
              const on = plugins.filter((p) => p.enabled).length
              return (
                <div key={group.id} className="plugin-group">
                  <button
                    className="plugin-group-head"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = { ...prev, [group.id]: !isCollapsed }
                        try {
                          localStorage.setItem('msql.pluginGroups', JSON.stringify(next))
                        } catch {
                          /* 隐私模式写不进就算了,只影响本会话记忆 */
                        }
                        return next
                      })
                    }
                  >
                    <span className={`chev ${isCollapsed ? '' : 'open'}`}>▸</span>
                    <span className="plugin-group-label">{group.label}</span>
                    <span className="mono-tag">
                      {on}/{plugins.length} 启用
                    </span>
                  </button>
                  {!isCollapsed && plugins.map((p) => <PluginRow key={p.id} p={p} onToggle={togglePlugin} />)}
                </div>
              )
            })}
            {pluginList.length === 0 && <p className="hint">插件列表加载中…</p>}
            <button className="btn btn-small" onClick={() => void window.memorysql.invoke('memorysql:host:openPluginsDir')}>
              打开插件目录
            </button>
          </section>
        )}

        {category === '关于' && <AboutSection />}
      </div>
      </div>
      </NoticeContext.Provider>
    </div>
  )
}

function PluginRow({
  p,
  onToggle
}: {
  p: { id: string; name: string; version: string; enabled: boolean; external: boolean }
  onToggle: (p: { id: string; name: string }, next: boolean) => void
}) {
  return (
    <>
      <div className="plugin-row">
        <div className="plugin-main">
          <div className="field-row" style={{ margin: 0 }}>
            <label className="switch">
              <input type="checkbox" checked={p.enabled} onChange={(e) => onToggle(p, e.target.checked)} />
              <span className="slider" />
            </label>
            <span className="mono-tag">
              {p.name} ({p.id}@{p.version}){p.external ? ' · 外部' : ''}
            </span>
          </div>
          {PLUGIN_DESC[p.id] && <div className="plugin-desc">{PLUGIN_DESC[p.id]}</div>}
        </div>
      </div>
      <NoticeLine slot={`plugin:${p.id}`} />
    </>
  )
}

function BackupPathsSection() {
  const { push } = useNotice()
  const [paths, setPaths] = useState<{ backupsDir: string; dispatchDir: string; devlogDir: string } | null>(null)
  const [backupDraft, setBackupDraft] = useState('')
  const [dispatchDraft, setDispatchDraft] = useState('')
  useEffect(() => {
    void api
      .paths()
      .then((pp) => {
        setPaths(pp)
        setBackupDraft(pp.backupsDir)
        setDispatchDraft(pp.dispatchDir)
      })
      .catch(() => setPaths(null))
  }, [])
  const open = (p: string, slot: string): void => {
    void api.openPath(p).catch((e) => push(slot, `打开失败: ${String(e)}`))
  }
  return (
    <section>
      <h3>备份与生成文件位置</h3>
      <p className="hint">
        「导出备份」(.msqlv 快照)与「记忆分发」的写入目录,均可自定义;导出完成后会自动打开对应文件夹。
      </p>
      {paths && (
        <>
          <label className="field">
            <span>导出备份目录(.msqlv)</span>
            <input value={backupDraft} onChange={(e) => setBackupDraft(e.target.value)} />
          </label>
          <div className="field-row">
            <button
              className="btn btn-small"
              onClick={() =>
                void api
                  .hostPluginSetting('sync-archive', 'backupDir', backupDraft.trim())
                  .then(() => push('backup', '备份目录已保存,即时生效'))
                  .catch((e) => push('backup', `保存失败: ${String(e)}`))
              }
            >
              保存
            </button>
            <button className="btn btn-small" onClick={() => open(backupDraft.trim(), 'backup')}>
              打开
            </button>
          </div>
          <NoticeLine slot="backup" />

          <label className="field">
            <span>记忆分发目录</span>
            <input value={dispatchDraft} onChange={(e) => setDispatchDraft(e.target.value)} />
          </label>
          <div className="field-row">
            <button
              className="btn btn-small"
              onClick={() =>
                void api
                  .hostPluginSetting('memory-dispatch', 'dispatchDir', dispatchDraft.trim())
                  .then(() => push('dispatch', '分发目录已保存,即时生效'))
                  .catch((e) => push('dispatch', `保存失败: ${String(e)}`))
              }
            >
              保存
            </button>
            <button className="btn btn-small" onClick={() => open(dispatchDraft.trim(), 'dispatch')}>
              打开
            </button>
          </div>
          <NoticeLine slot="dispatch" />

          <div className="field-row">
            <span className="mono-tag" style={{ flex: 1 }}>
              项目开发日志: {paths.devlogDir}(随 vault,不可改)
            </span>
            <button className="btn btn-small" onClick={() => open(paths.devlogDir, 'devlog')}>
              打开
            </button>
          </div>
          <NoticeLine slot="devlog" />
        </>
      )}
    </section>
  )
}

/** bytes → compact MB display for the download progress line */
const fmtMB = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`

function AboutSection() {
  const { push } = useNotice()
  const [info, setInfo] = useState<{ version: string; electron: string; packaged: boolean } | null>(null)
  const [update, setUpdate] = useState<{ available: boolean; version?: string; reason?: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const [log, setLog] = useState<Array<{ tag: string; date: string | null; notes: string }>>([])
  const [upStatus, setUpStatus] = useState<{
    available?: boolean
    version?: string
    downloaded?: boolean
    downloading?: boolean
    error?: string
    checkedAt?: number
    progress?: { percent: number; transferred: number; total: number }
  } | null>(null)

  useEffect(() => {
    // startup auto-update runs in the main process; poll + subscribe so
    // "已下载待装" / check failures are visible without reopening Settings
    const pull = (): void => {
      void api
        .updateStatus()
        .then(setUpStatus)
        .catch(() => {})
    }
    pull()
    const off = api.onUpdateStatus(setUpStatus)
    const t = setInterval(pull, 15000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    void api.appInfo().then(setInfo).catch(() => setInfo(null))
    void api
      .releases()
      .then((r) => setLog(r.releases))
      .catch(() => setLog([]))
  }, [])

  const currentTag = info ? `v${info.version}` : ''
  const currentLog = log.filter((r) => r.tag === currentTag)

  const check = (): void => {
    setChecking(true)
    void api
      .checkUpdate()
      .then(setUpdate)
      .catch((e) => push('about', `检查失败: ${String(e)}`))
      .finally(() => setChecking(false))
  }

  return (
    <section>
      <h3>关于 MemorySQL</h3>
      <p className="hint">面向个人开发者的本地优先知识库 · 版本 {info?.version ?? '…'}</p>

      <div className="field-row">
        <button className="btn btn-small" disabled={checking} onClick={check}>
          {checking ? '检查中…' : '检查更新'}
        </button>
        <button className="btn btn-small" onClick={() => void api.openExternal('https://github.com/Logic647/MemorySQL')}>
          GitHub
        </button>
        <button
          className="btn btn-small"
          onClick={() => void api.openExternal('https://github.com/Logic647/MemorySQL/issues/new')}
        >
          BUG 反馈
        </button>
      </div>
      <NoticeLine slot="about" />
      {upStatus?.downloaded && (
        <>
          <p className="hint">
            新版本 v{upStatus.version ?? ''} 已下载完毕——点下面按钮立即重启安装,或稍后退出应用时自动安装。
          </p>
          <button
            className="btn btn-accent btn-small"
            onClick={() => void api.updateInstallNow().catch((e) => push('update', `安装失败: ${String(e)}`))}
          >
            立即重启安装 v{upStatus.version ?? ''}
          </button>
        </>
      )}
      {upStatus?.available && !upStatus.downloaded && upStatus.downloading && (
        <>
          {upStatus.progress && (
            <div className="update-progress" style={{ margin: '8px 0' }}>
              <div
                className="update-progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, upStatus.progress.percent))}%` }}
              />
            </div>
          )}
          <p className="hint">
            正在下载新版本 v{upStatus.version ?? ''}
            {upStatus.progress
              ? ` ${Math.round(upStatus.progress.percent)}%(${fmtMB(upStatus.progress.transferred)} / ${fmtMB(upStatus.progress.total)})`
              : ''}…(完成后会询问是否立即重启安装)
          </p>
        </>
      )}
      {upStatus?.available && !upStatus.downloaded && !upStatus.downloading && (
        <p className="hint">
          发现新版本 v{upStatus.version ?? ''}
          {upStatus.error ? `,上次下载失败(${upStatus.error})` : ''}
          ——点「下载更新包」开始下载(下载完成后才会询问是否立即安装)。
        </p>
      )}
      {upStatus?.error && !upStatus?.available && (
        <p className="hint">
          自动检查/下载更新失败({upStatus.error}),可点上方按钮手动检查。
        </p>
      )}
      {update && (
        <p className="hint">
          {update.available ? `发现新版本 v${update.version}!` : update.reason ?? '已是最新版本'}
        </p>
      )}
      {update?.available && (
        <button
          className="btn btn-accent btn-small"
          onClick={() =>
            void api
              .updateNow()
              .then((r) => push('update', r.ok ? '更新包开始下载,完成后会询问是否立即重启安装' : r.reason ?? '下载失败'))
              .catch((e) => push('update', `下载失败: ${String(e)}`))
          }
        >
          下载更新包 v{update.version}
        </button>
      )}
      <NoticeLine slot="update" />

      <h3 style={{ marginTop: 18 }}>更新日志(当前版本)</h3>
      {currentLog.length === 0 && <p className="hint">暂无当前版本的更新日志(可到 GitHub Releases 查看)。</p>}
      {currentLog.map((r) => (
        <div key={r.tag} className="release-item">
          <div className="mono-tag">
            {r.tag}
            {r.date ? ` · ${new Date(r.date).toLocaleDateString('zh-CN')}` : ''}
          </div>
          <pre className="release-notes">{r.notes.slice(0, 600)}</pre>
        </div>
      ))}
    </section>
  )
}

function LaunchSection() {
  const { push } = useNotice()
  const [status, setStatus] = useState<{ supported: boolean; openAtLogin: boolean; launchHidden: boolean } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.launcherGet())
    } catch {
      setStatus({ supported: false, openAtLogin: false, launchHidden: false })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!status) return <p className="hint">加载中…</p>
  if (!status.supported) return <p className="hint">开发模式下不可用(登录项注册的是 electron.exe)。</p>

  const apply = (enabled: boolean, launchHidden: boolean): void => {
    // optimistic: flip immediately, roll back if the login-item write fails
    setStatus((prev) => (prev ? { ...prev, openAtLogin: enabled, launchHidden: enabled ? launchHidden : prev.launchHidden } : prev))
    void api
      .launcherSet(enabled, launchHidden)
      .then((r) => setStatus((prev) => (prev ? { ...prev, ...r } : prev)))
      .catch((err) => {
        void load()
        push('launch', `设置失败: ${String(err)}`)
      })
  }

  return (
    <>
      <div className="field-row">
        <label className="switch">
          <input type="checkbox" checked={status.openAtLogin} onChange={(e) => apply(e.target.checked, status.launchHidden)} />
          <span className="slider" />
        </label>
        <span className="mono-tag">{status.openAtLogin ? '已开启开机自启动' : '已关闭'}</span>
      </div>
      {status.openAtLogin && (
        <div className="field-row">
          <label className="switch">
            <input type="checkbox" checked={status.launchHidden} onChange={(e) => apply(true, e.target.checked)} />
            <span className="slider" />
          </label>
          <span className="mono-tag">{status.launchHidden ? '启动后隐藏到托盘' : '启动后显示主窗口'}</span>
        </div>
      )}
      <NoticeLine slot="launch" />
    </>
  )
}

function SemanticSection() {
  const { push } = useNotice()
  const [status, setStatus] = useState<{
    enabled: boolean
    available: boolean
    reason?: string
    model?: string
    dims?: number
    rows?: number
    runtimeMissing?: boolean
  } | null>(null)
  const [pending, setPending] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.semanticStatus())
    } catch {
      setStatus({ enabled: false, available: false, reason: '插件不可用' })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!status) return <p className="hint">加载中…</p>
  return (
    <>
      <div className="field-row">
        <label className="switch">
          <input
            type="checkbox"
            checked={status.enabled}
            onChange={(e) => {
              const next = e.target.checked
              setStatus((prev) => (prev ? { ...prev, enabled: next } : prev))
              setPending(next)
              push('semantic', `语义检索已${next ? '启用' : '停用'},重启应用生效`)
              void api.hostPluginSetting('semantic-search', 'enabled', next).catch((err) => {
                setStatus((prev) => (prev ? { ...prev, enabled: !next } : prev))
                setPending(null)
                push('semantic', `操作失败: ${String(err)}`)
              })
            }}
          />
          <span className="slider" />
        </label>
        <span className="mono-tag">
          {pending != null
            ? `重启后${pending ? '启用' : '停用'}`
            : !status.enabled
              ? '已关闭(纯关键词检索)'
              : status.available
                ? `运行中 · ${status.model} · ${status.dims}维 · ${status.rows} 条已索引`
                : `已启用但不可用: ${status.reason ?? '未知原因'}`}
        </span>
      </div>
      {status.enabled && status.available && (
        <button
          className="btn btn-small"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void api
              .semanticReindex()
              .then((r) => push('semantic', `语义索引已重建:新增 ${r.embedded},移除 ${r.removed},共 ${r.rows} 条`))
              .catch((err) => push('semantic', `重建失败: ${String(err)}`))
              .finally(() => setBusy(false))
          }}
        >
          {busy ? '重建中…' : '重建语义索引'}
        </button>
      )}
      {status.runtimeMissing && (
        <button
          className="btn btn-accent btn-small"
          disabled={installing}
          style={{ marginTop: 8 }}
          onClick={() => {
            setInstalling(true)
            void api
              .semanticInstallRuntime()
              .then((r) =>
                push('semantic',
                  r.ok
                    ? `语义组件已就绪(v${r.version ?? ''})${r.available ? ',语义检索即时启用' : ',重启应用后生效'}`
                    : (r.message ?? '下载失败')
                )
              )
              .catch((err) => push('semantic', `下载失败: ${String(err)}`))
              .finally(() => {
                setInstalling(false)
                void load()
              })
          }}
        >
          {installing ? '下载中…(约 15MB)…' : '下载语义组件(~15MB)'}
        </button>
      )}
      <NoticeLine slot="semantic" />
    </>
  )
}

function DigestSection() {
  const { push } = useNotice()
  const [st, setSt] = useState<{
    enabled: boolean
    quietMinutes: number
    projects: Array<{ projectId: number; name: string; uncovered: number; lastDigestAt: number | null }>
  } | null>(null)
  const [quiet, setQuiet] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await api.digestStatus()
      setSt(s)
      setQuiet(String(s.quietMinutes))
    } catch {
      setSt(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!st) return <p className="hint">加载中…</p>
  const covered = st.projects.filter((p) => (p.lastDigestAt ?? 0) > 0).length
  const pending = st.projects.filter((p) => p.uncovered > 0).length
  return (
    <>
      <div className="field-row">
        <label className="switch">
          <input
            type="checkbox"
            checked={st.enabled}
            onChange={(e) => {
              const next = e.target.checked
              // 插件在触发时刻读取设置,开关即时生效,无需重启
              setSt((prev) => (prev ? { ...prev, enabled: next } : prev))
              void api
                .hostPluginSetting('project-digest', 'enabled', next)
                .then(() => {
                  push('digest-toggle',
                    next
                      ? '项目总结已开启(即时生效):新会话安静期后自动总结,会话页项目组头出现状态徽标'
                      : '项目总结已关闭:不再自动总结,也不再发送任何数据'
                  )
                  void load()
                })
                .catch((err) => {
                  setSt((prev) => (prev ? { ...prev, enabled: !next } : prev))
                  push('digest-toggle', `操作失败: ${String(err)}`)
                })
            }}
          />
          <span className="slider" />
        </label>
        <span className="mono-tag">
          {st.enabled
            ? `已开启 · ${covered}/${st.projects.length} 个项目已有总结 · ${pending} 个项目待追赶`
            : '已关闭(默认)· 不总结、不外发任何数据'}
        </span>
      </div>
      <NoticeLine slot="digest-toggle" />
      <div className="field-row">
        <label className="field" style={{ maxWidth: 320 }}>
          <span>安静期(分钟)—— 新会话入库后安静多久才自动总结</span>
          <input value={quiet} onChange={(e) => setQuiet(e.target.value.replace(/\D/g, ''))} />
        </label>
        <button
          className="btn btn-small"
          onClick={() =>
            void api
              .hostPluginSetting('project-digest', 'quietMinutes', Math.max(1, Number(quiet) || 30))
              .then(() => push('digest-quiet', '安静期已保存,即时生效'))
              .catch((e) => push('digest-quiet', `保存失败: ${String(e)}`))
          }
        >
          保存
        </button>
      </div>
      <NoticeLine slot="digest-quiet" />
      <div className="field-row">
        <button
          className="btn btn-accent btn-small"
          onClick={() =>
            void api
              .digestQueueAll()
              .then((r) => {
                if (!r.ok) {
                  push('digest-all', r.message ?? '失败')
                  return
                }
                push('digest-all',
                  r.queued
                    ? `已入队 ${r.queued} 个项目,后台逐个总结中 —— 会话页徽标与此处计数会自动刷新`
                    : '所有项目都已总结到最新,无需处理'
                )
                void load()
              })
              .catch((e) => push('digest-all', `操作失败: ${String(e)}`))
          }
        >
          立即总结全部项目
        </button>
        <span className="hint">首次总结会读完项目全部会话(分批滚动消化,单项目至多 200 个/次),之后只读上次水位之后的新会话。</span>
      </div>
      <NoticeLine slot="digest-all" />
    </>
  )
}

function MemoryCuratorSection() {
  const { push } = useNotice()
  const [st, setSt] = useState<CuratorStatusInfo | null>(null)
  const [maxProject, setMaxProject] = useState('80')
  const [maxGlobal, setMaxGlobal] = useState('40')
  const [globalHours, setGlobalHours] = useState('24')
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await api.curatorStatus()
      setSt(s)
      setMaxProject(String(s.maxProject))
      setMaxGlobal(String(s.maxGlobal))
      setGlobalHours(String(s.globalEveryHours))
      setLoadError(null)
    } catch (e) {
      setSt(null)
      setLoadError(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
    // 整理成功会发 sessions:changed;设置页也保持最新状态(切页不再需要)
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.onSessionsChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(), 1500)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [load])

  if (!st) {
    return (
      <p className="hint">
        {loadError ? '项目记忆自动整理插件未启用(可在「插件」里开启后重启应用)' : '加载中…'}
      </p>
    )
  }
  const setPluginSetting = (key: string, value: unknown, message: string): void => {
    void api
      .hostPluginSetting('memory-curator', key, value)
      .then(() => {
        push('curator', message)
        void load()
      })
      .catch((e) => push('curator', `保存失败: ${String(e)}`))
  }

  return (
    <>
      <div className="field-row">
        <label className="switch">
          <input
            type="checkbox"
            checked={st.enabled}
            onChange={(e) => {
              const next = e.target.checked
              setSt((prev) => (prev ? { ...prev, enabled: next } : prev))
              setPluginSetting('enabled', next, next ? '项目记忆自动整理已开启' : '项目记忆自动整理已关闭')
            }}
          />
          <span className="slider" />
        </label>
        <span className="mono-tag">
          {st.enabled
            ? `已开启 · ${st.projects.length} 个项目 · 全局 ${st.global.memoryCount} 条记忆`
            : '已关闭 · 不自动改动记忆'}
        </span>
      </div>
      {!st.llmReady && <p className="hint">LLM 未配置或不可用 —— 自动整理不会执行,现有记忆保持不变。</p>}
      {!st.digestEnabled && (
        <p className="hint">项目总结未开启 —— 没有新的总结可整理;请先在上面的「项目总结」中开启并生成一次。</p>
      )}

      <div className="field-row">
        <label className="field" style={{ maxWidth: 220 }}>
          <span>每个项目记忆上限</span>
          <input value={maxProject} onChange={(e) => setMaxProject(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="field" style={{ maxWidth: 220 }}>
          <span>全局记忆上限</span>
          <input value={maxGlobal} onChange={(e) => setMaxGlobal(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="field" style={{ maxWidth: 220 }}>
          <span>全局汇总间隔(小时)</span>
          <input value={globalHours} onChange={(e) => setGlobalHours(e.target.value.replace(/\D/g, ''))} />
        </label>
        <button
          className="btn btn-small"
          onClick={() => {
            setPluginSetting('maxProject', Math.max(10, Number(maxProject) || 80), '项目记忆上限已保存')
            setPluginSetting('maxGlobal', Math.max(10, Number(maxGlobal) || 40), '全局记忆上限已保存')
            setPluginSetting('globalEveryHours', Math.max(1, Number(globalHours) || 24), '全局汇总间隔已保存')
          }}
        >
          保存上限
        </button>
      </div>

      <div className="field-row">
        <button
          className="btn btn-accent btn-small"
          onClick={() =>
            void api
              .curatorRunAll()
              .then((r) => {
                push('curator', r.queued ? `已入队 ${r.queued} 个项目` : '没有需要整理的项目')
                void load()
              })
              .catch((e) => push('curator', `整理失败: ${String(e)}`))
          }
        >
          立即整理全部项目
        </button>
        <button
          className="btn btn-small"
          onClick={() =>
            void api
              .curatorRunGlobal()
              .then((r) => {
                push('curator', r.queued ? '全局记忆整理已入队' : '全局整理正在运行')
                void load()
              })
              .catch((e) => push('curator', `整理失败: ${String(e)}`))
          }
        >
          整理全局记忆
        </button>
        <span className="hint">自动整理在每次项目总结完成后触发;这里用于立即补跑。</span>
      </div>
      <NoticeLine slot="curator" />

      <div className="agent-capture">
        {st.projects.map((p) => (
          <div key={p.projectId} className="agent-row">
            <div className="agent-main">
              <div className="agent-name">
                {p.name}
                <span className={`agent-state ${p.lastError ? 'bad' : p.curated ? 'ok' : 'dim'}`}>
                  {p.lastError
                    ? `上次失败: ${p.lastError.slice(0, 80)}`
                    : p.curated
                      ? `已整理 · ${p.memoryCount} 条记忆`
                      : `未整理 · ${p.memoryCount} 条记忆`}
                </span>
              </div>
            </div>
            <button
              className="btn btn-small"
              disabled={p.status === 'running'}
              onClick={() =>
                void api
                  .curatorRun(p.projectId)
                  .then((r) => {
                    push('curator', r.queued ? `「${p.name}」整理已入队` : '该项目正在整理中')
                    void load()
                  })
                  .catch((e) => push('curator', `整理失败: ${String(e)}`))
              }
            >
              {p.status === 'running' ? '整理中…' : '立即整理'}
            </button>
          </div>
        ))}
        {st.projects.length === 0 && <p className="hint">还没有带总结的项目。</p>}
        <div className="agent-row">
          <div className="agent-main">
            <div className="agent-name">
              全局记忆
              <span className={`agent-state ${st.global.lastError ? 'bad' : st.global.memoryCount > 0 ? 'ok' : 'dim'}`}>
                {st.global.lastError
                  ? `上次失败: ${st.global.lastError.slice(0, 80)}`
                  : st.global.memoryCount > 0
                    ? `${st.global.memoryCount} 条 · ${st.global.lastRunAt ? `上次 ${new Date(st.global.lastRunAt).toLocaleString('zh-CN')}` : '尚未汇总'}`
                    : '尚未汇总'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function WatcherSection() {
  const { push } = useNotice()
  const [entries, setEntries] = useState<Array<{ agent: string; root: string; patterns: string }>>([])
  const [agent, setAgent] = useState('')
  const [root, setRoot] = useState('')
  const [patterns, setPatterns] = useState('AGENTS.md, CLAUDE.md, MEMORY.md')

  useEffect(() => {
    void api.watcherList().then((r) => setEntries(r.entries))
  }, [])

  return (
    <>
      <div className="field-row">
        <input className="grow-sm" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="agent 名(如 cline)" />
        <input className="grow" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="D:\projects\my-app" />
        <input className="grow" value={patterns} onChange={(e) => setPatterns(e.target.value)} placeholder="AGENTS.md, CLAUDE.md, *.jsonl" />
        <button
          className="btn btn-small"
          onClick={() =>
            void api
              .watcherAdd(agent, root, patterns)
              .then((r) => {
                setEntries(r.entries)
                setAgent('')
                setRoot('')
                push('watcher', '自定义 agent 已登记并导入')
              })
              .catch((e) => push('watcher', `登记失败: ${String(e)}`))
          }
        >
          登记
        </button>
      </div>
      {entries.map((e) => (
        <div key={`${e.agent}|${e.root}`} className="field-row">
          <span className="mono-tag">
            {e.agent} · {e.root} · {e.patterns}
          </span>
          <button
            className="link danger"
            onClick={() =>
              void api.watcherRemove(e.agent, e.root).then((res) => setEntries(res.entries))
            }
          >
            移除
          </button>
        </div>
      ))}
      {entries.length === 0 && <p className="hint">暂无登记</p>}
      <NoticeLine slot="watcher" />
    </>
  )
}

interface CaptureAgent {
  id: string
  label: string
  pathKey: string | null
}

const CAPTURE_AGENTS: CaptureAgent[] = [
  { id: 'capture-codex', label: 'Codex CLI', pathKey: 'sourceRoot' },
  { id: 'capture-zcode', label: 'ZCode', pathKey: 'sourceRoot' },
  { id: 'capture-hermes', label: 'Hermes CN Desktop', pathKey: 'profilesRoot' },
  { id: 'capture-claudecode', label: 'Claude Code / 桌面版', pathKey: 'sourceRoot' },
  { id: 'capture-qwencode', label: 'Qwen Code', pathKey: 'sourceRoot' },
  { id: 'capture-kimicli', label: 'Kimi CLI', pathKey: 'sourceRoot' },
  { id: 'capture-codebuddy', label: 'CodeBuddy Code', pathKey: 'sourceRoot' },
  { id: 'capture-workbuddy', label: 'WorkBuddy', pathKey: 'sourceRoot' },
  { id: 'capture-qoder', label: 'Qoder CLI / CN', pathKey: 'sourceRoot' },
  { id: 'capture-gemini', label: 'Gemini CLI', pathKey: 'sourceRoot' },
  { id: 'capture-cursor', label: 'Cursor(实验性)', pathKey: null },
  { id: 'capture-opencode', label: 'OpenCode', pathKey: null },
  { id: 'capture-dsh', label: 'DeepSeek Harness', pathKey: 'sourceRoot' },
  // 2026-11-10 批(Magpie 名单补全)+ copilot:这里漏了就会出现「侧栏亮着、
  // 设置里却没有对应开关」的状态 —— 必须在同一张表里登记。
  { id: 'capture-goose', label: 'Goose', pathKey: 'sourceRoot' },
  { id: 'capture-droid', label: 'Droid (Factory)', pathKey: 'sourceRoot' },
  { id: 'capture-cline', label: 'Cline CLI', pathKey: 'sourceRoot' },
  { id: 'capture-pi', label: 'Pi', pathKey: 'sourceRoot' },
  { id: 'capture-omp', label: 'omp (oh-my-pi)', pathKey: 'sourceRoot' },
  { id: 'capture-omo', label: 'OmO', pathKey: 'sourceRoot' },
  { id: 'capture-grok', label: 'Grok Build', pathKey: 'sourceRoot' },
  { id: 'capture-minimax', label: 'MiniMax Code', pathKey: 'sourceRoot' },
  { id: 'capture-deveco', label: 'DevEco Code', pathKey: 'sourceRoot' },
  { id: 'capture-mimocode', label: 'MiMo Code', pathKey: 'sourceRoot' },
  { id: 'capture-copilot', label: 'GitHub Copilot CLI', pathKey: 'sourceRoot' }
]

function AgentCaptureSection() {
  const { push } = useNotice()
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [status, setStatus] = useState<
    Record<
      string,
      {
        available: boolean
        sourceRoot: string
        detail: { level: 'ok' | 'warn' | 'bad' | 'dim'; text: string }
      }
    >
  >({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const load = useCallback(async (): Promise<void> => {
    const hp = await api.hostPlugins()
    const enabledMap: Record<string, boolean> = {}
    for (const p of hp.plugins) enabledMap[p.id] = p.enabled
    setEnabled(enabledMap)
    for (const a of CAPTURE_AGENTS) {
      try {
        const s = await api.captureStatus(a.id)
        setStatus((prev) => ({
          ...prev,
          [a.id]: {
            available: s.available,
            sourceRoot: s.sourceRoot,
            // 三态区分(这是第 1 期的核心):「agent 没装」与「agent 装了但我们读不懂」
            // 该采取的行动完全相反,过去两者都渲染成「未检测到」,导致误判。
            detail: !s.available
              ? { level: 'dim', text: '未检测到(该 agent 未安装,无需处理)' }
              : s.lastError
                ? { level: 'bad', text: `扫描失败: ${s.lastError}` }
                : s.health === 'failing'
                  ? {
                      level: 'bad',
                      text: `格式可能已变更 — 连续 ${s.consecutiveFailures} 次捕获失败${s.lastFailureDetail ? `: ${s.lastFailureDetail}` : ''}`
                    }
                  : s.health === 'suspect'
                    ? {
                        level: 'warn',
                        text: `捕获异常 ${s.consecutiveFailures} 次${s.lastFailureDetail ? `: ${s.lastFailureDetail}` : ''}`
                      }
                    : s.lastScanAt
                      ? {
                          level: s.sessionsFound === 0 ? 'warn' : 'ok',
                          text:
                            s.sessionsFound === 0
                              ? `已扫描但 0 条会话(源存在但没读到内容,可能格式已变)`
                              : `新增 ${s.sessionsNew ?? s.sessionsImported} / 扫描 ${s.sessionsFound}`
                        }
                      : { level: 'ok', text: '已检测到,待扫描' }
          }
        }))
        setDrafts((prev) => ({ ...prev, [a.id]: prev[a.id] ?? s.sourceRoot }))
      } catch {
        /* plugin disabled — keep defaults */
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="agent-capture">
      {CAPTURE_AGENTS.map((a) => {
        const on = enabled[a.id] ?? true
        const st = status[a.id]
        return (
          <div key={a.id} className="agent-row-group">
          <div className={`agent-row ${on ? '' : 'agent-off'} ${pending[a.id] != null ? 'agent-pending' : ''}`}>
            <label className="switch">
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => {
                  const next = e.target.checked
                  // optimistic: flip immediately so no re-render (e.g.
                  // sessions:changed refresh) can snap the knob back
                  setEnabled((prev) => ({ ...prev, [a.id]: next }))
                  setPending((prev) => ({ ...prev, [a.id]: next }))
                  push(`capture:${a.id}`, `${a.label} 已${next ? '启用' : '停用'},重启应用生效`)
                  void api
                    .hostPluginEnable(a.id, next)
                    .catch((err) => {
                      setEnabled((prev) => ({ ...prev, [a.id]: !next }))
                      setPending((prev) => ({ ...prev, [a.id]: !next }))
                      push(`capture:${a.id}`, `操作失败: ${String(err)}`)
                    })
                }}
              />
              <span className="slider" />
            </label>
            <div className="agent-main">
              <div className="agent-name">
                {a.label}
                {pending[a.id] != null && (
                  <span className={`agent-state ${pending[a.id] ? 'ok' : 'dim'}`}>重启后{pending[a.id] ? '启用' : '停用'}</span>
                )}
                {!pending[a.id] && st && (
                  <span className={`agent-state ${st.detail.level}`}>{st.detail.text}</span>
                )}
                {/* 未启用 = 没检测到源(或用户手动关掉)。给出可操作提示,
                    别让人对着一个关着的开关猜。 */}
                {!pending[a.id] && !st && !on && (
                  <span className="agent-state dim">未检测到(装好该 agent 后自动启用)</span>
                )}
              </div>
              {on && a.pathKey && st && (
                <div className="field-row">
                  <input
                    className="grow"
                    value={drafts[a.id] ?? ''}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [a.id]: e.target.value }))}
                  />
                  <button
                    className="btn btn-small"
                    onClick={() =>
                      void api
                        .hostPluginSetting(a.id, a.pathKey as string, (drafts[a.id] ?? '').trim())
                        .then(() => push(`capture:${a.id}`, `${a.label} 数据路径已保存,重启生效`))
                        .catch((err) => push(`capture:${a.id}`, `保存失败: ${String(err)}`))
                    }
                  >
                    存路径
                  </button>
                </div>
              )}
            </div>
          </div>
          <NoticeLine slot={`capture:${a.id}`} />
          </div>
        )
      })}
    </div>
  )
}

function ModelField({
  value,
  onChange,
  onFetch,
  models
}: {
  value: string
  onChange: (v: string) => void
  onFetch: () => void
  models: string[]
}) {
  // 显式候选面板,不用 <datalist>:Chromium 在 list id 动态变化(旧实现按
  // value.length/models.length 拼 id)时会丢掉候选,用户点「获取模型列表」
  // 后下拉是空的。面板还有一个好处 —— 点瞬间就能看到,不要求输入框先聚焦。
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const pick = (v: string): void => {
    onChange(v)
    setOpen(false)
  }
  return (
    <label className="field">
      <span>模型(可手输,或点「获取模型列表」)</span>
      <div className="model-field" ref={boxRef}>
        <div className="field-row">
          <input
            className="grow"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => models.length > 0 && setOpen(true)}
            onClick={() => models.length > 0 && setOpen(true)}
            placeholder={models.length > 0 ? `可选 ${models.length} 个模型` : '如 glm-4.7-flash'}
          />
          <button
            className="btn btn-small"
            onClick={() => {
              onFetch()
              setOpen(true)
            }}
          >
            获取模型列表
          </button>
        </div>
        {open && (
          <div className="model-menu" role="listbox">
            {models.length === 0 ? (
              <div className="model-menu-empty">还没有候选 —— 先点「获取模型列表」</div>
            ) : (
              models.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="option"
                  aria-selected={m === value}
                  className={`model-menu-item${m === value ? ' active' : ''}`}
                  onClick={() => pick(m)}
                >
                  {m}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </label>
  )
}

const CONNECT_AGENTS = [
  { id: 'codex', label: 'Codex CLI' },
  { id: 'zcode', label: 'ZCode' },
  { id: 'claudecode', label: 'Claude Code(CLI / 桌面版)' },
  { id: 'qwencode', label: 'Qwen Code' },
  { id: 'kimicli', label: 'Kimi CLI' },
  { id: 'codebuddy', label: 'CodeBuddy Code' },
  { id: 'workbuddy', label: 'WorkBuddy' },
  { id: 'qoder', label: 'Qoder CLI / CN' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'opencode', label: 'OpenCode / Copilot CLI' },
  { id: 'dsh', label: 'DeepSeek Harness' },
  { id: 'hermes', label: 'Hermes Agent (CN Desktop)' },
  { id: 'goose', label: 'Goose' },
  { id: 'cline', label: 'Cline CLI' },
  { id: 'pi', label: 'Pi' },
  { id: 'omp', label: 'omp (oh-my-pi)' },
  { id: 'omo', label: 'OmO' },
  { id: 'deveco', label: 'DevEco Code' },
  { id: 'mimocode', label: 'MiMo Code' },
  { id: 'copilot', label: 'Copilot CLI' }
]

function AgentConnectSection() {
  const { push } = useNotice()
  const [rows, setRows] = useState<
    Record<string, { label: string; detected: boolean; snippet: string }>
  >({})
  // 「写入使用规则」:项目级 agent 需要一个项目根目录;写哪个文件由台账 rules 字段决定
  const [rulesDir, setRulesDir] = useState('')
  const [rulesBusy, setRulesBusy] = useState<string | null>(null)

  useEffect(() => {
    for (const a of CONNECT_AGENTS) {
      void api
        .agentSnippet(a.id)
        .then((r) => setRows((prev) => ({ ...prev, [a.id]: { label: a.label, detected: r.detected, snippet: r.snippet } })))
        .catch(() => {})
    }
  }, [])

  const connect = (id: string): void => {
    void api
      .agentConnect(id)
      .then((r) => {
        if (!r.detected) {
          push(`connect:${id}`, `${r.label} 未在本机检测到,未写入配置`)
          return
        }
        // 回读校验没过 = 我们写的东西该 agent 不认。此时报「已连接」是骗人的,
        // 必须把原因摊开,否则用户只能重启后对着失效的 MCP 一头雾水。
        if (!r.configured) {
          push(`connect:${id}`, `${r.label} 已写入但回读校验未通过 → ${r.verifyError ?? '未知原因'}`)
          return
        }
        push(`connect:${id}`, `${r.label} 已连接并校验通过 → ${r.configPath}(重启该 agent 生效)`)
        return api.agentSnippet(id).then((s) => {
          setRows((prev) => ({ ...prev, [id]: { ...prev[id], snippet: s.snippet } }))
        })
      })
      .catch((e) => push(`connect:${id}`, `连接失败: ${String(e)}`))
  }

  const writeRulesFor = (id: string, label: string): void => {
    setRulesBusy(id)
    void api
      .rulesWrite(id, rulesDir.trim() || undefined)
      .then((r) => {
        if (!r.ok) {
          push(/项目根目录/.test(r.error ?? '') ? 'rules-dir' : `connect:${id}`, `${label} 规则写入失败 → ${r.error ?? '未知原因'}`)
          return
        }
        const where = [...r.written, ...r.skipped].join('、')
        push(`connect:${id}`, `${label} 使用规则已写入 → ${where}${r.skipped.length ? '(已存在,内容未变)' : ''}`)
      })
      .catch((e) => push(`connect:${id}`, `规则写入失败: ${String(e)}`))
      .finally(() => setRulesBusy(null))
  }

  return (
    <div className="agent-capture">
      <label className="field">
        <span>项目根目录(仅项目级规则的 agent 需要;用户级规则的留空即可)</span>
        <input
          value={rulesDir}
          onChange={(e) => setRulesDir(e.target.value)}
          placeholder="如 D:\projects\my-app"
        />
      </label>
      <NoticeLine slot="rules-dir" />
      {CONNECT_AGENTS.map(({ id, label }) => {
        const row = rows[id]
        return (
          <div key={id} className="agent-row-group">
          <div className="agent-row">
            <div className="agent-main">
              <div className="agent-name">
                {label}
                {row && (
                  <span className={`agent-state ${row.detected ? 'ok' : 'dim'}`}>
                    {row.detected ? '已检测到' : '未检测到'}
                  </span>
                )}
              </div>
            </div>
            <div className="field-row" style={{ margin: 0 }}>
              <button className="btn btn-small" onClick={() => connect(id)}>
                一键连接
              </button>
              <button
                className="btn btn-small"
                disabled={rulesBusy === id}
                title="往该 agent 认的规则文件里追加一段带标记的工作协议(开工查上下文/答历史先搜索/决策即记录/收工汇报)。幂等、可逆。"
                onClick={() => writeRulesFor(id, label)}
              >
                {rulesBusy === id ? '写入中…' : '写入规则'}
              </button>
              <button
                className="btn btn-small"
                onClick={() =>
                  row &&
                  void navigator.clipboard
                    .writeText(row.snippet)
                    .then(() => push(`connect:${id}`, `${label} 手动配置片段已复制`))
                }
              >
                复制配置
              </button>
            </div>
          </div>
          <NoticeLine slot={`connect:${id}`} />
          </div>
        )
      })}
    </div>
  )
}
