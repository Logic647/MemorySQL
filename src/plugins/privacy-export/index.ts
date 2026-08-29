import { app, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import { redactWithCount } from '../../main/core/redact'

/**
 * Outbound channel: everything here crosses the "publish to others" boundary,
 * so EVERYTHING goes through redact() first. Local UI/MCP stay raw by design.
 */

function fmtTime(ts: number | null | undefined): string {
  return ts ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : '—'
}

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|\n\r]/g, '_').slice(0, 60) || 'session'
}

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'privacy-export',
    name: 'Privacy Export',
    version: '0.1.0',
    requires: ['core-schema']
  },

  init(ctx) {
    ctx.services.provide('redact', redactWithCount)

    ctx.ipc.handle('exportSession', async (payload) => {
      const { sessionId } = (payload ?? {}) as { sessionId?: number }
      if (!sessionId) throw new Error('exportSession requires sessionId')

      const data = (await ctx.ipc.call('core-schema:sessions:get', { sessionId })) as {
        session: {
          title: string | null
          external_id: string
          agent_type: string
          project: string | null
          started_at: number | null
          summary: string | null
        }
        messages: Array<{ role: string; content: string; ts: number | null; toolName: string | null }>
      }
      const { session, messages } = data

      const timeline = redactWithCount(
        messages
          .map((m) => {
            const role = m.role === 'tool' ? `TOOL · ${m.toolName ?? 'tool'}` : m.role.toUpperCase()
            const when = m.ts ? ` · ${fmtTime(m.ts)}` : ''
            return `### ${role}${when}\n\n${m.content}\n`
          })
          .join('\n---\n\n')
      )
      const header = redactWithCount(
        [
          `# ${session.title ?? session.external_id}\n`,
          `> 由 MemorySQL 导出 · 已做出口脱敏(${timeline.hits} 处敏感内容被遮蔽)\n`,
          `- agent: ${session.agent_type}`,
          `- 会话 ID: ${session.external_id}`,
          `- 项目: ${session.project ?? '—'}`,
          `- 开始: ${fmtTime(session.started_at)}`,
          `- 消息数: ${messages.length}\n`,
          session.summary ? `## 摘要\n\n${session.summary}\n` : ''
        ].join('\n')
      )

      const md = `${header.text}\n---\n\n${timeline.text}`
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出会话(自动脱敏)',
        defaultPath: path.join(
          app.getPath('documents'),
          `${safeName(session.title ?? session.external_id)}.md`
        ),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (canceled || !filePath) return { saved: false as const }
      fs.writeFileSync(filePath, md, 'utf-8')
      ctx.log.info(`exported session ${sessionId} -> ${filePath} (${timeline.hits} redactions)`)
      return { saved: true as const, filePath, redactions: timeline.hits }
    })
  }
}

export default plugin
