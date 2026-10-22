/**
 * Verify that the tree at a remote commit matches the local working tree.
 *
 * The push-via-api script replays a commit through the REST API, which builds
 * a FLAT tree where git builds nested ones — so the commit SHA differs even
 * when every file is identical. This script compares blob SHAs per path
 * instead of comparing the commit, which is the check that actually matters.
 */
import { execFileSync } from 'node:child_process'

const REPO = 'Logic647/MemorySQL'
const REF = process.argv[2] ?? 'main'
const LOCAL_REF = process.argv[3] ?? 'main'
const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) {
  console.error('missing GITHUB_TOKEN')
  process.exit(2)
}

const res = await fetch(
  `https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`,
  {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json'
    }
  }
)
if (!res.ok) {
  console.error(`GET tree(${REF}) → ${res.status}: ${(await res.text()).slice(0, 200)}`)
  process.exit(1)
}
const remote = (await res.json()).tree ?? []

let ok = 0
const bad = []
for (const entry of remote) {
  if (entry.type !== 'blob') continue
  let localSha
  try {
    localSha = execFileSync('git', ['rev-parse', `${LOCAL_REF}:${entry.path}`], {
      encoding: 'utf-8'
    }).trim()
  } catch {
    bad.push(`${entry.path} — 远端有,本地没有`)
    continue
  }
  if (localSha === entry.sha) ok++
  else bad.push(`${entry.path} — remote ${entry.sha.slice(0, 8)} ≠ local ${localSha.slice(0, 8)}`)
}

// 本地有但远端没有的文件(被漏推的)
const localFiles = execFileSync('git', ['ls-tree', '-r', LOCAL_REF], { encoding: 'utf-8' })
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split('\t')[1])
  .filter(Boolean)
const remotePaths = new Set(remote.filter((t) => t.type === 'blob').map((t) => t.path))
for (const p of localFiles) {
  if (!remotePaths.has(p)) bad.push(`${p} — 本地有,远端没有`)
}

console.log(`远端 ${REF} 的 blob: ${remote.filter((t) => t.type === 'blob').length} 个`)
console.log(`内容一致: ${ok}`)
if (bad.length) {
  console.log(`不一致: ${bad.length}`)
  for (const b of bad) console.log(`  - ${b}`)
  process.exit(1)
}
console.log('全部一致 ✅')
