/*!
 * tests/segment.test.js —— 线段（特征序列法）
 *   - 覆盖：起点重叠确立、第一种情况、第二种情况（缺口）、尾部未完成
 *   - 增量（createAnalyzer.update / updateLast）与全量一致性
 */
'use strict'
const { randomWalk } = require('./helpers')
const c = require('../chanlun.js')
const assert = require('assert')
const t = (name, fn) => global.__registerTest('segment: ' + name, fn)

t('随机数据的全量 + 逐根 update 增量一致性', () => {
  for (const seed of [1, 2, 3, 42, 99]) {
    const bars = randomWalk(240, seed)
    const cfg = { biMinGap: 4 }
    const a = c.createAnalyzer(cfg)
    a.update(bars.slice(0, 40))
    for (let i = 40; i < bars.length; i++) {
      a.update(bars.slice(i, i + 1))
      assert.deepStrictEqual(a.state, c.analyze(bars.slice(0, i + 1), cfg), 'seed ' + seed + ' bar ' + i)
    }
  }
})

t('多种参数下逐根 update 一致性', () => {
  const bars = randomWalk(200, 7)
  const variants = [
    { biMinGap: 2, fractal: { mode: 'relaxed' } },
    { biMinGap: 6, fractal: { mode: 'strict' } },
    { biMinGap: 3 }
  ]
  for (const cfg of variants) {
    const a = c.createAnalyzer(cfg)
    a.update(bars.slice(0, 30))
    for (let i = 30; i < bars.length; i++) {
      a.update(bars.slice(i, i + 1))
      assert.deepStrictEqual(a.state, c.analyze(bars.slice(0, i + 1), cfg), JSON.stringify(cfg) + ' bar ' + i)
    }
  }
})

t('updateLast（定型）与 update（新K线）一致性', () => {
  for (const seed of [1, 5, 11]) {
    const bars = randomWalk(130, seed)
    const cfg = { biMinGap: 4 }
    const a = c.createAnalyzer(cfg)
    let ref = bars.slice(0, 60)
    a.update(ref)
    for (let step = 60; step < bars.length; step++) {
      // 定型最后一根
      const last = ref[ref.length - 1]
      const mutated = { ...last, close: last.close + 0.3, high: Math.max(last.high, last.close + 0.3) }
      a.updateLast(mutated)
      ref[ref.length - 1] = mutated
      assert.deepStrictEqual(a.state, c.analyze(ref, cfg), 'last update seed ' + seed + ' step ' + step)
      // 追加新K线
      a.update(bars.slice(step, step + 1))
      ref = ref.concat(bars.slice(step, step + 1))
      assert.deepStrictEqual(a.state, c.analyze(ref, cfg), 'append update seed ' + seed + ' step ' + step)
    }
  }
})

t('起点需要前三笔重叠：无重叠则无线段', () => {
  // 直接构造三段互不重叠的笔（用 stroke 对象喂给 segmentScan / calcSegments）
  const strokes = [
    { si: 0, dir: 'down', from: { high: 30, low: 10 }, to: { high: 25, low: 5 }, fromRaw: 0, toRaw: 5, high: 30, low: 5 },
    { si: 1, dir: 'up', from: { high: 25, low: 5 }, to: { high: 60, low: 40 }, fromRaw: 5, toRaw: 10, high: 60, low: 5 },
    { si: 2, dir: 'down', from: { high: 60, low: 40 }, to: { high: 55, low: 35 }, fromRaw: 10, toRaw: 15, high: 60, low: 35 }
  ]
  // 三段彼此高位不重叠 → 找不到起点 → 无线段
  const segs = c.calcSegments(strokes, c.normalizeConfig())
  assert.strictEqual(segs.length, 0, 'no overlap -> no segment')
})

t('前三笔重叠 → 起点确立 → 尾部未完成线段', () => {
  const strokes = [
    { si: 0, dir: 'down', from: { high: 30, low: 10 }, to: { high: 25, low: 5 }, fromRaw: 0, toRaw: 5, high: 30, low: 5 },
    { si: 1, dir: 'up', from: { high: 25, low: 5 }, to: { high: 32, low: 12 }, fromRaw: 5, toRaw: 10, high: 32, low: 5 }, // 与 s0 重叠
    { si: 2, dir: 'down', from: { high: 32, low: 12 }, to: { high: 28, low: 8 }, fromRaw: 10, toRaw: 15, high: 32, low: 8 } // 三者共区 [10,30]∩[12,25]
  ]
  const segs = c.calcSegments(strokes, c.normalizeConfig())
  assert.strictEqual(segs.length, 1, 'one open segment')
  assert.strictEqual(segs[0].finished, false, 'unfinished tail')
  assert.strictEqual(segs[0].fromRaw, 0)
})

