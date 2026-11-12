/*!
 * tests/analyzer.test.js —— 增量计算（createAnalyzer）可靠性
 *
 * 覆盖 update/updateLast 的边界语义：
 *   - 空批次 no-op；追加批大小无关（一次大包 == 逐根小包）
 *   - updateLast 定型与 update 追加交替（回退重放与增量混合）
 *   - reset 后复用；参数化（minGap / center minElements）
 *   - 输入不变量：analyzer 不修改调用方传入的 K 线数组
 */
'use strict'
const { randomWalk, barsFrom } = require('./helpers')
const c = require('../chanlun.js')
const assert = require('assert')
const t = (name, fn) => global.__registerTest('analyzer: ' + name, fn)

t('空批次 update 为 no-op', () => {
  const bars = randomWalk(80, 1)
  const a = c.createAnalyzer({ biMinGap: 4 })
  a.update(bars)
  const s1 = JSON.stringify(a.state)
  a.update([])
  assert.strictEqual(JSON.stringify(a.state), s1)
  a.updateLast(bars[bars.length - 1])
  assert.strictEqual(JSON.stringify(a.state), s1, '相同末根 updateLast 也是 no-op')
})

t('一次大批量 == 逐根小批量（最终状态一致）', () => {
  const bars = randomWalk(240, 5)
  const cfg = { biMinGap: 4 }
  const big = c.createAnalyzer(cfg)
  big.update(bars)
  const small = c.createAnalyzer(cfg)
  for (let i = 0; i < bars.length; i++) small.update(bars.slice(i, i + 1))
  assert.deepStrictEqual(JSON.parse(JSON.stringify(small.state)), JSON.parse(JSON.stringify(big.state)))
})

t('updateLast 与 update 混合（回退重放 + 增量）仍与全量一致', () => {
  for (const seed of [3, 9, 17]) {
    const bars = randomWalk(150, seed)
    const cfg = { biMinGap: 4 }
    const a = c.createAnalyzer(cfg)
    let ref = bars.slice(0, 50)
    a.update(ref)
    for (let step = 50; step < bars.length; step += 3) {
      // 定型当前末根
      const last = ref[ref.length - 1]
      const mutated = { ...last, close: last.close - 0.2, low: Math.min(last.low, last.close - 0.2) }
      a.updateLast(mutated)
      ref[ref.length - 1] = mutated
      assert.deepStrictEqual(a.state, c.analyze(ref, cfg), 'last seed ' + seed + ' step ' + step)
      // 追加 2 根
      a.update(bars.slice(step, Math.min(step + 2, bars.length)))
      ref = ref.concat(bars.slice(step, Math.min(step + 2, bars.length)))
      assert.deepStrictEqual(a.state, c.analyze(ref, cfg), 'append seed ' + seed + ' step ' + step)
    }
  }
})

t('仅末根收盘价变化（merged 不变）时尾部刷新与全量逐字段一致', () => {
  // 实时行情最常见的 tick：只改 close，high/low 不变 → 包含关系/分型/笔/线段/
  // 中枢全都不动，只有 MACD 柱尾部变化。此时走背驰上下文尾部刷新快路径，
  // 每个 tick 仍必须与 analyze(全部数据) 逐字段一致。
  for (const seed of [7, 42, 1234]) {
    const bars = randomWalk(400, seed)
    const cfg = { biMinGap: 4 }
    const a = c.createAnalyzer(cfg)
    const ref = bars.slice()
    a.update(ref)
    const last0 = ref[ref.length - 1]

    for (let k = 1; k <= 60; k++) {
      const mutated = Object.assign({}, last0, { close: last0.close + ((k % 7) - 3) * 0.01 })
      a.updateLast(mutated)
      ref[ref.length - 1] = mutated
      assert.deepStrictEqual(a.state, c.analyze(ref, cfg), 'close-only seed ' + seed + ' tick ' + k)
    }

    // 穿插一次改 high（结构变化 → 重建上下文），之后再连续只改 close
    const bumped = Object.assign({}, ref[ref.length - 1], { high: last0.high + 3 })
    a.updateLast(bumped)
    ref[ref.length - 1] = bumped
    assert.deepStrictEqual(a.state, c.analyze(ref, cfg), 'high bump seed ' + seed)
    for (let k = 1; k <= 20; k++) {
      const mutated = Object.assign({}, bumped, { close: bumped.close + k * 0.01 })
      a.updateLast(mutated)
      ref[ref.length - 1] = mutated
      assert.deepStrictEqual(a.state, c.analyze(ref, cfg), 'post-bump seed ' + seed + ' tick ' + k)
    }
    assert(a.state.divergences.length > 0, '数据应产生背驰事件，确保快路径真正被覆盖')
  }
})

