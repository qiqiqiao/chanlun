/*!
 * tests/merge.test.js —— 包含关系合并
 */
'use strict'
const { barsFrom } = require('./helpers')
const c = require('../chanlun.js')
const t = (name, fn) => global.__registerTest('merge: ' + name, fn)

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}
function deepEqual(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || 'not deep equal') + '\n  got: ' + JSON.stringify(a) + '\n  want: ' + JSON.stringify(b))
  }
}

// 1. 单根K线
t('单根K线', () => {
  const { merged } = c.mergeBars(barsFrom([110]))
  deepEqual(merged.length, 1)
  assert(merged[0].high === 111 && merged[0].low === 99, 'high/low')
})

// 2. 三根无包含 → 3 根合并K线
t('三根非包含', () => {
  // 100→110→105：第二根[104,111] 与第一根[99,111]？改用明显不包含
  const bars = [
    { high: 110, low: 90 },
    { high: 120, low: 100 }, // 高更高低更高
    { high: 130, low: 110 }  // 高更高低更高
  ].map((b, i) => ({ timestamp: i, open: 0, close: 0, ...b }))
  const { merged } = c.mergeBars(bars)
  deepEqual(merged.length, 3, '3 distinct')
})

// 3. 非包含上行：3 根
t('非包含上行', () => {
  // 111/105 → 124/106（高更高、低更高）→ 120/100 与 118/96（高更低、低更低）全部非包含
  const bars = [
    { high: 111, low: 105 },
    { high: 124, low: 106 },
    { high: 120, low: 100 }
  ].map((b, i) => ({ timestamp: i, ...b }))
  const { merged } = c.mergeBars(bars)
  deepEqual(merged.length, 3, 'no containment -> 3')
})

// 4. 方向已知：先确立向上，再出现包含 → 取 高高低高
t('方向已知上涨包含：取高高低高', () => {
  const bars = [
    { high: 100, low: 95 },   // i0
    { high: 120, low: 110 },  // 高高低高 → 向上（非包含）
    { high: 115, low: 112 }   // 含 i1（115≤120 且 112≥110）→ 方向=1 取 max → {120,112}
  ].map((b, i) => ({ timestamp: i, ...b }))
  const { merged } = c.mergeBars(bars)
  deepEqual(merged.length, 2, 'merged into 2')
  // rawMiddle 是原始K线索引：rawIndices=[1,2] 中间位 = rawIndices[1]=2
  deepEqual(merged[1], { high: 120, low: 112, rawIndices: [1, 2], rawMiddle: 2, rawStart: 1, rawEnd: 2 })
})

// 4b. 方向已知下跌包含：取 低低高低
t('方向已知下跌包含：取低低高低', () => {
  const bars = [
    { high: 125, low: 111 },  // i0
    { high: 105, low: 100 },  // 105<125 向下（105<111 成立）
    { high: 110, low: 96 }    // 包含 i1（110>105 且 96<100）→ 方向=-1 取 {105,96}
  ].map((b, i) => ({ timestamp: i, ...b }))
  const { merged } = c.mergeBars(bars)
  deepEqual(merged.length, 2, 'merged into 2')
  deepEqual(merged[1], { high: 105, low: 96, rawIndices: [1, 2], rawMiddle: 2, rawStart: 1, rawEnd: 2 })
})

// 5. 方向未知的包含：保留更大区间
t('方向未知包含（更大的区间）', () => {
  // 两根，第二根包含第一根：方向未知 → high 取大者、low 取小者
  const bars = [
    { high: 110, low: 100 },
    { high: 115, low: 95 }
  ].map((b, i) => ({ timestamp: i, ...b }))
  const { merged } = c.mergeBars(bars)
  deepEqual(merged.length, 1, 'one merged')
  assert(merged[0].high === 115 && merged[0].low === 95, 'wider interval')
})

