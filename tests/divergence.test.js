/*!
 * tests/divergence.test.js —— 笔背驰（MACD 动量 + 大级别线段动量确认）
 *
 * 覆盖：
 *   - macdHistogram / rangeMomentum 基本性质
 *   - 合成结构强背驰：局部动量衰减 + 大级别同向线段动量同步衰减 → confirmed
 *   - 大级别无比价时 fading=null、扩张时降级弱背驰
 *   - requireCenter 开关语义、未创极值不回溯误配
 *   - 有机行情顶/底背驰（镜像路径）、provisional 标记
 *   - 增量链路一致性：analyze 全量 vs createAnalyzer 增量逐字段一致
 */
'use strict'
const { barsFrom, randomWalk } = require('./helpers')
const c = require('../chanlun.js')
const t = (name, fn) => global.__registerTest('divergence: ' + name, fn)

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}
function near(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) throw new Error((msg || 'not near') + ': ' + a + ' vs ' + b)
}

// 数值路径构造器：leg 线性推进 / flat 平台
function path() {
  const s = []
  return {
    arr: s,
    leg(from, to, n) {
      for (let i = 1; i <= n; i++) s.push(from + ((to - from) * i) / n)
      return this
    },
    flat(v, n) {
      for (let i = 0; i < n; i++) s.push(v)
      return this
    }
  }
}

// ---------------------------------------------------------------------------
// macdHistogram / rangeMomentum
// ---------------------------------------------------------------------------

t('macdHistogram 长度一致且常数序列柱为 0', () => {
  const h = c.macdHistogram(new Array(60).fill(100), 12, 26, 9)
  assert(h.length === 60, 'length matches input')
  for (let i = 30; i < 60; i++) near(h[i], 0, 1e-9, 'constant series hist → 0')
})

t('macdHistogram 上涨转下跌时柱由正转负', () => {
  const closes = []
  for (let i = 1; i <= 40; i++) closes.push(100 + i * 2)
  for (let i = 1; i <= 40; i++) closes.push(180 - i * 2.5)
  const h = c.macdHistogram(closes, 12, 26, 9)
  assert(h[36] > 0, '上涨末段柱为正: ' + h[36])
  assert(h[70] < 0, '下跌段柱为负: ' + h[70])
})

t('rangeMomentum 同向面积口径', () => {
  const h = [1, -2, 3, -4, 5]
  near(c.rangeMomentum(h, 0, 4, 'up'), 9, 1e-9, 'up = 正柱和')
  near(c.rangeMomentum(h, 0, 4, 'down'), 6, 1e-9, 'down = 负柱绝对值和')
})

// ---------------------------------------------------------------------------
// 合成结构（绕开流水线，直接控制笔/线段/中枢）
// ---------------------------------------------------------------------------

// 收盘价路径：预热 → 强涨(rally1) → 回调(dip) → 慢涨创新高(rally2) → 回落
function strongScenarioCloses() {
  return path()
    .flat(100, 12)
    .leg(100, 180, 20) // rally1：强
    .leg(180, 156, 8) // dip
    .leg(156, 197, 40) // rally2：慢，创新高
    .leg(197, 170, 6).arr
}

// mi 与 raw 一一对应的恒等 merged 表
function identityMerged(n) {
  const m = []
  for (let i = 0; i < n; i++) m.push({ rawStart: i, rawEnd: i })
  return m
}

function fakeStroke(si, dir, fromMi, toMi, toValue) {
  return { si, dir, from: { mi: fromMi }, to: { mi: toMi }, fromRaw: fromMi, toRaw: toMi, toValue }
}

function fakeSegment(dir, fromMi, toMi, finished) {
  return { dir, from: { mi: fromMi }, to: { mi: toMi }, fromRaw: fromMi, toRaw: toMi, finished }
}

// 三笔两线段的基准场景：s0 强涨 / s1 回调 / s2 慢涨新高；
// centers 覆盖 (0,2) 区间满足 requireCenter。
function syntheticCase(segments, centers) {
  return {
    closes: strongScenarioCloses(),
    merged: identityMerged(86),
    strokes: [
      fakeStroke(0, 'up', 12, 32, 180), // rally1（窗口对齐强涨段）
      fakeStroke(1, 'down', 32, 40, 156),
      fakeStroke(2, 'up', 40, 80, 197) // 慢涨新高
    ],
    segments: segments || [],
    centers: centers || [{ startIndex: 1, endIndex: 1 }]
  }
}