t('尾部刷新 / 结构重算 / 追加随机交替，始终与全量一致', () => {
  // divCtx 只在结构变化时重建。这里让三类操作随机交错，专门盯住
  // 「刷新 → 重建 → 再刷新」的状态衔接，每个 tick 与全量重算逐字段比对。
  const cfg = { biMinGap: 4 }
  for (const seed of [11, 29]) {
    const ref = randomWalk(600, seed)
    const a = c.createAnalyzer(cfg)
    a.update(ref)
    let s = seed
    const rnd = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
    for (let k = 0; k < 200; k++) {
      const roll = rnd()
      const last = ref[ref.length - 1]
      if (roll < 0.55) {
        // 只改 close → 尾部刷新快路径
        const b = Object.assign({}, last, { close: last.close + (rnd() - 0.5) * 0.5 })
        a.updateLast(b)
        ref[ref.length - 1] = b
      } else if (roll < 0.8) {
        // 改 high/low → 结构重算，divCtx 必须重建
        const b = Object.assign({}, last, {
          high: last.high + rnd() * 2,
          low: last.low - rnd() * 2,
          close: last.close + (rnd() - 0.5)
        })
        a.updateLast(b)
        ref[ref.length - 1] = b
      } else {
        // 追加新 K → 全量尾部重扫
        const b = {
          timestamp: last.timestamp + 60000,
          open: last.close,
          high: last.close + 1 + rnd(),
          low: last.close - 1 - rnd(),
          close: last.close + (rnd() - 0.5),
          volume: 100
        }
        a.update([b])
        ref.push(b)
      }
      assert.deepStrictEqual(a.state, c.analyze(ref, cfg), 'seed ' + seed + ' step ' + k)
    }
  }
})

t('reset 后可重新初始化', () => {
  const bars = randomWalk(100, 21)
  const a = c.createAnalyzer({ biMinGap: 4 })
  a.update(bars.slice(0, 60))
  a.reset()
  assert.deepStrictEqual(a.state, {
    merged: [], fractals: [], strokes: [], segments: [], strokeCenters: [], segmentCenters: [], divergences: [], dataLen: 0
  })
  a.update(bars)
  assert.deepStrictEqual(a.state, c.analyze(bars, { biMinGap: 4 }))
})

t('多种参数下增量与全量一致', () => {
  const bars = barsFrom([100, 103, 101, 106, 104, 109, 107, 112, 110, 115, 113, 118, 116, 121, 119, 124, 122, 127, 125, 130, 128, 133, 131, 136, 134, 139, 137, 142, 140, 145])
  const variants = [
    { biMinGap: 2, center: { minElements: 4 } },
    { biMinGap: 6, center: { minElements: 3 } },
    { biMinGap: 3 }
  ]
  for (const cfg of variants) {
    const a = c.createAnalyzer(cfg)
    a.update(bars.slice(0, 12))
    for (let i = 12; i < bars.length; i += 5) {
      a.update(bars.slice(i, i + 5))
      assert.deepStrictEqual(a.state, c.analyze(bars.slice(0, Math.min(i + 5, bars.length)), cfg), JSON.stringify(cfg))
    }
  }
})

t('analyzer 不修改调用方传入的 K 线数组', () => {
  const bars = randomWalk(60, 33)
  const snapshot = JSON.parse(JSON.stringify(bars))
  const a = c.createAnalyzer({ biMinGap: 4 })
  a.update(bars)
  a.updateLast(bars[bars.length - 1])
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bars)), snapshot, '原始数组未被修改')
})