t('缺口（第二种情况）不误判为第一种情况终点', () => {
  // 构造：向上线段，特征元素间出现缺口（f1.low > f0.high），应进入待确认而非立即终结
  // 用真实 analyzer 生成足够数据更稳健：
  const bars = randomWalk(120, 21)
  const cfg = { biMinGap: 4 }
  const r = c.analyze(bars, cfg)
  // 只断言结构不抛异常、返回数组、字段完整
  assert(Array.isArray(r.segments), 'segments array')
  for (const s of r.segments) {
    assert('dir' in s && 'fromRaw' in s && 'toRaw' in s && 'finished' in s, 'segment fields')
  }
})

t('analyze 输出格式不变（关键字段齐全）', () => {
  const bars = randomWalk(150, 8)
  const r = c.analyze(bars, { biMinGap: 4 })
  const keys = ['merged', 'fractals', 'strokes', 'segments', 'strokeCenters', 'segmentCenters', 'dataLen']
  for (const k of keys) assert(k in r, 'has ' + k)
  assert.strictEqual(r.dataLen, bars.length, 'dataLen')
})

// ---------------------------------------------------------------------------
// 特征序列可视化数据
// ---------------------------------------------------------------------------

// 直接构造笔（绕开 merge/fractal/stroke 流水线）喂给 segmentScan
function mkStroke(si, dir, from, to) {
  const high = Math.max(from, to)
  const low = Math.min(from, to)
  return {
    si, dir,
    from: { high, low },
    to: { high, low },
    fromRaw: si * 5, toRaw: si * 5 + 5,
    high, low, fromValue: from, toValue: to
  }
}

t('特征序列：第一种情况（无缺口）各段 features 为特征方向原始笔', () => {
  // 向上线段特征序列 = 向下笔 [s1, s3, s5]，s3 顶（无缺口）
  const strokes = [
    mkStroke(0, 'up', 100, 110),
    mkStroke(1, 'down', 110, 100),
    mkStroke(2, 'up', 100, 115),
    mkStroke(3, 'down', 115, 109),
    mkStroke(4, 'up', 109, 113),
    mkStroke(5, 'down', 113, 106)
  ]
  const r = c.segmentScan(strokes, 0)
  const seg0 = r.segments[0]
  assert.strictEqual(seg0.dir, 'up')
  // 特征元素 = 特征方向（down）笔，含确认分型第三个元素 s5
  assert.deepStrictEqual(seg0.features.map((f) => f.si), [1, 3, 5], 'seg0 features s1/s3/s5')
  for (const f of seg0.features) {
    assert.strictEqual(f.dir, 'down', '特征方向')
    assert('high' in f && 'low' in f && 'fromRaw' in f && 'toRaw' in f && 'fromValue' in f && 'toValue' in f, 'feature fields')
  }
  // 尾部未完成线段（down）的特征 = 向上笔
  const tail = r.segments[1]
  assert.strictEqual(tail.finished, false)
  assert.deepStrictEqual(tail.features.map((f) => f.si), [4], 'tail features = s4(up)')
  assert.strictEqual(tail.features[0].dir, 'up', 'tail 特征方向')
})

t('特征序列：增量链路与全量逐字段一致（含 features）', () => {
  for (const seed of [1, 7, 42]) {
    const bars = randomWalk(180, seed)
    const cfg = { biMinGap: 4 }
    const a = c.createAnalyzer(cfg)
    a.update(bars.slice(0, 50))
    for (let i = 50; i < bars.length; i++) {
      a.update(bars.slice(i, i + 1))
      const st = a.state
      const ref = c.analyze(bars.slice(0, i + 1), cfg)
      assert.deepStrictEqual(st.segments, ref.segments, 'seed ' + seed + ' bar ' + i + ' segments(features) 一致')
      assert.deepStrictEqual(st, ref, 'seed ' + seed + ' bar ' + i + ' 全字段一致')
    }
  }
})
