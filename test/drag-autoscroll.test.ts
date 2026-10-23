/**
 * 拖拽自动滚动的速度曲线测试。
 *
 * HTML5 拖放期间浏览器吞掉滚轮事件 —— 这正是这个功能存在的原因,也意味着
 * 真机拖拽没法用 wheel 之外的手段驱动测试。所以把算法抽成纯函数
 * (edgeScrollDelta)单独测:给定指针位置与容器矩形,返回本帧应滚动的像素数。
 * DOM 相关的部分(监听 pointermove、写 scrollTop、跟随 drop indicator)
 * 由 useDragAutoScroll 这个 hook 持有,依赖 DOM,不在此处重复实现。
 */
import { describe, expect, it } from 'vitest'
import { edgeScrollDelta, MAX_SPEED } from '../src/renderer/src/drag-autoscroll'

/** 列表视口:top=100, bottom=700(高 600) */
const RECT = { top: 100, bottom: 700, height: 600 } as DOMRect

describe('edgeScrollDelta — 边缘自动滚动', () => {
  it('指针在列表中部时不动', () => {
    expect(edgeScrollDelta(400, RECT)).toBe(0)
  })

  it('刚过边缘带起点时几乎不动(渐起,不是一跳)', () => {
    const d = edgeScrollDelta(641, RECT) // bottomZone=636,深入 5px
    expect(d).toBeGreaterThan(0)
    expect(d).toBeLessThanOrEqual(2)
  })

  it('压到边缘时达到最大速度', () => {
    const d = edgeScrollDelta(700, RECT) // 正好在 bottom 上
    expect(d).toBe(MAX_SPEED)
  })

  it('超出边缘也钳制在最大速度(指针飞出窗口外)', () => {
    expect(edgeScrollDelta(2000, RECT)).toBe(MAX_SPEED)
  })

  it('速度随深入边缘带单调递增', () => {
    const shallow = edgeScrollDelta(645, RECT)
    const mid = edgeScrollDelta(660, RECT)
    const deep = edgeScrollDelta(690, RECT)
    expect(shallow).toBeLessThan(mid)
    expect(mid).toBeLessThan(deep)
  })

  it('顶部边缘向下滚(负值)', () => {
    expect(edgeScrollDelta(99, RECT)).toBe(-MAX_SPEED)
    expect(edgeScrollDelta(50, RECT)).toBe(-MAX_SPEED)
    const gentle = edgeScrollDelta(40, RECT) // topZone=164,深入 124px → 超出带宽,钳制
    expect(gentle).toBe(-MAX_SPEED)
  })

  it('顶部边缘同样是渐起的', () => {
    const shallow = edgeScrollDelta(163, RECT) // topZone=164,深入 1px
    expect(shallow).toBeLessThan(0)
    expect(shallow).toBeGreaterThanOrEqual(-2)
  })

  it('两个方向的符号与指针位置一致', () => {
    expect(edgeScrollDelta(50, RECT)).toBeLessThan(0)
    expect(edgeScrollDelta(400, RECT)).toBe(0)
    expect(edgeScrollDelta(750, RECT)).toBeGreaterThan(0)
  })

  it('边缘带宽取自 EDGE 常量', () => {
    // bottomZone = bottom - EDGE = 636;再往下 1px 才开始滚
    expect(edgeScrollDelta(636, RECT)).toBe(0)
    expect(edgeScrollDelta(637, RECT)).toBeGreaterThan(0)
    // topZone = top + EDGE = 164;再往上 1px 才开始滚
    expect(edgeScrollDelta(164, RECT)).toBe(0)
    expect(edgeScrollDelta(163, RECT)).toBeLessThan(0)
  })
})
