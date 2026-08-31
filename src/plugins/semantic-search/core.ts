import crypto from 'node:crypto'
import type Database from 'better-sqlite3'

export interface SemanticHit {
  kind: 'memory' | 'session'
  refId: number
  score: number
}

export interface SemanticCore {
  /** incremental index pass: embeds new/changed rows, drops disappeared ones */
  sync(): Promise<{ embedded: number; removed: number; rows: number }>
  search(query: string, limit?: number): Promise<SemanticHit[]>
  stats(): { rows: number; dims: number; model: string }
}

const hashText = (t: string): string => crypto.createHash('sha1').update(t).digest('hex')

/**
 * Vector index over active memories and sessions (title+summary), kept in a
 * vec0 virtual table that mirrors source rowids. The embedder is injected so
 * tests run with a deterministic fake and the app wires fastembed.
 */
export function createSemanticCore(deps: {
  sqlite: Database.Database
  embedDocs: (texts: string[]) => Promise<number[][]>
  embedQuery: (q: string) => Promise<number[]>
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
  const sources = sqlite.prepare(`
    SELECT 'memory' AS kind, id AS ref_id, content AS text FROM memories
      WHERE deleted = 0 AND status = 'active'
    UNION ALL
    SELECT 'session' AS kind, id AS ref_id,
           trim(coalesce(title, '') || char(10) || coalesce(summary, '')) AS text
    FROM sessions WHERE deleted = 0
  `)

  return {
    async sync(): Promise<{ embedded: number; removed: number; rows: number }> {
      const rows = (sources.all() as Array<{ kind: string; ref_id: number; text: string }>).filter(
        (r) => r.text.trim().length > 0
      )
      const want = new Map<string, { kind: string; refId: number; text: string; hash: string }>()
      for (const r of rows) {
        want.set(`${r.kind}:${r.ref_id}`, { kind: r.kind, refId: r.ref_id, text: r.text, hash: hashText(r.text) })
      }

      const existing = new Map<string, number>() // key -> semantic_refs.id
      for (const r of sqlite
        .prepare(`SELECT id, kind, ref_id, content_hash FROM semantic_refs`)
        .all() as Array<{ id: number; kind: string; ref_id: number; content_hash: string }>) {
        existing.set(`${r.kind}:${r.ref_id}`, r.id)
      }

      let removed = 0
      for (const [key, id] of existing) {
        if (!want.has(key)) {
          vecDel.run(id)
          refDel.run(id)
          removed++
        }
      }

      const stale = [...want.entries()].filter(([, w]) => {
        const cur = refFind.get(w.kind, w.refId) as { id: number; content_hash: string } | undefined
        return cur == null || cur.content_hash !== w.hash
      })
      let embedded = 0
      if (stale.length > 0) {
        const vectors = await embedDocs(stale.map(([, w]) => w.text))
        for (let i = 0; i < stale.length; i++) {
          const [key, w] = stale[i]
          const oldId = existing.get(key)
          if (oldId != null) vecDel.run(oldId)
          const refRow = refFind.get(w.kind, w.refId) as { id: number } | undefined
          if (refRow != null) refDel.run(refRow.id)
          const newId = Number(
            (refIns.run(w.kind, w.refId, w.hash) as { lastInsertRowid: number | bigint }).lastInsertRowid
          )
          // vec0 rejects bound rowid params — inline our own integer id
          sqlite
            .prepare(`INSERT INTO semantic_vec (rowid, embedding) VALUES (${newId}, ?)`)
            .run(JSON.stringify(vectors[i]))
          embedded++
        }
      }
      return { embedded, removed, rows: existing.size - removed + embedded }
    },

    async search(query: string, limit = 8): Promise<SemanticHit[]> {
      const qv = await embedQuery(query)
      const knn = sqlite
        .prepare(
          `SELECT v.rowid AS id, v.distance FROM semantic_vec v
           WHERE v.embedding MATCH ? AND k = ? ORDER BY distance`
        )
        .all(JSON.stringify(qv), limit) as Array<{ id: number; distance: number }>
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
