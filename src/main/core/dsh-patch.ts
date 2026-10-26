import fs from 'node:fs'
import path from 'node:path'

/**
 * DeepSeek Harness(dsh)的 MCP 配置写入。
 * ============================================================================
 * dsh 的 MCP 配置是 **YAML 而非 JSON**:写在 `~/.dsh/cordis.patch.yml` 里,作为一个
 * `- insert:` 补丁条目(见上游 packages/mcp/mcp-client/README.md):
 *
 *   - insert:
 *       - id: memorysql
 *         name: '@deepseek-ai/dsh-mcp-client'
 *         config:
 *           serverName: memorysql
 *           transport: streamable-http
 *           url: "http://127.0.0.1:8642/mcp"
 *
 * 单独成模块的理由:这是本仓库唯一一处「YAML 文本手术」,逻辑比 JSON 连接器复杂
 * 得多(缩进界定条目边界、清理空壳父级、CRLF 兼容),放在连接器表里会淹没主干。
 */

/**
 * 校验 MemorySQL MCP 端点是合法的本机地址,并以 YAML 引号标量形式序列化。
 *
 * dsh 的 cordis.patch.yml 支持 `!!js` 标签 —— 任何能带换行/标签的输入都可能被
 * 当作 YAML 注入执行。这里把写入值收紧成「本机 MCP 端点」这一种白名单形态:
 * 只接受 127.0.0.1 / localhost / [::1],路径固定 `/mcp`。
 * 注意 JS 的 `$` 在不带 `m` 标志时**不会**匹配结尾换行之前,所以带尾部换行的
 * 注入串会被正则拒绝(已实测)。
 */
export function dshUrlScalar(mcpUrl: string): string {
  const ok = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?\/mcp$/.test(mcpUrl)
  if (!ok) throw new Error(`非法的本机 MCP 端点,拒绝写入: ${mcpUrl}`)
  return JSON.stringify(mcpUrl)
}

/** 缩进宽度(空格计;够用于我们自己写出的 4/6/8 空格结构)。 */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** 该行(去掉行尾空白与缩进后)是否就是 `- id: memorysql`。 */
function isOurEntryHeader(line: string): boolean {
  return line.trimEnd().trimStart() === '- id: memorysql'
}

/** 该行(去掉行尾空白后)是否是空壳父级 `- insert:`。 */
function isInsertHeader(line: string): boolean {
  return line.trimEnd().trimStart() === '- insert:'
}

/**
 * 移除此前写入的 memorysql 条目,并清理因此变空的 `- insert:`。
 *
 * 条目边界**按缩进**判断:从 `- id: memorysql` 行起,吃掉所有空行与缩进更深的续行,
 * 遇到同级或更浅的非空行即停。只按「以空白开头」吞会连带删掉同一 insert 列表里的
 * 兄弟条目(实测会吃掉用户的其它补丁)。
 */
export function removeDshEntry(lines: string[]): string[] {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!isOurEntryHeader(lines[i])) {
      out.push(lines[i])
      i += 1
      continue
    }
    const entryIndent = indentOf(lines[i])
    i += 1
    while (i < lines.length) {
      const line = lines[i]
      if (line.trim() !== '' && indentOf(line) <= entryIndent) break
      i += 1
    }
  }

  // 清理变空的 `- insert:`(其后没有更深缩进的行)——
  // 否则每次重跑都留一个空壳,文件里会堆出 N 个 `- insert:`。
  const cleaned: string[] = []
  for (let k = 0; k < out.length; k += 1) {
    if (isInsertHeader(out[k])) {
      let j = k + 1
      while (j < out.length && out[j].trim() === '') j += 1
      if (j >= out.length || indentOf(out[j]) <= indentOf(out[k])) continue
    }
    cleaned.push(out[k])
  }
  return cleaned
}

/** 把 memorysql 补丁条目写入(或更新到)`configPath`。幂等,写前备份。 */
export function upsertDshPatch(configPath: string, mcpUrl: string): string {
  const urlScalar = dshUrlScalar(mcpUrl)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const existed = fs.existsSync(configPath)
  const raw = existed ? fs.readFileSync(configPath, 'utf-8') : ''
  if (existed) fs.copyFileSync(configPath, `${configPath}.bak-memorysql`)

  // CRLF 兼容:Windows 上按 `\n` 切分会把 `\r` 留在行尾,使条目匹配失败 →
  // 重跑产生重复条目,而上游明确拒绝同名双 server。
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const kept = removeDshEntry(raw.length > 0 ? raw.split(/\r?\n/) : [])

  const block = [
    '- insert:',
    '    - id: memorysql',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: memorysql',
    '        transport: streamable-http',
    `        url: ${urlScalar}`
  ]

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  const next = kept.length > 0 ? [...kept, '', ...block] : block
  fs.writeFileSync(configPath, next.join(eol) + eol, 'utf-8')
  return configPath
}
