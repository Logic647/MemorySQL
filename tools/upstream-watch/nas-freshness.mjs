/**
 * NAS 探针的数据新鲜度降级 —— 「陈旧数据假阴性」的防线。
 * ============================================================================
 * 背景:黑盒 schema 检查判的是"磁盘上的数据格式匹配台账",不是"最新版本的
 * 格式匹配"。NAS 上 agent 升级了却没产生过新会话(登录过期、配额用尽、
 * CLI 起不动),检查就会拿**旧版本写的旧数据**报 🟢 —— 而看板上那颗 🟢
 * 会被当成"该 agent 当前版本已验证"。这正是本探针要消灭的盲区反向复发:
 * 看起来有结论,其实结论是几个月前的。
 *
 * 规则(只 scrutinize ok —— drift/checker_error 本身就是结论,absent 是没数据):
 *   1. 版本探测失败 → stale:无法确认数据出自当前版本,宁可黄也不绿
 *   2. 数据最新 mtime 早于当前版本的更新时间 → stale:该版本从未写过数据,
 *      🟢 是旧版本的格式,详情写明"可能登录过期"
 *   3. 其余 ok 附上 version / dataAt 后原样放行 —— 看板能看到"这个 🟢 基于
 *      哪个版本、哪天的数据"
 *
 * 纯函数 + 文件扫描分离:判定逻辑可完整单测,mtime 扫描单独可测。
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 扫一组数据根,返回最新的文件 mtime(ISO 字符串);都不存在返回 null。
 * 根可以是相对 home 的路径(台账 localRoots 的原样)或绝对路径。
 * 深度限 8:会话目录结构浅,防失控递归;只 stat 不读内容(隐私:不碰会话正文)。
 */
export function scanLatestMtime(roots, home) {
  let latest = 0
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isFile()) {
        try {
          const m = fs.statSync(p).mtimeMs
          if (m > latest) latest = m
        } catch {
          /* 竞态删除,忽略 */
        }
      } else if (e.isDirectory()) {
        walk(p, depth + 1)
      }
    }
  }
  for (const r of roots ?? []) {
    const abs = path.isAbsolute(r) ? r : path.join(home, r)
    walk(abs, 0)
  }
  return latest ? new Date(latest).toISOString() : null
}

/**
 * 对探针结果做新鲜度降级与标注。
 * @param {Array<{id:string, verdict:string, detail:string, [k:string]:unknown}>} results
 *        check.ts --json 的 results(可能已被上游改过 verdict)
 * @param {Record<string, {version: string|null, updatedAt: string|null, dataAt: string|null,
 *                        versionError?: string|null, sessionError?: string|null}>} sponsored
 *        每 NAS 侧 agent 的运行时事实。未赞助的 agent(开发机专属五家)不在此表,原样放行
 * @returns {{results: Array<object>, downgraded: string[]}}
 */
export function applyFreshness(results, sponsored) {
  const downgraded = []
  const out = (results ?? []).map((r) => {
    const s = sponsored?.[r?.id]
    if (!s) return r
    if (r.verdict !== 'ok') {
      // 非 ok 不动,但版本/数据时间仍然带上,看板有得看
      return { ...r, version: s.version ?? undefined, dataAt: s.dataAt ?? undefined }
    }
    if (s.versionError) {
      downgraded.push(r.id)
      return {
        ...r,
        verdict: 'stale',
        detail: `版本探测失败(${s.versionError}),无法确认数据出自当前版本 —— 🟢 不作为验证结论`,
        version: null,
        dataAt: s.dataAt ?? undefined
      }
    }
    if (!s.dataAt) {
      downgraded.push(r.id)
      return {
        ...r,
        verdict: 'stale',
        detail: '探针未能定位该 agent 的数据文件(扫描根与台账不符?),数据新鲜度无法确认',
        version: s.version ?? null,
        dataAt: null
      }
    }
    if (s.updatedAt && new Date(s.dataAt) < new Date(s.updatedAt)) {
      downgraded.push(r.id)
      return {
        ...r,
        verdict: 'stale',
        detail:
          `最新数据 ${s.dataAt.slice(0, 16).replace('T', ' ')} 早于当前版本 ${s.version ?? '?'} ` +
          `的更新时间(${s.updatedAt.slice(0, 16).replace('T', ' ')})—— ` +
          `该版本尚未产生过会话,可能登录过期;旧数据上的 🟢 不作为验证结论`,
        version: s.version,
        dataAt: s.dataAt
      }
    }
    return { ...r, version: s.version, dataAt: s.dataAt }
  })
  return { results: out, downgraded }
}
