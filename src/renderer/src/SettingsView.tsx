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

  const load = useCallback(async () => {
    setCfg(await api.llmGetConfig())
    const s = await api.syncStatus()
    setFolder(s.folder)
    setSyncInfo(s)
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
              <label className="field">
                <span>模型</span>
                <input value={String(cfg.openaiModel ?? '')} onChange={(e) => set('openaiModel', e.target.value)} />
              </label>
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
              <label className="field">
                <span>模型</span>
                <input value={String(cfg.anthropicModel ?? '')} onChange={(e) => set('anthropicModel', e.target.value)} />
              </label>
            </>
          )}

          {provider === 'ollama' && (
            <>
              <label className="field">
                <span>Ollama 地址</span>
                <input value={String(cfg.ollamaUrl ?? '')} onChange={(e) => set('ollamaUrl', e.target.value)} />
              </label>
              <label className="field">
                <span>模型</span>
                <input value={String(cfg.ollamaModel ?? '')} onChange={(e) => set('ollamaModel', e.target.value)} />
              </label>
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

        {msg && <div className="kb-msg">{msg}</div>}
      </div>
    </div>
  )
}
