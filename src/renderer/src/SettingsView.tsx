import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

type Provider = 'none' | 'openai' | 'anthropic' | 'ollama'

const PROVIDER_LABEL: Record<Provider, string> = {
  none: '本地规则(默认,无 LLM)',
  openai: 'OpenAI 兼容 API',
  anthropic: 'Anthropic API',
  ollama: 'Ollama 本地模型'
}

export default function SettingsView() {
  const [cfg, setCfg] = useState<Record<string, unknown> | null>(null)
  const [folder, setFolder] = useState('')
  const [syncInfo, setSyncInfo] = useState<{ deviceId: string; lastSyncAt: number } | null>(null)
  const [msg, setMsg] = useState('')
  const [mcpPort, setMcpPort] = useState('')
  const [dataDir, setDataDir] = useState('')
  const [pluginList, setPluginList] = useState<Array<{ id: string; name: string; version: string; enabled: boolean; external: boolean }>>([])
  const [loadErrors, setLoadErrors] = useState<string[]>([])
  const [pluginsDir, setPluginsDir] = useState('')

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
    } catch {
      /* mcp disabled */
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const set = (key: string, value: string): void => setCfg((c) => (c ? { ...c, [key]: value } : c))

  const saveLlm = useCallback(async () => {
    if (!cfg) return
    await api.llmSetConfig(cfg)
    setCfg(await api.llmGetConfig())
    setMsg(`摘要引擎已保存(${String(cfg.provider)})`)
  }, [cfg])

  if (!cfg) return <div className="empty detail-empty">加载中…</div>

  const provider = String(cfg.provider) as Provider

  return (
    <div className="settings-pane">
      <div className="pane-title">设置</div>
      <div className="settings-body">
        <section>
          <h3>摘要引擎</h3>
          <p className="hint">
            默认本地规则,零成本零依赖。切换为 LLM 后新导入的会话用模型生成标题与摘要;LLM 不可用时自动降级回规则。
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
                <span>API Key{Boolean(cfg.hasOpenaiKey) && '(已保存,留空保持不变)'}</span>
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
                      setMsg(`已获取 ${r.models.length} 个模型`)
                    } else setMsg(r.message ?? '获取失败')
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
                      setMsg(`已获取 ${r.models.length} 个模型`)
                    } else setMsg(r.message ?? '获取失败')
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
                      setMsg(`已获取 ${r.models.length} 个模型`)
                    } else setMsg(r.message ?? '获取失败')
                  })
                }
                models={(cfg._models as string[] | undefined) ?? []}
              />
            </>
          )}

          <button className="btn btn-accent btn-small" onClick={() => void saveLlm()}>
            保存摘要引擎
          </button>
          {Boolean(cfg.available) && provider !== 'none' && (
            <span className="ok-tag">✓ 已就绪,新导入将使用 LLM 摘要</span>
          )}
        </section>

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
                  .then(() => setMsg('同步文件夹已保存'))
                  .catch((e) => setMsg(`保存失败: ${String(e)}`))
              }
            >
              保存文件夹
            </button>
            <button
              className="btn btn-small"
              onClick={() =>
                void api.syncNow().then(
                  (r) =>
                    setMsg(
                      `同步完成:拉取 ${r.filesPulled} 个文件,新增会话 ${r.sessionsAdded},更新 ${r.sessionsUpdated},新增记忆 ${r.memoriesAdded}`
                    ),
                  (e) => setMsg(`同步失败: ${String(e)}`)
                )
              }
            >
              立即同步
            </button>
          </div>
          {syncInfo && (
            <p className="hint">
              设备 ID: {syncInfo.deviceId} · 上次同步: {syncInfo.lastSyncAt ? new Date(syncInfo.lastSyncAt).toLocaleString('zh-CN') : '从未'}
            </p>
          )}
        </section>

        <section>
          <h3>存储位置</h3>
          <p className="hint">
            整个知识库(数据库 + 笔记 + 设置)的存放目录。迁移会复制全部数据到新目录并在重启后切换,原目录保留可回退。
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
                  .then(() => setMsg('迁移完成,应用即将重启…'))
                  .catch((e) => setMsg(`迁移失败: ${String(e)}`))
              }
            >
              迁移到新目录
            </button>
            <button
              className="btn btn-small"
              onClick={() =>
                void api
                  .hostDataDir(undefined, true)
                  .then(() => setMsg('将恢复默认位置,应用即将重启…'))
                  .catch((e) => setMsg(`操作失败: ${String(e)}`))
              }
            >
              恢复默认位置
            </button>
          </div>
        </section>

        <section>
          <h3>MCP 服务</h3>
          <p className="hint">agent 连接端点 http://127.0.0.1:端口/mcp。端口被占用时自动向后顺延并在侧栏提示。</p>
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
                .then(() => setMsg('端口已保存,重启生效'))
                .catch((e) => setMsg(`保存失败: ${String(e)}`))
            }
          >
            保存端口
          </button>
        </section>

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
          {pluginList.map((p) => (
            <div key={p.id} className="field-row">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) =>
                    void api
                      .hostPluginEnable(p.id, e.target.checked)
                      .then(() => setMsg(`${p.name} 已${e.target.checked ? '启用' : '停用'},重启生效`))
                      .catch((err) => setMsg(`操作失败: ${String(err)}`))
                  }
                />
                <span className="slider" />
              </label>
              <span className="mono-tag">
                {p.name} ({p.id}@{p.version}){p.external ? ' · 外部' : ''}
              </span>
            </div>
          ))}
          <button className="btn btn-small" onClick={() => void window.memorysql.invoke('memorysql:host:openPluginsDir')}>
            打开插件目录
          </button>
        </section>

        <section>
          <h3>Agent 会话捕获</h3>
          <p className="hint">启停各家 agent 的会话自动导入(关闭后重启应用生效);数据路径可改。未检测到数据目录的 agent 会显示「未检测到」,装好后点立即扫描或等增量监听。</p>
          <AgentCaptureSection onMsg={setMsg} />
        </section>

        <section>
          <h3>自定义 agent 登记</h3>
          <p className="hint">
            使用未内置支持的 agent?登记它的项目目录与要捕获的文件(如 AGENTS.md / CLAUDE.md / MEMORY.md / *.jsonl),
            命中文件将只读导入为该 agent 的记忆。
          </p>
          <WatcherSection onMsg={setMsg} />
        </section>

        {msg && <div className="kb-msg">{msg}</div>}
      </div>
    </div>
  )
}

