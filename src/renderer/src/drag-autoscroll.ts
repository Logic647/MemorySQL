/**
 * Drag auto-scroll for the session list.
 *
 * The wheel does not work while an HTML5 drag is in flight — the browser owns
 * the pointer once dragstart fires — so the only way to reach sessions beyond
 * the fold is to scroll the container from code. This module holds the pure
 * math (how far to scroll this frame); the DOM side lives in the
 * useDragAutoScroll hook in App.tsx.
 */

/** How close to the edge (px) auto-scroll engages. */
export const EDGE = 64

/** Pixels per frame at full engagement. */
export const MAX_SPEED = 16

/**
 * Pixels to scroll the container this frame, given the pointer's client Y and
 * the container's rect. Positive scrolls down (pointer near the bottom edge),
 * negative scrolls up (pointer near the top edge), 0 means no scrolling.
 *
 * Speed ramps with how deep into the edge zone the pointer sits, so nudging
 * the edge creeps and holding it near the border moves; it is clamped to
 * MAX_SPEED so a pointer flung outside the window cannot spin the list.
 */
export function edgeScrollDelta(pointerY: number, rect: DOMRect): number {
  const topZone = rect.top + EDGE
  const bottomZone = rect.bottom - EDGE
  if (pointerY < topZone) {
    const depth = topZone - pointerY
    return -Math.min(MAX_SPEED, Math.ceil((MAX_SPEED * depth) / EDGE))
  }
  if (pointerY > bottomZone) {
    const depth = pointerY - bottomZone
    return Math.min(MAX_SPEED, Math.ceil((MAX_SPEED * depth) / EDGE))
  }
  return 0
}