t('局部衰减+大级别同向衰减 → 强背驰 confirmed', () => {
  const kase = syntheticCase([
    fakeSegment('up', 12, 32, true), // 前一同向线段（已完结，强）
    fakeSegment('up', 40, 80, false) // 当前线段（慢涨）包含 s2
  ])
  const out = c.calcDivergences(kase.strokes, kase.segments, kase.centers, kase.merged, kase.closes, c.normalizeConfig({}))
  assert(out.length >= 1, '至少一个事件: ' + JSON.stringify(out))
  const d = out[out.length - 1]
  assert(d.si === 2 && d.kind === 'top' && d.prevSi === 0, '顶背驰 si=2 对比 si=0')
  assert(d.momentum.ratio < 0.9, '动量衰减 ratio=' + d.momentum.ratio)
  assert(d.bigLevel.aligned === true, '大级别同向')
  assert(d.bigLevel.fading === true, '大级别动量衰减')
  assert(d.confirmed === true && d.strength === 'strong', '强背驰 confirmed')
})

t('大级别动量更强时降级弱背驰', () => {
  // 当前线段=慢涨段（强度 1.43），前同向线段=近零动量的横盘窗（强度≈0）
  // → 当前/前 ≫ 1，大级别动量未衰减
  const kase = syntheticCase([
    fakeSegment('up', 0, 12, true),
    fakeSegment('up', 40, 80, false)
  ])
  const out = c.calcDivergences(kase.strokes, kase.segments, kase.centers, kase.merged, kase.closes, c.normalizeConfig({}))
  assert(out.length >= 1, '局部背驰仍触发')
  const d = out[out.length - 1]
  assert(d.bigLevel.fading === false, '大级别动量扩张 fading=false')
  assert(d.confirmed === false && d.strength === 'weak', '降级为弱背驰')
})

t('大级别无比价时 fading=null 且保守输出弱背驰', () => {
  const kase = syntheticCase([fakeSegment('up', 12, 80, false)])
  const out = c.calcDivergences(kase.strokes, kase.segments, kase.centers, kase.merged, kase.closes, c.normalizeConfig({}))
  assert(out.length >= 1, '局部背驰触发')
  const d = out[out.length - 1]
  assert(d.bigLevel.segmentSi === 0, '落在唯一线段内')
  assert(d.bigLevel.momentumRatio === null && d.bigLevel.fading === null, '无比价 → null')
  assert(d.strength === 'weak' && d.confirmed === false, '弱背驰')
})

t('笔落在线段外时 segmentSi=-1 且不确认', () => {
  const kase = syntheticCase([])
  const out = c.calcDivergences(kase.strokes, kase.segments, kase.centers, kase.merged, kase.closes, c.normalizeConfig({}))
  assert(out.length >= 1, '无线段不影响局部判定')
  const d = out[out.length - 1]
  assert(d.bigLevel.segmentSi === -1, '无线段 → -1')
  assert(d.confirmed === false, '不确认')
})

t('requireCenter=false 时无需中枢即可判；开启则不判', () => {
  const kase = syntheticCase([], [])
  const off = c.normalizeConfig({ divergence: { requireCenter: false } })
  const on = c.normalizeConfig({ divergence: { requireCenter: true } })
  assert(c.calcDivergences(kase.strokes, [], [], kase.merged, kase.closes, off).length === 1, '关闭要求 → 触发')
  assert(c.calcDivergences(kase.strokes, [], [], kase.merged, kase.closes, on).length === 0, '开启要求+无中枢 → 不判')
})

t('未创极值的同向笔终止回溯，不产生跨段误配', () => {
  const closes = path().leg(100, 130, 30).leg(130, 97, 10).leg(97, 112, 15).arr
  const merged = identityMerged(closes.length)
  const strokes = [
    fakeStroke(0, 'up', 0, 30, 130),
    fakeStroke(1, 'down', 30, 40, 97),
    fakeStroke(2, 'up', 40, 55, 112) // 未超过 130 → 无比较对象
  ]
  const cfg = c.normalizeConfig({ divergence: { requireCenter: false } })
  assert(c.calcDivergences(strokes, [], [], merged, closes, cfg).length === 0, '不判背驰')
})

t('输入不足时不崩溃返回空', () => {
  const cfg = c.normalizeConfig({})
  assert(c.calcDivergences([], [], [], [], [], cfg).length === 0, '空输入')
  assert(c.calcDivergences([{ si: 0, dir: 'up' }], [], [], [], [], cfg).length === 0, '笔不足')
})