// 6. 连续包含（方向未定从第一对开始）
t('连续包含', () => {
  // 108/100 与 105/102 包含（方向未知）→ {108,100}；105/102 不构成改变，110/101 非包含向上 → 新根
  const bars = [
    { high: 108, low: 100 },
    { high: 105, low: 102 },
    { high: 110, low: 101 }
  ].map((b, i) => ({ timestamp: i, ...b }))
  const { merged } = c.mergeBars(bars)
  deepEqual(merged.length, 2, 'two groups')
  deepEqual(merged[0], { high: 108, low: 100, rawIndices: [0, 1], rawMiddle: 1, rawStart: 0, rawEnd: 1 })
})

// 7. 连续反向包含：方向确定后（向上），后续含根按向上合并
t('连续反向包含', () => {
  // 100/90 → 110/95（向上非包含）；105/99 含 {110,95}（105≤110 且 99≥95）→ {110,99}
  const bars = [
    { high: 100, low: 90 },
    { high: 110, low: 95 },
    { high: 105, low: 99 }
  ].map((b, i) => ({ timestamp: i, ...b }))
  const { merged } = c.mergeBars(bars)
  deepEqual(merged.length, 2, 'two merged')
  deepEqual(merged[1], { high: 110, low: 99, rawIndices: [1, 2], rawMiddle: 2, rawStart: 1, rawEnd: 2 })
})

// 8. 3 根连续包含（方向未定取更大），随后方向翻转
t('连续3根包含 + 方向翻转', () => {
  const bars = [
    { high: 120, low: 100 }, // 未知
    { high: 118, low: 102 }, // 包含 → 120,100
    { high: 116, low: 104 }, // 包含 → 120,100
    { high: 130, low: 110 }, // 向上
    { high: 128, low: 112 }  // 包含 → 130,112
  ].map((b, i) => ({ timestamp: i, ...b }))
  const { merged } = c.mergeBars(bars)
  deepEqual(merged.length, 2, '2 groups')
  deepEqual(merged[0], { high: 120, low: 100, rawIndices: [0, 1, 2], rawMiddle: 1, rawStart: 0, rawEnd: 2 })
  deepEqual(merged[1], { high: 130, low: 112, rawIndices: [3, 4], rawMiddle: 4, rawStart: 3, rawEnd: 4 })
})

// 9. mergeBars / resumeMerge 增量一致性（随机）
t('resumeMerge 与 mergeBars 一致', () => {
  const rng = require('./helpers').makeRng(7)
  const bars = []
  let p = 100
  for (let i = 0; i < 300; i++) {
    const o = p
    const cl = o + (rng() - 0.5) * 6
    bars.push({ timestamp: i, open: o, high: Math.max(o, cl) + rng() * 2, low: Math.min(o, cl) - rng() * 2, close: cl })
    p = cl
  }
  const { merged: fullMerged } = c.mergeBars(bars)
  // 逐批 resume
  const merged = []
  const dirs = []
  let idx = 0
  const BATCH = 17
  while (idx < bars.length) {
    c.resumeMerge(merged, dirs, bars.slice(idx, idx + BATCH), idx)
    idx += BATCH
  }
  deepEqual(JSON.parse(JSON.stringify(merged)), JSON.parse(JSON.stringify(fullMerged)), 'merge identical')
})

// 10. normalizeConfig 默认值 + 旧参数兼容
t('normalizeConfig 默认与兼容', () => {
  const d = c.normalizeConfig()
  deepEqual(d.bi.minGap, 4)
  deepEqual(d.fractal.mode, 'strict')
  const compat = c.normalizeConfig({ biMinGap: 7 })
  deepEqual(compat.bi.minGap, 7)
  const nested = c.normalizeConfig({ bi: { minGap: 3 }, fractal: { mode: 'relaxed' } })
  deepEqual(nested.bi.minGap, 3)
  deepEqual(nested.fractal.mode, 'relaxed')
})
