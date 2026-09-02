import crypto from 'node:crypto'
import type Database from 'better-sqlite3'

export interface SemanticHit {
  kind: 'memory' | 'session'
  refId: number
  score: number
}

export interface SemanticCore {
  /**
   * index pass: embeds new/changed rows, drops disappeared ones. Incremental
   * by default (an `updated_at` watermark in semantic_meta gates the candidate
   * set); `full: true` re-reads every source row (used by explicit reindex).
   */
  sync(opts?: { full?: boolean }): Promise<{ embedded: number; removed: number; rows: number; embeddedSessions: number[] }>
  search(query: string, limit?: number): Promise<SemanticHit[]>
  /** nearest indexed sessions to one indexed session, itself excluded */
  similarSessions(refId: number, k?: number): Promise<Array<{ refId: number; distance: number }>>
  stats(): { rows: number; dims: number; model: string }
}

/** fastembed yields Float32Array; tests may pass plain arrays */
type VecInput = Float32Array | number[]

const vecParam = (v: VecInput): Buffer | string =>
  v instanceof Float32Array
    ? Buffer.from(v.buffer, v.byteOffset, v.byteLength)
    : JSON.stringify(v)

const hashText = (t: string): string => crypto.createHash('sha1').update(t).digest('hex')

interface Candidate {
  kind: 'memory' | 'session'
  refId: number
  text: string
}

/**
 * Vector index over active memories and sessions (title+summary), kept in a
 * vec0 virtual table that mirrors source rowids. The embedder is injected so
 * tests run with a deterministic fake and the app wires fastembed.
 */
