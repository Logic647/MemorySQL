/**
 * 上游更新抓取 —— 零依赖,Node 18+ 内置 fetch。
 *
 * 三种来源形态(实测得出,见 docs/DEVLOG.md 2026-09-30):
 *   github  GitHub Releases API,取 body 作为 changelog
 *   commit  release 无正文/无 release,退化为 commit message
 *   npm     npm registry 的 latest 版本 + 发布时间
 *   none    闭源,无任何公开来源 —— 不抓,看板显示「仅黑盒」
 *
 * 速率与容错:
 *   - GitHub 未认证 60 次/小时;带 GITHUB_TOKEN 提到 5000
 *   - 失败不抛到调用方,由调用方决定降级;网络抖动重试 2 次(指数退避)
 */
const UA = 'memorysql-upstream-watch'
const TIMEOUT_MS = 15000

export async function httpJson(url, opts = {}) {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
    ...(opts.headers ?? {})
  }
  // GitHub 匿名限流 60/h,带 token 5000/h —— 有就用
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, { headers, signal: ctl.signal })
      clearTimeout(timer)
      if (res.status === 403 || res.status === 429) {
        // **不要把所有 403/429 都当成「限流」。** GitHub 至少用这两个状态码表示四种
        // 完全不同的情况,而它们的处置方式互斥:
        //   1) 主限流      x-ratelimit-remaining: 0        -> 等到 reset
        //   2) 二级/滥用   body 含 "secondary rate limit"   -> 退避,通常 1 分钟自愈
        //   3) 授权不足    body 含 "Resource not accessible" -> **token 配错了**
        //   4) IP 级封禁   以上都不是                      -> 等一分钟自己好
        // 旧代码把响应体丢了,四种情况长得一模一样,只能靠猜(2026-09-30 就因此
        // 把一次「IP 级滥用检测」当成 token 没配好,白排查了一轮)。
        const retryAfter = Number(res.headers.get('retry-after') ?? 0)
        const remaining = res.headers.get('x-ratelimit-remaining')
        const resetAt = Number(res.headers.get('x-ratelimit-reset') ?? 0)
        let body = ''
        try { body = (await res.text()).slice(0, 400) } catch { /* 读不到就算了 */ }
        const flat = body.replace(/\s+/g, ' ').trim()
        const low = flat.toLowerCase()

        let kind
        if (remaining === '0') {
          kind = `GitHub 主限流,配额约 ${Math.max(0, Math.round((resetAt * 1000 - Date.now()) / 60000))} 分钟后重置`
        } else if (low.includes('secondary rate limit') || low.includes('abuse detection')) {
          kind = 'GitHub 二级限流(触发滥用检测,通常一分钟内自行恢复)'
        } else if (low.includes('resource not accessible') || low.includes('bad credentials')) {
          kind = 'GitHub 拒绝授权 —— token 无效/已撤销/权限不足(这不是限流)'
        } else {
          kind = `GitHub 返回 ${res.status},但不是限流`
        }
        // 只有真限流才值得按 retry-after 等;授权问题等多久都没用
        const isRate =
          remaining === '0' || low.includes('secondary rate limit') || low.includes('abuse detection')
        if (isRate && attempt < 2 && retryAfter > 0 && retryAfter < 30) {
          await new Promise((r) => setTimeout(r, retryAfter * 1000))
          continue
        }
        return {
          ok: false,
          error: flat ? `${kind} —— GitHub 原话: ${flat.slice(0, 160)}` : kind,
          status: res.status,
          rateLimited: isRate
        }
      }
      if (res.status === 404) return { ok: false, error: '不存在 (404)', status: 404 }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status }
      return { ok: true, data: await res.json(), status: res.status }
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    }
  }
  return { ok: false, error: `请求失败: ${lastErr?.message ?? lastErr}` }
}

/**
 * 抓一个 agent 的最新更新。返回 { version, publishedAt, notes, kind, error }
 * notes 是 changelog 正文(可能为空 —— 评估器需容忍)。
 */
export async function fetchUpstream(agent) {
  const { kind, repo } = agent.upstream ?? {}
  if (kind === 'none' || !kind) {
    return { kind: 'none', notes: '', error: '闭源,无公开更新日志' }
  }
  if (kind === 'npm') return fetchNpm(agent, repo)
  return fetchGithub(agent, repo, kind)
}

async function fetchGithub(agent, repo, kind) {
  const rel = await httpJson(`https://api.github.com/repos/${repo}/releases?per_page=5`)
  if (!rel.ok) return { kind, error: rel.error, notes: '' }

  const releases = rel.data ?? []
  const withBody = releases.find((r) => typeof r.body === 'string' && r.body.trim().length > 20)

  if (withBody) {
    return {
      kind,
      version: withBody.tag_name,
      publishedAt: withBody.published_at,
      notes: withBody.body,
      url: withBody.html_url,
      fallbackUsed: false
    }
  }

  // release 存在但正文空(codex 就是这样)或根本没有 release → 退化为 commit
  if (kind === 'commit' || releases.length === 0) {
    const commits = await fetchCommits(repo)
    if (commits.notes) {
      return {
        kind,
        version: commits.version,
        publishedAt: commits.publishedAt,
        notes: commits.notes,
        url: `https://github.com/${repo}/commits`,
        fallbackUsed: true,
        fallbackReason:
          releases.length === 0 ? '无 release,改用 commit' : 'release 正文为空,改用 commit'
      }
    }
    return {
      kind,
      version: releases[0]?.tag_name ?? null,
      publishedAt: releases[0]?.published_at ?? null,
      notes: '',
      error: 'release 无正文且 commit 抓取失败',
      fallbackUsed: true
    }
  }

  return {
    kind,
    version: releases[0].tag_name,
    publishedAt: releases[0].published_at,
    notes: '',
    url: releases[0].html_url,
    error: 'release 正文为空(未抓到 changelog)',
    fallbackUsed: true
  }
}

async function fetchCommits(repo) {
  // 只写一个 per_page。原来是 `?per_page=15&per_page=1` —— 重复键,GitHub 恰好取
  // 第一个(15)所以一直没暴露,但它是一颗雷:哪天服务端改成取末值,changelog
  // 就会静默只剩 1 行,而代码下面明确是把整个 list map 成多行的。
  const res = await httpJson(
    `https://api.github.com/repos/${repo}/commits?per_page=15`
  )
  if (!res.ok) return { notes: '', version: null, publishedAt: null }
  const list = Array.isArray(res.data) ? res.data : []
  if (!list.length) return { notes: '', version: null, publishedAt: null }
  const notes = list
    .map((c) => `- ${(c.commit?.message ?? '').split('\n')[0]}`)
    .join('\n')
  return {
    notes: notes.slice(0, 6000),
    version: list[0].sha?.slice(0, 8),
    publishedAt: list[0].commit?.committer?.date ?? null
  }
}

async function fetchNpm(agent, repo) {
  // repo 形如 "MoonshotAI/kimi-code" → 包名取最后一段
  const pkg = String(repo).split('/').pop()
  // 必须覆盖 Accept:npm registry 不认 GitHub 的 vnd.github+json,会回 406
  const res = await httpJson(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
    headers: { Accept: 'application/json' }
  })
  if (!res.ok) return { kind: 'npm', notes: '', error: res.error }
  return {
    kind: 'npm',
    version: res.data?.version ?? null,
    publishedAt: null,
    notes: res.data?.description ? String(res.data.description) : '',
    url: `https://www.npmjs.com/package/${pkg}`
  }
}
