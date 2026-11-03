/*!
 * tests/fixtures.test.js —— 测试数据验证
 *
 * 对 tests/fixtures.js 中的每个场景：
 *   1. 结构不变量：笔方向交替、笔首尾相连、线段不重叠、笔端点=有效分型；
 *   2. 锁定结构统计：与人工核对过的预期完全一致（防回归）；
 *   3. 增量一致性：逐根 update 与全量 analyze 一致。
 */
'use strict'
const { FIXTURES, FIXTURE_CONFIG } = require('./fixtures')
const c = require('../chanlun.js')
const assert = require('assert')
const t = (name, fn) => global.__registerTest('fixtures: ' + name, fn)

t('结构不变量（所有场景）', () => {
  for (const [name, fx] of Object.entries(FIXTURES)) {
    const r = c.analyze(fx.bars, FIXTURE_CONFIG)
    assert.strictEqual(r.dataLen, fx.bars.length, name + ' dataLen')

    // 笔方向交替、首尾相连
    for (let i = 1; i < r.strokes.length; i++) {
      assert.notStrictEqual(r.strokes[i].dir, r.strokes[i - 1].dir, name + ' strokes alternate at ' + i)
      assert.strictEqual(r.strokes[i].fromRaw, r.strokes[i - 1].toRaw, name + ' strokes chained at ' + i)
    }

    // 线段首尾相接且已终结段不重叠
    for (let i = 1; i < r.segments.length; i++) {
      assert.strictEqual(r.segments[i].fromRaw, r.segments[i - 1].toRaw, name + ' segments chained at ' + i)
    }

    // 笔端点 = 有效分型（允许末位未配对端点）
    const es = new Set()
    for (const s of r.strokes) { es.add(s.fromRaw); es.add(s.toRaw) }
    for (let i = 0; i < r.fractals.length - 1; i++) {
      assert(es.has(r.fractals[i].rawMiddle), name + ' fractal ' + i + ' is stroke endpoint')
    }

    // 中枢区间合法（zg 下沿 < 上沿）
    for (const z of r.strokeCenters) assert(z.zsLow < z.zsHigh, name + ' stroke center interval valid')
    for (const z of r.segmentCenters) assert(z.zsLow < z.zsHigh, name + ' segment center interval valid')
  }
})

t('锁定结构统计（防回归）', () => {
  for (const [name, fx] of Object.entries(FIXTURES)) {
    const r = c.analyze(fx.bars, FIXTURE_CONFIG)
    const e = fx.expect
    assert.strictEqual(r.merged.length, e.merged, name + ' merged')
    if (typeof e.fractals === 'number') assert.strictEqual(r.fractals.length, e.fractals, name + ' fractals')
    assert.strictEqual(r.strokes.length, e.strokes, name + ' strokes')
    assert.strictEqual(r.segments.length, e.segments, name + ' segments')
    assert.strictEqual(r.segments.filter((s) => s.finished).length, e.finishedSegments, name + ' finished')
    assert.strictEqual(r.strokeCenters.length, e.strokeCenters, name + ' strokeCenters')
    assert.strictEqual(r.segmentCenters.length, e.segmentCenters, name + ' segmentCenters')
    if (e.lastSegment) {
      const ls = r.segments[r.segments.length - 1]
      assert.deepStrictEqual(
        { dir: ls.dir, fromRaw: ls.fromRaw, toRaw: ls.toRaw, finished: ls.finished },
        e.lastSegment,
        name + ' last segment'
      )
    }
    if (e.strokeDirs) {
      assert.deepStrictEqual(r.strokes.map((s) => s.dir), e.strokeDirs, name + ' stroke dirs')
    }
    if (e.endpoints) {
      assert.deepStrictEqual(
        r.strokes.map((s) => s.fromRaw).concat(r.strokes[r.strokes.length - 1].toRaw),
        e.endpoints,
        name + ' stroke endpoints'
      )
    }
    if (e.segmentDirs) {
      assert.deepStrictEqual(r.segments.map((s) => s.dir), e.segmentDirs, name + ' segment dirs')
    }
  }
})

t('每个场景逐根增量 == 全量', () => {
  for (const [name, fx] of Object.entries(FIXTURES)) {
    const a = c.createAnalyzer(FIXTURE_CONFIG)
    const half = Math.floor(fx.bars.length / 2)
    a.update(fx.bars.slice(0, half))
    for (let i = half; i < fx.bars.length; i++) {
      a.update(fx.bars.slice(i, i + 1))
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(a.state)),
        JSON.parse(JSON.stringify(c.analyze(fx.bars.slice(0, i + 1), FIXTURE_CONFIG))),
        name + ' bar ' + i
      )
    }
  }
})
