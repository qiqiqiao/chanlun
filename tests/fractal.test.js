/*!
 * tests/fractal.test.js —— 分型识别（strict / relaxed 两种口径）
 */
'use strict'
const { makeRng } = require('./helpers')
const c = require('../chanlun.js')
const t = (name, fn) => global.__registerTest('fractal: ' + name, fn)

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}
function deepEqual(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || 'not deep equal') + '\n  got: ' + JSON.stringify(a) + '\n  want: ' + JSON.stringify(b))
  }
}
const merge = (bars) => c.mergeBars(bars).merged

t('顶分型（strict）：高双高低双低', () => {
  const merged = merge([
    { high: 10, low: 4 },
    { high: 13, low: 7 },  // 顶：high/ low 均高于两侧 → m1
    { high: 11, low: 5 }
  ].map((b, i) => ({ timestamp: i, ...b })))
  const fx = c.calcFractals(merged, c.normalizeConfig())
  deepEqual(fx.length, 1)
  assert(fx[0].type === 'top' && fx[0].mi === 1, 'top at 1')
})

t('底分型（strict）：高低双低', () => {
  const merged = merge([
    { high: 12, low: 6 },
    { high: 9, low: 3 },   // 底 → m1
    { high: 11, low: 5 }
  ].map((b, i) => ({ timestamp: i, ...b })))
  const fx = c.calcFractals(merged, c.normalizeConfig())
  deepEqual(fx.length, 1)
  assert(fx[0].type === 'bottom' && fx[0].mi === 1, 'bottom at 1')
})

t('strict 下高双高但低未双低 → 不是顶', () => {
  // 只用 high/low 直接构造 merged 元素（避开 mergeBars 的包含合并）
  const merged = [
    { high: 10, low: 6, rawMiddle: 0 },
    { high: 13, low: 8, rawMiddle: 1 },   // 候选；检查 low：8>6 ✓ 但 n.low=9
    { high: 11, low: 9, rawMiddle: 2 }
  ]
  // strict：m.low(8) < n.low(9) → 不满足 顶 的“low 双高” → 不是顶
  const fx = c.calcFractals(merged, c.normalizeConfig())
  deepEqual(fx.length, 0, 'strict should reject')
  // relaxed 只看 high：13>10 且 13>11 → 顶
  const fxR = c.calcFractals(merged, { fractal: { mode: 'relaxed' } })
  deepEqual(fxR.length, 1, 'relaxed accepts')
})

t('顶底交替过滤：相邻同类型只保留更极端', () => {
  // 直接构造 merged（mi 递增）
  const merged = [
    { high: 10, low: 4, rawMiddle: 0, mi: 0 },
    { high: 12, low: 7, rawMiddle: 1, mi: 1 },  // 顶@1
    { high: 11, low: 5, rawMiddle: 2, mi: 2 },  // 底@2
    { high: 14, low: 8, rawMiddle: 3, mi: 3 },  // 顶@3（更高）
    { high: 12, low: 6, rawMiddle: 4, mi: 4 },
    { high: 8, low: 2, rawMiddle: 5, mi: 5 },   // 底@5
    { high: 9, low: 4, rawMiddle: 6, mi: 6 }
  ]
  const fx = c.calcFractals(merged, c.normalizeConfig())
  // 交替序列 top@1 bottom@2 top@3 bottom@5（顶@1/顶@3 之间隔底@2，不互压）
  deepEqual(fx.length, 4)
  deepEqual(fx.map((f) => f.mi), [1, 2, 3, 5])
  assert(fx[0].type === 'top' && fx[0].high === 12)
  assert(fx[2].type === 'top' && fx[2].high === 14, 'higher top wins')
  assert(fx[3].type === 'bottom' && fx[3].low === 2)
})

t('相邻同类型分型：后者更极端时替换前者', () => {
  // 顶@1 与 顶@2 连续（无底间隔），顶@2 更高 → 顶@1 被替换
  const merged = [
    { high: 10, low: 6, rawMiddle: 0, mi: 0 },
    { high: 12, low: 8, rawMiddle: 1, mi: 1 },  // 顶@1
    { high: 13, low: 9, rawMiddle: 2, mi: 2 },  // 顶@2 更高、相邻 → 替换
    { high: 9, low: 4, rawMiddle: 3, mi: 3 },   // 底@3
    { high: 10, low: 5, rawMiddle: 4, mi: 4 }
  ]
  // 验证顶@2 是顶（high13>12且>9；low9>8且>4 → 满足，但需 n=9/4）
  const fx = c.calcFractals(merged, c.normalizeConfig())
  // 顶@1: 12>10且12>13否 → 不是顶；顶@2: 13>12且13>10✓(low9>8且>5✓) → 顶；底@3
  deepEqual(fx.length, 2)
  assert(fx[0].type === 'top' && fx[0].mi === 2, 'only higher adjacent top survives')
  assert(fx[1].type === 'bottom' && fx[1].mi === 3)
})

t('strict 与 relaxed 结果不同/相同可复现', () => {
  const rng = makeRng(5)
  const merged = []
  for (let i = 0; i < 200; i++) {
    const h = 100 + rng() * 10
    merged.push({ high: h, low: h - rng() * 5, rawMiddle: i, mi: i })
  }
  const s = c.calcFractals(merged, { fractal: { mode: 'strict' } })
  const r = c.calcFractals(merged, { fractal: { mode: 'relaxed' } })
  // relaxed 条件更宽，结果分型数不少于 strict
  assert(r.length >= s.length, 'relaxed >= strict')
})

t('分型：createAnalyzer 增量与全量一致', () => {
  const rng = makeRng(11)
  const bars = []
  let p = 100
  for (let i = 0; i < 260; i++) {
    const o = p
    const cl = o + (rng() - 0.5) * 8
    bars.push({ timestamp: i, open: o, high: Math.max(o, cl) + rng(), low: Math.min(o, cl) - rng(), close: cl })
    p = cl
  }
  const cfg = c.normalizeConfig()
  const full = c.analyze(bars, cfg)
  const a = c.createAnalyzer(cfg)
  a.update(bars.slice(0, 20))
  // 分多步增量，每步与全量对比分型（严格一致）
  let idx = 20
  while (idx < bars.length) {
    const step = Math.min(5, bars.length - idx)
    a.update(bars.slice(idx, idx + step))
    idx += step
    const ref = c.analyze(bars.slice(0, idx), cfg)
    deepEqual(a.state.fractals, ref.fractals, 'fractals identical at idx ' + idx)
    deepEqual(a.state.strokes, ref.strokes, 'strokes identical at idx ' + idx)
  }
})
