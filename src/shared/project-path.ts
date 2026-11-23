/**
 * 项目路径归一 —— 项目身份的唯一判定口径。
 *
 * 2026-11-23 测试报告 P2-5:同一物理目录被登记成两个项目 ——
 * `H:\桌面\MemorySQL` 与 `H:/桌面\MemorySQL`,因为不同 agent 序列化 cwd 的
 * 分隔符风格不同(claudecode 用 `/`,Windows 原生 agent 用 `\`)。后果:会话被
 * 拆到两个「项目」、项目总结只覆盖一半、项目记忆归属错位、列表出现两个同名组。
 *
 * 读取侧的三级匹配(shared/project-match.ts)只能兜底,写入侧必须统一:
 *   - Windows:分隔符统一成 `\`、合并重复、去尾部 `\`、盘符大写、UNC 前缀保留
 *   - POSIX:合并重复 `/`、去尾部 `/`
 * 比较用 `projectPathKey`(Windows 下小写),展示用 `canonicalProjectPath`。
 */

const isWin = (): boolean => process.platform === 'win32'

export function canonicalProjectPath(raw: string): string {
  const p = (raw ?? '').trim()
  if (!p) return p
  if (isWin()) {
    // UNC(\\server\share)开头两个分隔符必须保留
    if (/^[\\/]{2}/.test(p)) {
      const rest = p.slice(2).replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
      return `\\\\${rest}`
    }
    let s = p.replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
    s = s.replace(/\\+$/, '')
    if (/^[A-Za-z]:$/.test(s)) s += '\\' // 盘根保留 "C:\"
    return s.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`)
  }
  const s = p.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return s === '' ? '/' : s
}

/** 比较键:Windows 大小写不敏感;其余平台原样 */
export function projectPathKey(raw: string): string {
  const c = canonicalProjectPath(raw)
  return isWin() ? c.toLowerCase() : c
}
