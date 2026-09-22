import { describe, expect, it } from 'vitest'
import {
  applyUpdaterEvent,
  isNewer,
  probeGitHubRelease,
  verParts,
  type UpdaterState
} from '../src/main/core/update-check'

describe('verParts / isNewer', () => {
  it('parses v-prefixed and bare tags', () => {
    expect(verParts('v0.5.2')).toEqual([0, 5, 2])
    expect(verParts('1.2.3')).toEqual([1, 2, 3])
    expect(verParts('nightly')).toBeNull()
  })

  it('compares numerically component-wise', () => {
    expect(isNewer([0, 10, 0], [0, 9, 9])).toBe(true)
    expect(isNewer([1, 0, 0], [0, 99, 99])).toBe(true)
    expect(isNewer([0, 5, 2], [0, 5, 2])).toBe(false)
    expect(isNewer([0, 5, 1], [0, 5, 2])).toBe(false)
  })
})

describe('applyUpdaterEvent state machine', () => {
  it('probe-available sets availability and clears error', () => {
    const s = applyUpdaterEvent({ error: 'boom' }, { type: 'probe-available', version: '0.6.0' })
    expect(s).toMatchObject({ available: true, version: '0.6.0', error: undefined })
    expect(s.checkedAt).toBeTypeOf('number')
  })

  it('probe-not-available resets downloaded/error so UI does not stick', () => {
    const s = applyUpdaterEvent(
      { available: true, downloaded: true, error: 'x' },
      { type: 'probe-not-available' }
    )
    expect(s).toMatchObject({ available: false, downloaded: false, error: undefined })
  })

  it('error after a successful probe keeps available (download failed banner)', () => {
    const s = applyUpdaterEvent({ available: true, version: '0.6.0' }, { type: 'error', message: 'network' })
    expect(s.available).toBe(true)
    expect(s.error).toBe('network')
  })

  it('error on a cold check leaves available undefined so Settings shows failure', () => {
    const s = applyUpdaterEvent({}, { type: 'error', message: 'blocked' })
    expect(s.available).toBeUndefined()
    expect(s.error).toBe('blocked')
  })

  it('update-not-available does not leave a stale downloaded flag', () => {
    const s = applyUpdaterEvent(
      { downloaded: true, available: true, probeConfirmed: false },
      { type: 'not-available' }
    )
    expect(s).toMatchObject({ available: false, downloaded: false })
  })

  it('not-available after probe-available keeps the confirmed update (stale latest.yml)', () => {
    let s: UpdaterState = applyUpdaterEvent({}, { type: 'probe-available', version: '0.6.0' })
    s = applyUpdaterEvent(s, { type: 'not-available', version: '0.5.2' })
    expect(s).toMatchObject({ available: true, version: '0.6.0', probeConfirmed: true })
    expect(s.checkedAt).toBeTypeOf('number')
  })

  it('probe-not-available after a prior probe clears probeConfirmed so later not-available applies', () => {
    let s: UpdaterState = applyUpdaterEvent({}, { type: 'probe-available', version: '0.6.0' })
    s = applyUpdaterEvent(s, { type: 'probe-not-available' })
    s = applyUpdaterEvent(s, { type: 'not-available' })
    expect(s.available).toBe(false)
    expect(s.probeConfirmed).toBe(false)
  })

  it('downloaded marks ready-to-install and clears error', () => {
    const s = applyUpdaterEvent({ error: 'old' }, { type: 'downloaded', version: '0.6.0' })
    expect(s).toMatchObject({ available: true, downloaded: true, version: '0.6.0', error: undefined })
  })
})

describe('probeGitHubRelease', () => {
  const stubFetch = (tags: string[], ok = true): typeof fetch =>
    (async () =>
      ({
        ok,
        status: ok ? 200 : 500,
        json: async () => tags.map((tag_name) => ({ tag_name }))
      }) as unknown as Response) as typeof fetch

  it('reports the newest newer tag', async () => {
    const r = await probeGitHubRelease('0.5.0', stubFetch(['v0.5.2', 'v0.5.1', 'v0.5.0']))
    expect(r).toEqual({ available: true, version: '0.5.2' })
  })

  it('reports not available when equal or older', async () => {
    const r = await probeGitHubRelease('0.5.2', stubFetch(['v0.5.2', 'v0.5.1']))
    expect(r.available).toBe(false)
  })

  it('throws on non-2xx so callers can record a probe error', async () => {
    await expect(probeGitHubRelease('0.5.0', stubFetch([], false))).rejects.toThrow('HTTP 500')
  })
})

describe('state stays serializable for IPC', () => {
  it('JSON round-trips', () => {
    const s: UpdaterState = applyUpdaterEvent({}, { type: 'probe-available', version: '1.0.0' })
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)
    expect(s.probeConfirmed).toBe(true)
  })
})
