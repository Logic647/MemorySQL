import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawSession } from '../../shared/types'
import { createCapturePlugin } from '../_lib/capture-factory'
import { userDataDir } from '../../main/core/safe-path'
import {
  DESKTOP_SESSION_STORES,
  findClaudeFiles,
  findDesktopMetaFiles,
  findDesktopProjectsRoots,
  parseClaudeJsonl,
  parseDesktopMeta,
  parseHistoryJsonl
} from './claude-parser'

const claudeHome = path.join(os.homedir(), '.claude')

/** Claude 桌面端的应用数据目录(MSIX "Claude-3p"、非 MSIX "AnthropicClaude"、
 *  1P 安装的 "Claude";macOS 走 Application Support)。 */
function desktopAppDirs(): string[] {
  const out: string[] = []
  const bases = [userDataDir('local'), userDataDir('roaming')]
  if (process.platform === 'darwin') bases.push(path.join(os.homedir(), 'Library', 'Application Support'))
  for (const base of bases) for (const app of ['Claude-3p', 'AnthropicClaude', 'Claude']) out.push(path.join(base, app))
  return out
}

/** 桌面端会话存储的根(org/account 上层)。存在即说明装过 Claude 桌面版,
 *  即使 ~/.claude/projects 还没建出来,捕获插件也该默认启用。 */
function desktopStoreDirs(): string[] {
  const out: string[] = []
  for (const appDir of desktopAppDirs()) {
    for (const store of DESKTOP_SESSION_STORES) {
      const dir = path.join(appDir, store)
      if (fs.existsSync(dir)) out.push(dir)
    }
  }
  return out
}

/** 桌面端 Code 会话的 transcript 根(每次现场发现:目录在首次用 Code 标签页前不存在) */
function desktopProjectsRoots(): string[] {
  return findDesktopProjectsRoots(desktopAppDirs())
}

/** Claude Desktop 的会话元数据(local_*.json):即便是"只有元数据"的旧版,
 * 也能给出标题/项目/时间,让列表里看得见这次对话。 */
function collectDesktopMetas(): Array<{ session: RawSession; cliSessionId?: string }> {
  const out: Array<{ session: RawSession; cliSessionId?: string }> = []
  for (const appDir of desktopAppDirs()) {
    const root = path.join(appDir, 'claude-code-sessions')
    for (const file of findDesktopMetaFiles(root)) {
      try {
        const meta = parseDesktopMeta(file, fs.readFileSync(file, 'utf-8'))
        if (meta) out.push(meta)
      } catch {
        /* per-file errors are non-fatal */
      }
    }
  }
  return out
}

export default createCapturePlugin({
  id: 'capture-claudecode',
  name: 'Capture: Claude Code',
  agentType: 'claudecode',
  defaultRoot: path.join(claudeHome, 'projects'),
  // CLI 源可以不在了(只用桌面版),此时桌面端会话存储就是唯一的信号
  sourceExists: (root) =>
    fs.existsSync(root) || desktopProjectsRoots().length > 0 || desktopStoreDirs().length > 0,
  collect: (root): RawSession[] => {
    const sessions: RawSession[] = []
    // full transcripts win: their session ids suppress the prompt-only
    // history rows and the desktop metadata wrappers for the same conversation
    const transcriptIds = new Set<string>()
    // CLI 与桌面端(CCD)各有一份 CLAUDE_CONFIG_DIR,但 transcript 格式相同;
    // 同一会话可能在两边各存一份(sessionId 相同)。保留消息更多的那份 ——
    // 桌面端可能只缓存窗口内的一段,不能让它把完整的 CLI transcript 覆盖成残缺版。
    const transcriptById = new Map<string, RawSession>()
    const projectRoots = [root, ...desktopProjectsRoots()]
    const seenFiles = new Set<string>()
    for (const projectRoot of projectRoots) {
      for (const file of findClaudeFiles(projectRoot)) {
        const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
        if (seenFiles.has(key)) continue
        seenFiles.add(key)
        try {
          const s = parseClaudeJsonl(file, fs.readFileSync(file, 'utf-8'))
          if (s) {
            transcriptIds.add(s.externalId)
            const prev = transcriptById.get(s.externalId)
            if (!prev || s.messages.length > prev.messages.length) transcriptById.set(s.externalId, s)
          }
        } catch {
          /* per-file errors are non-fatal */
        }
      }
    }
    sessions.push(...transcriptById.values())

    // ~/.claude/history.jsonl + 桌面端各 config dir 下的 history.jsonl
    const historyFiles = [path.join(claudeHome, 'history.jsonl')]
    for (const projectsRoot of projectRoots.slice(1)) {
      historyFiles.push(path.join(path.dirname(projectsRoot), 'history.jsonl'))
    }
    const historyById = new Map<string, RawSession>()
    for (const historyFile of new Set(historyFiles)) {
      if (!fs.existsSync(historyFile)) continue
      try {
        for (const s of parseHistoryJsonl(fs.readFileSync(historyFile, 'utf-8'), historyFile, transcriptIds)) {
          const id = s.externalId.slice('history:'.length)
          const prev = historyById.get(id)
          if (!prev) {
            historyById.set(id, s)
            continue
          }
          // 同一个 sessionId 在多个 history 文件里出现(桌面端会把提示同步一份):
          // 合并而不是覆盖,同一句提示只留一条
          const seen = new Set(prev.messages.map((m) => `${m.ts ?? ''}|${m.content}`))
          for (const m of s.messages) {
            if (!seen.has(`${m.ts ?? ''}|${m.content}`)) prev.messages.push(m)
          }
          if (!prev.cwd && s.cwd) prev.cwd = s.cwd
          if (s.startedAt !== undefined && (prev.startedAt === undefined || s.startedAt < prev.startedAt)) prev.startedAt = s.startedAt
          if (s.endedAt !== undefined && (prev.endedAt === undefined || s.endedAt > prev.endedAt)) prev.endedAt = s.endedAt
        }
      } catch {
        /* per-file errors are non-fatal */
      }
    }

    for (const meta of collectDesktopMetas()) {
      const cliId = meta.cliSessionId
      const hist = cliId ? historyById.get(cliId) : undefined
      if (hist) {
        // desktop metadata + its prompts are one conversation: enrich, don't duplicate
        if (!hist.title && meta.session.title) hist.title = meta.session.title
        hist.cwd = hist.cwd ?? meta.session.cwd
        hist.startedAt = hist.startedAt ?? meta.session.startedAt
        hist.endedAt = hist.endedAt ?? meta.session.endedAt
        continue
      }
      if (cliId && transcriptIds.has(cliId)) continue
      sessions.push(meta.session)
    }
    sessions.push(...historyById.values())
    return sessions
  },
  watch: {
    match: /\.jsonl$/i,
    parseFile: (file) => {
      // history.jsonl(纯用户侧)只在全量扫描里与 transcript 合并去重;
      // 增量单文件解析会凭空造出一条 history:xxx 副本,所以这里跳过。
      if (path.basename(file) === 'history.jsonl') return []
      const s = parseClaudeJsonl(file, fs.readFileSync(file, 'utf-8'))
      return s ? [s] : []
    }
  },
  // 桌面端的会话目录是按需创建的,监听整个 store 根而不是当前已发现的
  // projects 子目录,这样新建的 Code 会话也能立刻触发导入。
  watchPaths: () => [path.join(claudeHome, 'projects'), ...desktopStoreDirs()]
})
