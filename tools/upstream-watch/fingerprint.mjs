/**
 * 契约指纹 —— 让看板上的每一条结论都能回答「这是用哪一版适配算的」。
 *
 * ── 为什么需要它 ──
 *
 * 看板有两条互相独立的证据链:
 *   白盒  在**云端**用服务器自己那份 `upstream/ledger.json` 算
 *   黑盒  在**开发机**用本机那份 `upstream/ledger.json` 算,再 POST 上来
 *
 * 两份台账是各自 git checkout 出来的文件,服务器靠手动 `git pull`(而那条 git
 * 链路实测反复超时),所以**它们完全可能不一致**。而台账不一致的后果是:
 *
 *   白盒说「一切正常」      黑盒说「布局不匹配,需适配」
 *
 * **你无法分辨这是上游真的改了格式,还是两边台账版本不同。** 而这个判断会直接
 * 触发一次适配发版 —— 它是整个工具最不该出错的一处。
 *
 * 所以:两边各算一个指纹上报,不一致就明说。不一致**不等于**漂移,但必须先排除它。
 *
 * ── 指纹覆盖哪些字段 ──
 *
 * 只覆盖**会改变结论**的字段。`note` 明确排除:那是给人看的说明文字,
 * 改一次措辞就让全部历史结论失效的话,这个指纹很快就没人信了 —— 一个
 * 天天误报的信号等于没有信号(和当初白盒关键词泛滥是同一个教训)。
 */
import crypto from 'node:crypto'

/** 递归剔除纯说明性字段。`note` 任何层级都不参与指纹。 */
function stripNotes(value) {
  if (Array.isArray(value)) return value.map(stripNotes)
  if (value && typeof value === 'object') {
    const out = {}
    // 排序后重建,保证同样的内容在任何机器上都得到同样的字符串
    for (const k of Object.keys(value).sort()) {
      if (k === 'note' || k === 'notes') continue
      out[k] = stripNotes(value[k])
    }
    return out
  }
  return value
}

/**
 * 参与指纹的顶层字段。
 *
 * `name` 排除 —— 改显示名不影响任何判定。
 * 其余全都要:`upstream`(改仓库等于换了数据源)、`monitor`(改监控模式会换判定口径)、
 * `localRoots` / `source` / `mcp`(黑盒断言的来源)、`riskKeywords`(白盒分级依据)。
 */
const SIGNIFICANT = [
  'id',
  'agentType',
  'upstream',
  'monitor',
  'localRoots',
  'source',
  'mcp',
  'riskKeywords'
]

/**
 * 算出台账的契约指纹。
 * @param ledger 已解析的 ledger.json(含 agents 数组)
 * @returns 形如 `a1b2c3d4`(前 8 位十六进制,够用且便于口头传达)
 */
export function ledgerFingerprint(ledger) {
  const agents = ledger?.agents ?? []
  const canonical = agents.map((a) => {
    const picked = {}
    for (const k of SIGNIFICANT) if (k in a) picked[k] = stripNotes(a[k])
    return picked
  })
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 8)
}

/**
 * 比较两边的指纹。
 *
 * 三态而不是两态 —— 「探针没带指纹」和「指纹不一致」必须分开:
 * 旧版探针不带这个字段,那是**未知**,不是**冲突**。把未知报成冲突,
 * 会让人对一个其实没问题的系统去排查不存在的问题。
 *
 * @returns {{state:'match'|'mismatch'|'unknown', server:string|null, probe:string|null}}
 */
export function compareFingerprints(serverHash, probeHash) {
  const s = typeof serverHash === 'string' && serverHash ? serverHash : null
  const p = typeof probeHash === 'string' && probeHash ? probeHash : null
  if (!p) return { state: 'unknown', server: s, probe: null }
  if (!s) return { state: 'unknown', server: null, probe: p }
  return { state: s === p ? 'match' : 'mismatch', server: s, probe: p }
}
