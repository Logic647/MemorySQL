import fs from 'node:fs'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'

/**
 * 记忆分发:把知识库里的活跃记忆反向生成为各 agent 可消费的文件,
 * 写入 vault/dispatch/(不直接改写 Hermes/Codex 的活文件,避免覆盖
 * 它们自己维护的内容;项目侧用 AGENTS-snippet 粘贴或 M4 的监听同步)。
 */
const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'memory-dispatch',
    name: 'Memory Dispatch',
    version: '0.1.0',
    requires: ['core-schema']
  },

  init(ctx) {
    ctx.ipc.handle('generate', () => {
      const rows = ctx.db.sqlite
        .prepare(
          `SELECT kind, content, updated_at FROM memories
           WHERE status = 'active' AND deleted = 0
           ORDER BY CASE kind WHEN 'persona' THEN 0 WHEN 'preference' THEN 1 ELSE 2 END, updated_at DESC`
        )
        .all() as Array<{ kind: string; content: string; updated_at: number }>

      const persona = rows.filter((r) => r.kind === 'persona').map((r) => r.content)
      const facts = rows.filter((r) => r.kind !== 'persona')

      const memoryMd = [
        '# MemorySQL 记忆分发',
        `> 生成于 ${new Date().toLocaleString('zh-CN')} · 由知识库活跃记忆自动汇编,可被任意 agent 作为长期记忆加载`,
        '',
        '## 开发者画像',
        ...(persona.length > 0 ? persona.map((p) => p.split('\n').map((l) => `- ${l}`).join('\n')) : ['- (暂无)']),
        '',
        '## 长期记忆',
        ...(facts.length > 0 ? facts.map((f) => `- [${f.kind}] ${f.content.replace(/\n/g, ' ')}`) : ['- (暂无)']),
        ''
      ].join('\n')

      const agentsSnippet = [
        '<!-- MemorySQL 生成的开发者记忆片段,可整段粘贴进项目 AGENTS.md / CLAUDE.md -->',
        '<memorysql_context>',
        '## 开发者画像',
        ...(persona.length > 0 ? persona.flatMap((p) => p.split('\n')) : ['(见 vault/dispatch/MEMORY.md)']),
        '',
        '## 关键事实与偏好',
        ...(facts.slice(0, 20).map((f) => `- [${f.kind}] ${f.content.replace(/\n/g, ' ')}`)),
        '</memorysql_context>',
        ''
      ].join('\n')

      // user-configurable via settings key `dispatchDir`
      const custom = String(ctx.settings.get('dispatchDir', '') || '').trim()
      const dir = custom || path.join(ctx.env.vaultDir, 'dispatch')
      fs.mkdirSync(dir, { recursive: true })
      const files = [path.join(dir, 'MEMORY.md'), path.join(dir, 'AGENTS-snippet.md')]
      fs.writeFileSync(files[0], memoryMd, 'utf-8')
      fs.writeFileSync(files[1], agentsSnippet, 'utf-8')
      ctx.log.info(`dispatch files generated: ${files.join(', ')}`)
      return { files }
    })
  }
}

export default plugin
