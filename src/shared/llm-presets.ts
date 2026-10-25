/**
 * LLM provider presets — 纯数据,主进程(summarizer-llm)与设置页共用。
 * 放 shared 是刻意的:不带任何 node/electron 依赖,两边都能安全 import。
 *
 * 预设信息核对日期 2026-10-25;免费档/模型名随时可能调整——UI 里始终可手改,
 * 「获取模型列表」以服务端返回为准。免费 API 格局调研记录见 DEVLOG 同日条。
 */
export interface LlmPreset {
  id: string
  label: string
  baseUrl: string
  model: string
  /**
   * token 上限字段策略:
   * - 'max_tokens'(默认):通用,OpenAI 严格模式对两字段同发会 400
   * - 'both':MiMo 需要 max_completion_tokens,双发已在 check-llm/看板链路长期验证
   */
  tokens?: 'max_tokens' | 'both'
  /** true = 该预设无需 API Key(本地反代/自定义网关),只校验 Base URL */
  keyless?: boolean
  /** 设置页展示的一句提示 */
  note?: string
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'zhipu',
    label: '智谱 GLM(免费)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7-flash',
    note: '免费 128K 上下文,总结类任务首选。免费模型不在 /models 列表里,模型名需手填(选预设已自动填)。'
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow(免费档)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-8B',
    note: '开源小模型免费调用(约 1000 RPM),适合高频轻量总结。'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek(低价)',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    note: '按量计费、质量稳,适合愿意花一点钱换质量。'
  },
  {
    id: 'mimo',
    label: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.6-flash',
    tokens: 'both',
    note: '双认证头兼容已自动处理。v2.5 系列已于 2026-10-21 下线,勿再用。'
  },
  {
    id: 'localproxy',
    label: '本地反代(OpenCode Zen / CLIProxyAPI 等)',
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: '',
    keyless: true,
    note: '先启动 opencode2api / CLIProxyAPI / opencode-free-proxy 等反代(端口按实际配置改),再点「获取模型列表」——免费档是 qwen3-coder / grok-code / kimi / minimax 这批,不写死。'
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  {
    id: 'custom',
    label: '自定义(任意 OpenAI 兼容端点)',
    baseUrl: '',
    model: '',
    keyless: true,
    note: '手填 Base URL / Key / 模型,兼容一切 OpenAI 风格网关(含无 Key 的内网网关)。'
  }
]

export function presetById(id: string): LlmPreset | undefined {
  return LLM_PRESETS.find((p) => p.id === id)
}