export function createSemanticCore(deps: {
  sqlite: Database.Database
  embedDocs: (texts: string[]) => Promise<VecInput[]>
  embedQuery: (q: string) => Promise<VecInput>
  dims: number
  model: string
}): SemanticCore {
  const { sqlite, embedDocs, embedQuery, dims, model } = deps

  // schema lives in code (not migrations): it only exists when the vec0
  // extension actually loaded, and a dims change rebuilds it wholesale
  sqlite.exec(`CREATE TABLE IF NOT EXISTS semantic_meta (key TEXT PRIMARY KEY, value TEXT)`)
  const storedDims = (
    sqlite
      .prepare(`SELECT value FROM semantic_meta WHERE key = 'dims'`)
      .get() as { value: string } | undefined
  )?.value
  if (storedDims != null && Number(storedDims) !== dims) {
    sqlite.exec(`DROP TABLE IF EXISTS semantic_vec`)
    sqlite.exec(`DROP TABLE IF EXISTS semantic_refs`)
    // the watermark is meaningless without the refs table it was built against
    sqlite.exec(`DELETE FROM semantic_meta WHERE key LIKE 'wm_%'`)
  }
  if (storedDims == null) {
    sqlite
      .prepare(`INSERT INTO semantic_meta (key, value) VALUES ('dims', ?)`)
      .run(String(dims))
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS semantic_refs (
      id           INTEGER PRIMARY KEY,
      kind         TEXT NOT NULL,
      ref_id       INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE (kind, ref_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_vec USING vec0(embedding float[${dims}]);
  `)

  const refFind = sqlite.prepare(`SELECT id, content_hash FROM semantic_refs WHERE kind = ? AND ref_id = ?`)
  const refDel = sqlite.prepare(`DELETE FROM semantic_refs WHERE id = ?`)
  // separate autoincrement id: memory ids and session ids share the same
  // number space, so the vec0 rowid must come from THIS table, not the source
  const refIns = sqlite.prepare(`INSERT INTO semantic_refs (kind, ref_id, content_hash) VALUES (?, ?, ?)`)
  const vecDel = sqlite.prepare(`DELETE FROM semantic_vec WHERE rowid = ?`)
  const wmGet = (key: string): number =>
    Number(
      (sqlite.prepare(`SELECT value FROM semantic_meta WHERE key = ?`).get(key) as { value: string } | undefined)
        ?.value ?? '0'
    )
  const wmSet = sqlite.prepare(
    `INSERT INTO semantic_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )

  // incremental candidates: only rows touched since the watermark are read
  // into memory (the old full-table scan ran on every 30s debounce tick)
  const CANDIDATE_MEMORY = `
    SELECT 'memory' AS kind, id AS "refId", content AS text FROM memories
      WHERE deleted = 0 AND status = 'active' AND updated_at >= ?`
  const CANDIDATE_SESSION = `
    SELECT 'session' AS kind, id AS "refId",
           trim(coalesce(title, '') || char(10) || coalesce(summary, '')) AS text
      FROM sessions WHERE deleted = 0 AND updated_at >= ?`
  // removal is watermark-independent and O(refs): a ref whose source row is
  // gone, tombstoned, deactivated, or whose text became empty must drop out
  const REMOVAL_MEMORY = `
    SELECT r.id FROM semantic_refs r
    LEFT JOIN memories m ON m.id = r.ref_id
    WHERE r.kind = 'memory'
      AND (m.id IS NULL OR m.deleted = 1 OR m.status != 'active' OR trim(m.content) = '')`
  const REMOVAL_SESSION = `
    SELECT r.id FROM semantic_refs r
    LEFT JOIN sessions s ON s.id = r.ref_id
    WHERE r.kind = 'session'
      AND (s.id IS NULL OR s.deleted = 1
           OR trim(coalesce(s.title, '') || char(10) || coalesce(s.summary, '')) = '')`

  const insertRow = sqlite.transaction((w: Candidate, vec: VecInput) => {
    const oldRef = refFind.get(w.kind, w.refId) as { id: number } | undefined
    if (oldRef != null) {
      vecDel.run(oldRef.id)
      refDel.run(oldRef.id)
    }
    const newId = Number(
      (refIns.run(w.kind, w.refId, hashText(w.text)) as { lastInsertRowid: number | bigint }).lastInsertRowid
    )
    // vec0 rejects bound rowid params — inline our own integer id
    sqlite
      .prepare(`INSERT INTO semantic_vec (rowid, embedding) VALUES (${newId}, ?)`)
      .run(vecParam(vec))
  })

  return {
    async sync(opts?: { full?: boolean }): Promise<{
      embedded: number
      removed: number
      rows: number
      embeddedSessions: number[]
    }> {
      const refsCount = (sqlite.prepare(`SELECT COUNT(*) AS n FROM semantic_refs`).get() as { n: number }).n
      // a wiped refs table must be rebuilt from scratch regardless of watermark
      const full = opts?.full === true || refsCount === 0
      const wmMem = full ? 0 : wmGet('wm_memory')
      const wmSes = full ? 0 : wmGet('wm_session')

      let removed = 0
      for (const sql of [REMOVAL_MEMORY, REMOVAL_SESSION]) {
        for (const r of sqlite.prepare(sql).all() as Array<{ id: number }>) {
          vecDel.run(r.id)
          refDel.run(r.id)
          removed++
        }
      }

      const candidates = (
        [
          ...(sqlite.prepare(CANDIDATE_MEMORY).all(wmMem) as Array<Candidate>),
          ...(sqlite.prepare(CANDIDATE_SESSION).all(wmSes) as Array<Candidate>)
        ] as Array<Candidate>
      ).filter((r) => r.text.trim().length > 0)

      // `>=` watermark re-reads the boundary millisecond, but the content hash
      // skips unchanged rows so nothing is re-embedded without a real change
      const stale: Candidate[] = []
      for (const c of candidates) {
        const cur = refFind.get(c.kind, c.refId) as { content_hash: string } | undefined
        if (cur && cur.content_hash === hashText(c.text)) continue
        stale.push(c)
      }

      let embedded = 0
      const embeddedSessions: number[] = []
      if (stale.length > 0) {
        const vectors = await embedDocs(stale.map((w) => w.text))
        for (let i = 0; i < stale.length; i++) {
          insertRow(stale[i], vectors[i])
          if (stale[i].kind === 'session') embeddedSessions.push(stale[i].refId)
          embedded++
        }
      }

      // watermark = the source tables' own MAX(updated_at), not wall clock:
      // rows written mid-sync are picked up by the next event-driven sync
      const maxOf = (table: string): number =>
        (sqlite.prepare(`SELECT COALESCE(MAX(updated_at), 0) AS m FROM ${table}`).get() as { m: number }).m
      wmSet.run('wm_memory', String(maxOf('memories')))
      wmSet.run('wm_session', String(maxOf('sessions')))

      const rows = (sqlite.prepare(`SELECT COUNT(*) AS n FROM semantic_refs`).get() as { n: number }).n
      return { embedded, removed, rows, embeddedSessions }
    },

    async similarSessions(refId: number, k = 4): Promise<Array<{ refId: number; distance: number }>> {
      const row = sqlite
        .prepare(
          `SELECT r.id, s.title, s.summary FROM semantic_refs r
           JOIN sessions s ON s.id = r.ref_id
           WHERE r.kind = 'session' AND r.ref_id = ?`
        )
        .get(refId) as { id: number; title: string | null; summary: string | null } | undefined
      const text = [row?.title ?? '', row?.summary ?? ''].join('\n').trim()
      if (!text || !row) return []
      const [qv] = await embedDocs([text])
      const knn = sqlite
        .prepare(
          `SELECT v.rowid AS id, v.distance FROM semantic_vec v
           WHERE v.embedding MATCH ? AND k = ? ORDER BY distance`
        )
        .all(vecParam(qv), k + 1) as Array<{ id: number; distance: number }>
      const out: Array<{ refId: number; distance: number }> = []
      for (const r of knn) {
        if (r.id === row.id) continue
        const ref = sqlite
          .prepare(`SELECT kind, ref_id FROM semantic_refs WHERE id = ?`)
          .get(r.id) as { kind: string; ref_id: number } | undefined
        if (ref?.kind === 'session') out.push({ refId: ref.ref_id, distance: r.distance })
      }
      return out
    },

    async search(query: string, limit = 8): Promise<SemanticHit[]> {
      const qv = await embedQuery(query)
      const knn = sqlite
        .prepare(
          `SELECT v.rowid AS id, v.distance FROM semantic_vec v
           WHERE v.embedding MATCH ? AND k = ? ORDER BY distance`
        )
        .all(vecParam(qv), limit) as Array<{ id: number; distance: number }>
      const hits: SemanticHit[] = []
      for (const r of knn) {
        const ref = sqlite
          .prepare(`SELECT kind, ref_id FROM semantic_refs WHERE id = ?`)
          .get(r.id) as { kind: 'memory' | 'session'; ref_id: number } | undefined
        if (ref) hits.push({ kind: ref.kind, refId: ref.ref_id, score: 1 / (1 + r.distance) })
      }
      return hits
    },

    stats() {
      const rows = (sqlite.prepare(`SELECT COUNT(*) AS n FROM semantic_refs`).get() as { n: number }).n
      return { rows, dims, model }
    }
  }
}