function WatcherSection({ onMsg }: { onMsg: (s: string) => void }) {
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
                onMsg('自定义 agent 已登记并导入')
              })
              .catch((e) => onMsg(`登记失败: ${String(e)}`))
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
  { id: 'capture-claudecode', label: 'Claude Code', pathKey: 'sourceRoot' },
  { id: 'capture-gemini', label: 'Gemini CLI', pathKey: 'sourceRoot' },
  { id: 'capture-cursor', label: 'Cursor(实验性)', pathKey: null },
  { id: 'capture-opencode', label: 'OpenCode / Copilot CLI', pathKey: null }
]

function AgentCaptureSection({ onMsg }: { onMsg: (s: string) => void }) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [status, setStatus] = useState<Record<string, { available: boolean; sourceRoot: string; detail: string }>>({})
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
            detail: s.lastError
              ? `错误: ${s.lastError}`
              : s.lastScanAt
                ? `${s.sessionsImported} 新导入 / ${s.sessionsFound} 扫描`
                : s.available
                  ? '已检测到,待扫描'
                  : '未检测到'
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
          <div key={a.id} className={`agent-row ${on ? '' : 'agent-off'}`}>
            <label className="switch">
              <input
                type="checkbox"
                checked={on}
                onChange={(e) =>
                  void api
                    .hostPluginEnable(a.id, e.target.checked)
                    .then(() => {
                      setEnabled((prev) => ({ ...prev, [a.id]: e.target.checked }))
                      onMsg(`${a.label} 已${e.target.checked ? '启用' : '停用'},重启应用生效`)
                    })
                    .catch((err) => onMsg(`操作失败: ${String(err)}`))
                }
              />
              <span className="slider" />
            </label>
            <div className="agent-main">
              <div className="agent-name">
                {a.label}
                {st && <span className={`agent-state ${st.available ? 'ok' : 'dim'}`}>{st.detail}</span>}
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
                        .then(() => onMsg(`${a.label} 数据路径已保存,重启生效`))
                        .catch((err) => onMsg(`保存失败: ${String(err)}`))
                    }
                  >
                    存路径
                  </button>
                </div>
              )}
            </div>
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
  const listId = `models-${value.length}-${models.length}`
  return (
    <label className="field">
      <span>模型(可手输,或点「获取模型列表」)</span>
      <div className="field-row">
        <input className="grow" list={listId} value={value} onChange={(e) => onChange(e.target.value)} />
        <button className="btn btn-small" onClick={onFetch}>
          获取模型列表
        </button>
      </div>
      <datalist id={listId}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </label>
  )
}
