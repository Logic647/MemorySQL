// 发版收尾:merge electron-builder 草稿并转正(本机无 gh CLI 时的替代路径)
// 用法: node scripts/publish-release.mjs <tag> <title> <notes-file>
// 行为: 找到该 tag 的所有 draft → 保留资产最多的一份,删除其余 → PATCH
//       draft=false + name + body。token 取自 git credential store。
import { execSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'

const [tag, title, notesFile] = process.argv.slice(2)
if (!tag || !title || !notesFile) {
  console.error('usage: node scripts/publish-release.mjs <tag> <title> <notes-file>')
  process.exit(1)
}

const token = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n',
  encoding: 'utf-8'
})
  .split('\n')
  .find((l) => l.startsWith('password='))
  ?.slice(9)
if (!token) {
  console.error('no github token in credential store')
  process.exit(1)
}

const repo = (() => {
  const url = execSync('git remote get-url origin', { encoding: 'utf-8' })
  const m = /github\.com[/:](.+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!m) throw new Error('cannot parse origin remote')
  return m[1]
})()

const list = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
  headers: { Authorization: `token ${token}`, 'User-Agent': 'memorysql-release' }
}).then((r) => r.json())

const drafts = list.filter((r) => r.tag_name === tag && r.draft)
if (drafts.length === 0) {
  console.error(`no draft found for ${tag}`)
  process.exit(1)
}

// keep the draft with the most assets, drop the rest
drafts.sort((a, b) => b.assets.length - a.assets.length)
const keep = drafts[0]
for (const d of drafts.slice(1)) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/${d.id}`, {
    method: 'DELETE',
    headers: { Authorization: `token ${token}`, 'User-Agent': 'memorysql-release' }
  })
  console.log(`deleted duplicate draft ${d.id} (assets=${d.assets.length}): ${res.status}`)
}

console.log(`keeping draft ${keep.id} with assets: ${keep.assets.map((a) => a.name).join(', ') || 'NONE'}`)

const body = fs.readFileSync(notesFile, 'utf-8')
const res = await fetch(`https://api.github.com/repos/${repo}/releases/${keep.id}`, {
  method: 'PATCH',
  headers: {
    Authorization: `token ${token}`,
    'User-Agent': 'memorysql-release',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ tag_name: tag, name: title, body, draft: false, prerelease: false })
})
const out = await res.json()
console.log(`published: ${res.status} ${out.html_url} (draft=${out.draft}, assets=${out.assets?.length})`)
