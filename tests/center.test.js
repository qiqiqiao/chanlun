/*!
 * tests/center.test.js —— 中枢（区间重叠 + 延伸；minElements 参数）
 */
'use strict'
const { randomWalk } = require('./helpers')
const c = require('../chanlun.js')
const assert = require('assert')
const t = (name, fn) => global.__registerTest('center: ' + name, fn)

// 结构化笔对象（供 centerScan / calcCenters 直接使用）
function strokeObj(si, high, low, fromRaw, toRaw) {
  return { si, high, low, fromRaw, toRaw }
}

t('三笔有共同重叠 → 成中枢', () => {
  const items = [
    strokeObj(0, 110, 90, 0, 5),
    strokeObj(1, 108, 92, 5, 10),
    strokeObj(2, 106, 94, 10, 15)
  ]
  // 共区：zsLow = max(90,92,94)=94, zsHigh = min(110,108,106)=106 → 94<106 成立
  const cs = c.calcCenters(items, { center: { minElements: 3 } })
  assert.strictEqual(cs.length, 1, 'one center')
  assert.strictEqual(cs[0].zsLow, 94)
  assert.strictEqual(cs[0].zsHigh, 106)
  assert.strictEqual(cs[0].startRaw, 0)
  assert.strictEqual(cs[0].endRaw, 15)
})

t('无公共重叠 → 不成中枢', () => {
  const items = [
    strokeObj(0, 110, 100, 0, 5),
    strokeObj(1, 108, 102, 5, 10),
    strokeObj(2, 95, 80, 10, 15) // 第三笔整体低于前两笔 → 无共区
  ]
  const cs = c.calcCenters(items, { center: { minElements: 3 } })
  assert.strictEqual(cs.length, 0)
})

t('中枢延伸：后续元素与区间有重叠则并入', () => {
  const items = [
    strokeObj(0, 110, 90, 0, 5),
    strokeObj(1, 108, 92, 5, 10),
    strokeObj(2, 106, 94, 10, 15) // 共区 [94,106]
  ]
  // 后续 3 笔都与 [94,106] 有重叠 → 延伸至 j
  items.push(strokeObj(3, 105, 95, 15, 20))
  items.push(strokeObj(4, 100, 98, 20, 25))
  items.push(strokeObj(5, 107, 96, 25, 30)) // 107>106，但 low 96<106 → 仍重叠
  items.push(strokeObj(6, 120, 110, 30, 35)) // high 120>106 且 low 110>106 → 突破，延伸停
  const cs = c.calcCenters(items, { center: { minElements: 3 } })
  assert.strictEqual(cs.length, 1)
  assert.strictEqual(cs[0].endRaw, 30, 'extended to index 5')
})

t('minElements 扩展：4 笔才成中枢', () => {
  const items = [
    strokeObj(0, 110, 90, 0, 5),
    strokeObj(1, 108, 92, 5, 10),
    strokeObj(2, 106, 94, 10, 15),
    strokeObj(3, 104, 96, 15, 20)
  ]
  // 三者重叠（minElements=3 会成）
  const c3 = c.calcCenters(items, { center: { minElements: 3 } })
  assert.strictEqual(c3.length, 1)
  // 四者共区：zsLow=96, zsHigh=104 → 96<104 成立
  const c4 = c.calcCenters(items, { center: { minElements: 4 } })
  assert.strictEqual(c4.length, 1)
})

t('minElements 不足则不成中枢', () => {
  // 只有 3 笔，要求 4 才成 → 0
  const items = [
    strokeObj(0, 110, 90, 0, 5),
    strokeObj(1, 108, 92, 5, 10),
    strokeObj(2, 106, 94, 10, 15)
  ]
  const c4 = c.calcCenters(items, { center: { minElements: 4 } })
  assert.strictEqual(c4.length, 0)
})

t('多周期随机数据：analyze 的中枢与独立 calcCenters 一致', () => {
  const bars = randomWalk(240, 33)
  const cfg = c.normalizeConfig({ biMinGap: 4 })
  const r = c.analyze(bars, cfg)
  // 笔中枢
  const sc = c.calcCenters(r.strokes, cfg)
  assert.deepStrictEqual(r.strokeCenters, sc)
  // 线段中枢
  const gc = c.calcCenters(r.segments, cfg)
  assert.deepStrictEqual(r.segmentCenters, gc)
})

t('centerScan 分块续接与全量一致', () => {
  // 生成一组带重叠的笔
  const rng = require('./helpers').makeRng(4)
  const items = []
  let lo = 90
  for (let i = 0; i < 60; i++) {
    const d = rng() * 4 - 1
    const high = lo + 20
    const low = lo + d
    items.push(strokeObj(i, high * 1.0, low, i * 5, i * 5 + 5))
    lo = low
  }
  const cfg = { center: { minElements: 3 } }
  const full = c.calcCenters(items, cfg)
  // 分块：从 0 到 40 先算，再从最后中枢起点续扫
  const front = items.slice(0, 40)
  const f0 = c.calcCenters(front, cfg)
  let startPos = f0.length ? f0[f0.length - 1].startIndex : 0
  const stable = f0.filter((cc) => cc.endIndex < startPos)
  const tail = c.centerScan(items, startPos, 3)
  const combined = stable.concat(tail)
  assert.deepStrictEqual(combined.map((cc) => cc.startRaw + '-' + cc.endRaw), full.map((cc) => cc.startRaw + '-' + cc.endRaw), 'resolve continue matches full')
})
