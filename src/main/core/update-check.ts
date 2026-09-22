/** Pure update-check helpers — no Electron imports, unit-testable. */

export interface UpdaterState {
  available?: boolean
  version?: string
  downloaded?: boolean
  error?: string
  checkedAt?: number
  /** availability confirmed by the api.github.com probe (authoritative for
   * "is there a newer release" — electron-updater's latest.yml feed can lag) */
  probeConfirmed?: boolean
}

export type UpdaterEvent =
  | { type: 'available'; version?: string }
  | { type: 'not-available'; version?: string }
  | { type: 'downloaded'; version?: string }
  | { type: 'error'; message: string }
  | { type: 'probe-available'; version: string }
  | { type: 'probe-not-available' }
  | { type: 'probe-error'; message: string }

/** compare "v0.4.2" style tags numerically; non-semver tags return null */
export function verParts(tag: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function isNewer(a: number[], b: number[]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
}

/**
 * Reducer over updater events. Errors never mask a previously confirmed
 * availability (download failure keeps `available`), but a failed *check*
 * clears it so the Settings UI can surface the failure. A probe-confirmed
 * update is never cleared by electron-updater's `not-available` — that feed
 * (github.com/downloads latest.yml) can lag behind api.github.com.
 */
export function applyUpdaterEvent(state: UpdaterState, ev: UpdaterEvent): UpdaterState {
  const next = { ...state }
  switch (ev.type) {
    case 'available':
      next.available = true
      next.version = ev.version ?? next.version
      next.error = undefined
      next.checkedAt = Date.now()
      break
    case 'not-available':
      if (next.probeConfirmed && next.available === true) {
        // stale/behind latest.yml vs the probe — keep confirmed availability
        next.checkedAt = Date.now()
        break
      }
      next.available = false
      next.version = ev.version
      next.downloaded = false
      next.error = undefined
      next.probeConfirmed = false
      next.checkedAt = Date.now()
      break
    case 'downloaded':
      next.available = true
      next.downloaded = true
      next.version = ev.version ?? next.version
      next.error = undefined
      next.checkedAt = Date.now()
      break
    case 'error':
      // download/check failure after availability is known → keep available,
      // surface the error; a cold check failure leaves available undefined
      next.error = ev.message
      next.checkedAt = Date.now()
      if (next.available === undefined) next.downloaded = false
      break
    case 'probe-available':
      next.available = true
      next.probeConfirmed = true
      next.version = ev.version
      next.error = undefined
      next.checkedAt = Date.now()
      break
    case 'probe-not-available':
      next.available = false
      next.version = undefined
      next.downloaded = false
      next.error = undefined
      next.probeConfirmed = false
      next.checkedAt = Date.now()
      break
    case 'probe-error':
      next.error = ev.message
      next.checkedAt = Date.now()
      break
  }
  return next
}

/**
 * Availability probe via api.github.com — the same feed the changelog uses.
 * electron-updater's own latest.yml lives on github.com/downloads, a
 * different and frequently blocked route, so the startup check must not
 * depend on it alone.
 */
export async function probeGitHubRelease(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ available: boolean; version?: string }> {
  const res = await fetchImpl('https://api.github.com/repos/Logic647/MemorySQL/releases?per_page=5', {
    headers: { 'User-Agent': 'memorysql-app' },
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const list = (await res.json()) as Array<{ tag_name: string }>
  const cur = verParts(currentVersion)
  if (!cur) return { available: false }
  for (const r of list) {
    const next = verParts(r.tag_name)
    if (next && isNewer(next, cur)) {
      return { available: true, version: r.tag_name.replace(/^v/, '') }
    }
  }
  return { available: false }
}
