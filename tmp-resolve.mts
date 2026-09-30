import fs from 'node:fs'
import path from 'node:path'
import { resolveHermesHome } from './src/plugins/capture-hermes/index.ts'

console.log('  === 1. resolveHermesHome(undefined) ===')
try {
  const root = resolveHermesHome(undefined)
  console.log('  返回:', root ?? '(undefined)')
  if (root) {
    console.log('  根级 state.db 存在:', fs.existsSync(path.join(root, 'state.db')))
  }
} catch (e) {
  console.log('  ❌ 抛异常:', e?.constructor?.name, '-', String(e?.message).slice(0, 300))
  if (e?.stack) console.log('  堆栈头三行:\n    ' + e.stack.split('\n').slice(0, 4).join('\n    '))
}

console.log('')
console.log('  === 2. 直接 import check.ts 里的 RESOLVERS 路径 ===')
try {
  const m = await import('./src/plugins/capture-hermes/index')
  console.log('  import 成功')
  const root = m.resolveHermesHome(undefined)
  console.log('  root:', root ?? '(undefined)')
} catch (e) {
  console.log('  ❌ import 失败:', String(e?.message).slice(0, 300))
}

console.log('')
console.log('  === 3. 手工走一遍 check.ts 的判断 ===')
const root = 'D:\\Hermes Agent CN Desktop\\data\\hermes-home'
const rootDb = path.join(root, 'state.db')
console.log('  根级 state.db:', fs.existsSync(rootDb) ? '存在' : '不存在')
if (!fs.existsSync(rootDb)) {
  const profilesDir = path.join(root, 'profiles')
  try {
    for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const db = path.join(profilesDir, e.name, 'state.db')
      console.log(`  profiles\\${e.name}\\state.db:`, fs.existsSync(db) ? '存在' : '不存在')
    }
  } catch (e) {
    console.log('  profiles 读取失败:', String(e.message))
  }
}
