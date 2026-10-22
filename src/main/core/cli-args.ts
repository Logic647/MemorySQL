import fs from 'node:fs'
import path from 'node:path'

/**
 * 命令行参数解析(独立成模块,避免主进程其它文件都沾上 argv 污点)。
 *
 * 支持的开关:
 *   --scan               无头扫描:扫描各 agent 数据目录并打印统计
 *   --sync <dir>         与指定网盘文件夹做增量同步
 *   --dispatch <file>    把一份对话文本作为会话导入(见 import-chat 插件)
 *   --devlog             生成项目日志
 *   --reindex            重建语义索引
 *   --export-archive <p> 导出 .msqlv 归档到指定文件
 *   --hidden             开机自启:只驻留托盘
 */

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  if (i < 0) return null
  const raw = (process.argv[i + 1] ?? '').trim()
  return raw || null
}

export const HEADLESS_SCAN = process.argv.includes('--scan')
export const DISPATCH = process.argv.includes('--dispatch')
export const GENERATE_DEVLOG = process.argv.includes('--devlog')
export const SEMANTIC_REINDEX = process.argv.includes('--reindex')
export const LAUNCH_HIDDEN = process.argv.includes('--hidden')

/** --sync <dir>:同步目录必须已存在,避免把数据写到意料之外的位置 */
export const SYNC_FOLDER = (() => {
  const raw = argValue('--sync')
  if (!raw) return null
  const abs = path.resolve(raw)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`--sync 目录不存在: ${abs}`)
  }
  return abs
})()

/** --export-archive <path>:目标文件的父目录必须已存在 */
export const EXPORT_ARCHIVE_DEST = (() => {
  const raw = argValue('--export-archive')
  if (!raw) return null
  const abs = path.resolve(raw)
  const parent = path.dirname(abs)
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error(`--export-archive 目标目录不存在: ${parent}`)
  }
  return abs
})()
