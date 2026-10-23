/**
 * Measure the rail layout in the running app over the DevTools protocol.
 *
 * The renderer needs the Electron preload, so it cannot be measured from a
 * plain browser; and Windows UIA gives no tree for this window. CDP against the
 * app's own page is the one place where the real, post-CSS layout is readable.
 *
 * Usage: node scripts/measure-rail.mjs [port]
 */
const PORT = process.argv[2] ?? '9333'

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page' && /MemorySQL/.test(t.title ?? ''))
if (!page) {
  console.error('no MemorySQL page on the debugging port')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()

const send = (method, params) =>
  new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.error) p.reject(new Error(msg.error.message))
  else p.resolve(msg.result)
})

await new Promise((resolve) => ws.addEventListener('open', resolve))

const expr = `(() => {
  const q = (s) => document.querySelector(s)
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), height: Math.round(r.height), bottom: Math.round(r.bottom) }
  }
  const rail = q('.rail')
  const nav = q('.rail-nav')
  const brand = q('.rail-brand')
  const bottom = q('.rail-bottom')
  const tags = [...document.querySelectorAll('.rail-btn-fill')]
  const tagBoxes = tags.map((t) => ({ label: t.textContent.trim(), ...box(t) }))
  const navH = nav ? nav.getBoundingClientRect().height : 0
  return {
    rail: box(rail),
    brand: box(brand),
    nav: box(nav),
    bottom: box(bottom),
    tags: tagBoxes,
    equalHeights: tagBoxes.length === 2 &&
      Math.abs(tagBoxes[0].height - tagBoxes[1].height) <= 1,
    eachHalfOfNav: tagBoxes.length === 2 && navH > 0 &&
      Math.abs(tagBoxes[0].height - navH / 2) <= 3 &&
      Math.abs(tagBoxes[1].height - navH / 2) <= 3,
    navHeightPx: Math.round(navH)
  }
})()`

const { result } = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
console.log(JSON.stringify(result.value, null, 2))
ws.close()
