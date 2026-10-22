/**
 * Push a local commit to origin/main through the GitHub REST API.
 *
 * Why not `git push`: this machine intermittently cannot reach github.com:443
 * (the git endpoint), while api.github.com stays reachable. Rather than wait
 * for the link to come back, replay the commit ourselves: walk the diff against
 * origin/main, create blobs, build one flat tree, commit it on top of the
 * current ref, and fast-forward the ref. A no-op when the ref already matches.
 *
 * Only the newest commit is replayed; if several are pending, run repeatedly.
 * The author/committer/timestamps are preserved from the local commit.
 *
 * Usage: GITHUB_TOKEN=<pat> node scripts/push-via-api.mjs [ref]
 */
import { execFileSync } from 'node:child_process'

const REPO = 'Logic647/MemorySQL'
const REF = process.argv[2] ?? 'heads/main'
const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) {
  console.error('missing GITHUB_TOKEN')
  process.exit(2)
}

const API = `https://api.github.com/repos/${REPO}/git`
const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { raw: text.slice(0, 200) }
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 400)}`)
  }
  return json
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf-8' }).trim()

const localHead = git('rev-parse', 'HEAD')
const ref = await call('GET', `/refs/${REF}`)
const remoteSha = ref.object.sha

if (remoteSha === localHead) {
  console.log(`${REF} already at ${localHead} — nothing to push`)
  process.exit(0)
}

// files that differ from the remote tree, as a flat list (no submodule/nested
// dir handling: this repo is shallow enough that a flat tree is fine).
// The remote sha may be a commit this repo has never seen (a previous API push
// created it, and github.com:443 is down so we cannot fetch it) — diff against
// its parent instead, and take the parent from the API when the object is absent.
const hasRemote = (() => {
  try {
    git('cat-file', '-e', remoteSha)
    return true
  } catch {
    return false
  }
})()

let diffBase = remoteSha
if (!hasRemote) {
  const parent = (await call('GET', `/commits/${remoteSha}`)).parents[0].sha
  console.log(`本地没有远端提交 ${remoteSha.slice(0, 7)}(早前由 API 推送),改用其父提交 ${parent.slice(0, 7)} 做差异基线`)
  diffBase = parent
}

const changed = git('diff', '--name-status', diffBase, localHead).split('\n').filter(Boolean)
const tree = []
for (const line of changed) {
  const [status, ...rest] = line.split('\t')
  const path = rest[rest.length - 1]
  if (!path) continue
  if (status === 'D') {
    tree.push({ path, mode: '100644', type: 'blob', sha: null })
    continue
  }
  const buf = execFileSync('git', ['cat-file', 'blob', `${localHead}:${path}`], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024
  })
  const mode = git('ls-tree', localHead, '--', path).split(/\s+/)[0] || '100644'
  // GitHub blobs are base64 over the raw bytes; build them from the buffer
  const blob = await call('POST', '/blobs', {
    content: buf.toString('base64'),
    encoding: 'base64'
  })
  tree.push({ path, mode, type: 'blob', sha: blob.sha })
}

const parentTree = (await call('GET', `/commits/${remoteSha}`)).tree.sha
const newTree = tree.length
  ? (await call('POST', '/trees', { base_tree: parentTree, tree })).sha
  : parentTree

// preserve the original author/committer so history matches local git exactly
const meta = git('log', '-1', '--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI', localHead).split('\n')
const message = git('log', '-1', '--format=%B', localHead)

const newCommit = (
  await call('POST', '/commits', {
    message,
    tree: newTree,
    parents: [remoteSha],
    author: { name: meta[0], email: meta[1], date: meta[2] },
    committer: { name: meta[3], email: meta[4], date: meta[5] }
  })
).sha

const updated = await call('PATCH', `/refs/${REF}`, { sha: newCommit, force: false })
console.log(`${REF}: ${remoteSha.slice(0, 7)} → ${updated.object.sha.slice(0, 7)}`)
console.log(`replayed ${changed.length} changed file(s) from local ${localHead.slice(0, 7)}`)
