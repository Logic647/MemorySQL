import fs from 'node:fs'
import path from 'node:path'

/**
 * Goose 的 MCP 配置写入。
 * ============================================================================
 * goose 的 MCP 扩展是 **YAML 而非 JSON**:写在 `~/.config/goose/config.yaml`
 * (Windows `%APPDATA%\Block\goose\config\config.yaml`)顶层 `extensions:` 映射里
 * (crates/goose/src/agents/extension.rs 的 ExtensionConfig serde,tag=cases):
 *
 *   extensions:
 *     memorysql:
 *       enabled: true
 *       type: streamable_http
 *       name: memorysql
 *       uri: "http://127.0.0.1:8642/mcp"
 *
 * 注意键是 **uri** 不是 url。与 dsh-patch 同纪律:缩进界定块边界、幂等 upsert、
 * 只动我们自己的条目、CRLF 兼容。
 */

/** 校验本机 MCP 端点并按 YAML 双引号标量序列化(复用 dsh 的白名单口径) */
export function gooseUrlScalar(mcpUrl: string): string {
  const ok = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?\/mcp$/.test(mcpUrl)
  if (!ok) throw new Error(`非法的本机 MCP 端点,拒绝写入: ${mcpUrl}`)
  return JSON.stringify(mcpUrl)
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** 我们条目的块体(相对 extensions 子键层再深一层) */
function entryBlock(url: string, indent: number): string[] {
  const pad = ' '.repeat(indent)
  const inner = ' '.repeat(indent + 2)
  return [
    `${pad}memorysql:`,
    `${inner}enabled: true`,
    `${inner}type: streamable_http`,
    `${inner}name: memorysql`,
    `${inner}uri: ${gooseUrlScalar(url)}`
  ]
}

/**
 * 在行数组里 upsert 顶层 extensions.memorysql。返回新行数组。
 * - `extensions:` 不存在 → 文件尾追加整块
 * - 存在 → 定位子键层(取 extensions: 后第一个非空行的缩进,默认 2),
 *   在该层找 `memorysql:` 替换其块体,找不到就在该层末尾插入
 */
export function upsertGooseExtension(lines: string[], url: string): string[] {
  const out = [...lines]
  const extIdx = out.findIndex((l) => l.trimEnd() === 'extensions:')
  if (extIdx < 0) {
    if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('')
    out.push('extensions:', ...entryBlock(url, 2))
    return out
  }
  // 子键层缩进:extensions: 之后**第一个**非空行的缩进(再深的都是它的孩子)
  let childIndent = 2
  let childIndentKnown = false
  let extentEnd = out.length
  for (let i = extIdx + 1; i < out.length; i++) {
    const l = out[i]
    if (l.trim() === '') continue
    const ind = indentOf(l)
    if (ind === 0) {
      extentEnd = i
      break
    }
    if (!childIndentKnown) {
      childIndent = ind
      childIndentKnown = true
    }
  }
  // 找我们的子键行(缩进 == childIndent,键 memorysql)
  const ours = `${' '.repeat(childIndent)}memorysql:`
  let blockIdx = -1
  for (let i = extIdx + 1; i < extentEnd; i++) {
    if (out[i].trimEnd() === ours.trimEnd()) {
      blockIdx = i
      break
    }
  }
  if (blockIdx >= 0) {
    // 替换块体:从我们行起吃掉所有更深层/空行,直到同层下一个键或 extent 结束
    let end = blockIdx + 1
    while (end < extentEnd) {
      const l = out[end]
      if (l.trim() === '') {
        // 空行只有后面还有本块内容才吃
        const nextMeaningful = out.slice(end + 1, extentEnd).findIndex((x) => x.trim() !== '')
        if (nextMeaningful < 0) break
        const nextLine = out[end + 1 + nextMeaningful]
        if (indentOf(nextLine) <= childIndent) break
        end++
        continue
      }
      if (indentOf(l) <= childIndent) break
      end++
    }
    out.splice(blockIdx, end - blockIdx, ...entryBlock(url, childIndent))
    return out
  }
  // 插入到 extent 末尾(extent 的最后一个非空行之后)
  let insertAt = extentEnd
  while (insertAt > extIdx + 1 && out[insertAt - 1].trim() === '') insertAt--
  out.splice(insertAt, 0, ...entryBlock(url, childIndent))
  return out
}

/** 幂等写入 goose config.yaml(存在则先备份 .bak-memorysql) */
export function upsertGooseConfig(configPath: string, mcpUrl: string): string {
  const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : ''
  const hadFile = raw !== ''
  if (hadFile) fs.copyFileSync(configPath, `${configPath}.bak-memorysql`)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw === '' ? [] : raw.split(/\r?\n/)
  // 尾随空行先去掉(append 场景避免双空行),写出时补回一个
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  const next = upsertGooseExtension(lines, mcpUrl)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, next.join(eol) + eol, 'utf-8')
  return configPath
}