// ---------------------------------------------------------------------------
// 有机行情：完整流水线（merge→fractal→stroke→segment→center→divergence）
// ---------------------------------------------------------------------------

// 顶背驰场景：UP 强涨 → 深跌 → 反转上涨 → 中枢锯齿 → 弱势创新高 → 回落
function buildTopDivSeq() {
  return path()
    .leg(100, 106, 6)
    .leg(106, 168, 10).flat(168, 2) // UP1 强涨
    .leg(168, 98, 14).flat(98, 1) // DOWN1 深跌
    .leg(98, 150, 10).flat(150, 2) // 反转上涨
    .leg(150, 136, 4).flat(136, 1)
    .leg(136, 148, 5).flat(148, 1) // 中枢锯齿
    .leg(148, 138, 5).flat(138, 1)
    .leg(138, 146, 5).flat(146, 1)
    .leg(146, 139, 5).flat(139, 1)
    .leg(139, 172, 30).flat(172, 2) // 弱势创新高
    .leg(172, 140, 7).arr
}

t('有机顶背驰：弱势创新高触发事件并带大级别上下文', () => {
  const r = c.analyze(barsFrom(buildTopDivSeq()))
  assert(r.strokes.length >= 6, '结构成形 strokes=' + r.strokes.length)
  const lastSi = r.strokes.length - 1
  const d = r.divergences.find((x) => x.kind === 'top' && x.si === lastSi)
  assert(d, '最后一笔存在顶背驰: ' + JSON.stringify(r.divergences))
  assert(d.provisional === true, '尾笔 provisional 标记')
  assert(d.prevSi === lastSi - 2, '与最近同向笔比较')
  assert(d.momentum.ratio < 0.9 && d.momentum.previous > 0, '动量数值合理')
  assert(typeof d.bigLevel.segmentSi === 'number', '大级别字段存在')
  assert(['weak', 'strong'].includes(d.strength), 'strength 枚举')
})

t('镜像路径产生底背驰', () => {
  const seq = buildTopDivSeq().map((v) => 300 - v)
  const r = c.analyze(barsFrom(seq))
  const lastSi = r.strokes.length - 1
  const d = r.divergences.find((x) => x.kind === 'bottom' && x.si === lastSi)
  assert(d, '最后一笔存在底背驰: ' + JSON.stringify(r.divergences.map((x) => x.kind)))
  assert(d.dir === 'down' && d.value === r.strokes[lastSi].toValue, 'value 为新低点')
})

t('requireCenter=false 在有机数据上事件集为超集', () => {
  const bars = barsFrom(buildTopDivSeq())
  const strict = c.analyze(bars, { divergence: { requireCenter: true } }).divergences
  const loose = c.analyze(bars, { divergence: { requireCenter: false } }).divergences
  assert(loose.length >= strict.length, '宽松条件事件不少于严格条件')
  for (const d of strict) {
    assert(
      loose.some((x) => x.si === d.si && x.prevSi === d.prevSi),
      '严格条件下的事件在宽松条件下保留: si=' + d.si
    )
  }
})

// ---------------------------------------------------------------------------
// 增量一致性
// ---------------------------------------------------------------------------

t('增量链路与全量 analyze 逐字段一致（含 updateLast）', () => {
  for (const seed of [42, 7, 2024]) {
    const bars = randomWalk(240, seed)
    const full = c.analyze(bars)
    const inc = c.createAnalyzer()
    inc.update(bars.slice(0, 60))
    for (let i = 60; i < bars.length; i += 5) inc.update(bars.slice(i, Math.min(i + 5, bars.length)))
    inc.updateLast(bars[bars.length - 1])
    const a = JSON.stringify(full.divergences)
    const b = JSON.stringify(inc.state.divergences)
    assert(a === b, 'seed ' + seed + ' 不一致\n full=' + a + '\n inc=' + b)
  }
})

t('逐根增量过程中任意时刻与全量一致', () => {
  const bars = randomWalk(200, 99)
  const inc = c.createAnalyzer()
  inc.update(bars.slice(0, 50))
  for (let i = 50; i < bars.length; i++) {
    inc.update(bars.slice(i, i + 1))
    if (i % 37 !== 0) continue
    const ref = c.analyze(bars.slice(0, i + 1))
    const a = JSON.stringify(ref.divergences)
    const b = JSON.stringify(inc.state.divergences)
    assert(a === b, 'step ' + i + ' 不一致\n ref=' + a + '\n inc=' + b)
  }
})
