/*!
 * tests/draw.test.js —— 绘制可见窗口过滤回归（线段中枢不显示）
 *
 * 背景：drawChan 用 lowerBound 按起点二分定位可见元素，会漏掉「起点 < from
 * 但终点 >= from」的横跨左边界元素。线段中枢通常只有 1~2 个，一旦横跨左边界
 * 就整体消失（看最新数据时尤甚）；笔中枢遍布全数据所以不明显。
 *
 * 覆盖：
 *   - visibleInRange 单元：横跨左/右边界、完全在窗口外、空窗口
 *   - drawChan 端到端：fake 绘制环境驱动，断言横跨左边界的线段中枢被绘制
 */
'use strict'
const vm = require('vm')
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { randomWalk } = require('./helpers')
const t = (name, fn) => global.__registerTest('draw: ' + name, fn)

const CORE = ['src/config.js', 'src/merge.js', 'src/fractal.js', 'src/stroke.js', 'src/segment.js', 'src/center.js', 'src/divergence.js', 'src/analyzer.js', 'chanlun.js', 'data-layer.js', 'realtime.js', 'main.js']

function loadApp() {
  const sb = { console, __CHANLUN_TEST__: true, fetch: async () => ({ ok: false, status: 500, text: async () => '' }) }
  sb.window = sb
  sb.globalThis = sb
  sb.WebSocket = class { constructor() { throw new Error('no real WS') } }
  sb.setTimeout = (fn) => { fn(); return 0 }
  sb.clearTimeout = () => {}
  const fakeEl = {
    addEventListener() {},
    classList: { toggle() {} },
    textContent: '',
    value: '',
    querySelectorAll: () => []
  }
  sb.document = {
    readyState: 'loading',
    addEventListener() {},
    querySelector: () => fakeEl,
    querySelectorAll: () => [],
    createElement: () => ({ getContext: () => ({}), width: 0, height: 0, toDataURL: () => '' }),
    head: { appendChild() {} }
  }
  vm.createContext(sb)
  for (const f of CORE) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sb, { filename: f })
  return sb
}

function center(startRaw, endRaw) {
  return { startRaw, endRaw, zsLow: 90, zsHigh: 110 }
}

t('visibleInRange：横跨左边界的中枢必须返回（旧版漏画回归）', () => {
  const app = loadApp()
  const vir = app.__chanlunChart.visibleInRange
  const centers = [
    center(0, 500),
    center(600, 1200),
    center(1300, 3000) // 长中枢
  ]
  // 窗口 [2000, 3000]：1300-3000 横跨左边界 → 必须返回
  const r = vir(centers, (z) => z.startRaw, (z) => z.endRaw, 2000, 3000)
  // 跨 realm 数组原型不同，用 JSON 比较
  assert.strictEqual(JSON.stringify(r.map((z) => z.startRaw)), '[1300]', '横跨左边界的 1300-3000 必须返回')
})

t('visibleInRange：完全在窗口外 / 横跨右边界 / 空窗口', () => {
  const app = loadApp()
  const vir = app.__chanlunChart.visibleInRange
  const centers = [center(0, 500), center(600, 1200), center(1300, 3000)]

  // 窗口 [1500, 2500]：1300-3000 同时横跨左右边界（起点<from 且 终点>to）
  let r = vir(centers, (z) => z.startRaw, (z) => z.endRaw, 1500, 2500)
  assert.strictEqual(JSON.stringify(r.map((z) => z.startRaw)), '[1300]')

  // 窗口 [0, 100]：只含第一个（0-500 横跨右边界）
  r = vir(centers, (z) => z.startRaw, (z) => z.endRaw, 0, 100)
  assert.strictEqual(JSON.stringify(r.map((z) => z.startRaw)), '[0]')

  // 窗口 [5000, 6000]：全部在左侧 → 空
  r = vir(centers, (z) => z.startRaw, (z) => z.endRaw, 5000, 6000)
  assert.strictEqual(JSON.stringify(r), '[]')

  // 空数组
  assert.strictEqual(JSON.stringify(vir([], (z) => z.startRaw, (z) => z.endRaw, 0, 10)), '[]')
  // 零宽窗口 [10,10]：中枢 0-500 与之相交（横跨）→ 仍返回（“相交即绘制”语义）
  assert.strictEqual(JSON.stringify(vir(centers, (z) => z.startRaw, (z) => z.endRaw, 10, 10).map((z) => z.startRaw)), '[0]')
})

t('visibleInRange：窗口完全包含中枢 / 多个中枢', () => {
  const app = loadApp()
  const vir = app.__chanlunChart.visibleInRange
  const centers = [center(100, 200), center(300, 400), center(500, 600)]
  const r = vir(centers, (z) => z.startRaw, (z) => z.endRaw, 150, 550)
  assert.strictEqual(JSON.stringify(r.map((z) => z.startRaw)), '[100,300,500]', '横跨左边界 + 窗口内 + 横跨右边界')
})

t('drawChan：横跨左边界的线段中枢被绘制（端到端回归）', () => {
  const app = loadApp()
  // 数据：seed 99 的 3000 根随机K线 → 线段中枢 [1894-2990]
  const bars = randomWalk(3000, 99)
  app.__chanlunChart.runChanCalc(bars)
  const centers = app.__chanlunChart.chanState.segmentCenters
  assert(centers.length >= 1, '数据应产生线段中枢')

  // fake 绘制环境
  const rects = []
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 0,
    fillRect(x, y, w, h) { rects.push({ kind: 'fill', x, y, w, h }) },
    strokeRect(x, y, w, h) { rects.push({ kind: 'stroke', x, y, w, h }) },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, fill() {}, arc() {}, fillText() {}
  }
  const chart = {
    getVisibleRange: () => ({ realFrom: 2500, realTo: 3000 }),
    getBarSpace: () => ({ gapBar: 8, halfGapBar: 4 })
  }
  const xAxis = { convertToPixel: (v) => v } // 像素 = 索引
  const yAxis = { convertToPixel: (v) => 1000 - v }
  const args = { ctx, chart, indicator: {}, bounding: {}, xAxis, yAxis }

  // 只看线段中枢：关闭其他图层，避免噪音
  app.__chanlunChart.state.chanOptions.fractal = false
  app.__chanlunChart.state.chanOptions.stroke = false
  app.__chanlunChart.state.chanOptions.segment = false
  app.__chanlunChart.state.chanOptions.featureSeq = false
  app.__chanlunChart.state.chanOptions.mergedFeatureSeq = false
  app.__chanlunChart.state.chanOptions.segmentCenter = true
  app.__chanlunChart.state.chanOptions.strokeCenter = false

  const ret = app.__chanlunChart.drawChan(args)
  assert.strictEqual(ret, true)

  const fills = rects.filter((r) => r.kind === 'fill')
  assert(fills.length >= 1, '窗口 [2500,3000] 下必须绘制线段中枢（旧版漏画）')
  // 找到对应 [1894-2990] 中枢的矩形：x = 1894 - 4 = 1890, w = (2990-1894) + 8 = 1104
  const hit = fills.find((r) => Math.abs(r.x - 1890) < 0.01 && Math.abs(r.w - 1104) < 0.01)
  assert(hit, '绘制矩形必须覆盖中枢 [1894-2990] 的 x 范围，实际: ' + JSON.stringify(fills))
})

t('centerDirOf：中枢方向 = 价格进入中枢前的最后一条线段方向', () => {
  const app = loadApp()
  const segments = [
    { dir: 'up', fromRaw: 0, toRaw: 100 },
    { dir: 'down', fromRaw: 100, toRaw: 200 },
    { dir: 'up', fromRaw: 200, toRaw: 300 },
    { dir: 'down', fromRaw: 300, toRaw: 400 }
  ]
  // 中枢 [200,300]：进入前的最后一条线段是 100-200(down) → 向下中枢
  assert.strictEqual(app.__chanlunChart.centerDirOf(segments, { startRaw: 200, endRaw: 300 }), 'down')
  // 中枢 [100,200]：进入前的最后一条是 0-100(up) → 向上中枢
  assert.strictEqual(app.__chanlunChart.centerDirOf(segments, { startRaw: 100, endRaw: 200 }), 'up')
  // 无前线段（中枢在最左）：兜底用第一条覆盖中枢起点的线段方向
  assert.strictEqual(app.__chanlunChart.centerDirOf(segments, { startRaw: 0, endRaw: 100 }), 'up')
})

t('consumedFeatureSis：标记被包含合并吃掉的原始特征笔', () => {
  const app = loadApp()
  const seg = {
    features: [
      { si: 1, fromRaw: 5, toRaw: 10 },
      { si: 3, fromRaw: 15, toRaw: 20 }, // 与 si1 合并
      { si: 5, fromRaw: 25, toRaw: 30 },
      { si: 7, fromRaw: 35, toRaw: 40 }
    ],
    mergedFeatures: [
      { fromRaw: 5, toRaw: 20 }, // 覆盖 si1+si3
      { fromRaw: 25, toRaw: 30 }, // 独立
      { fromRaw: 35, toRaw: 40 } // 独立（确认元素）
    ]
  }
  const c = app.__chanlunChart.consumedFeatureSis(seg)
  assert.deepStrictEqual([...c].sort(), [3], '只有 si3 被合并吃掉')
})

t('fmtPrice：按量级自适应小数位', () => {
  const app = loadApp()
  assert.strictEqual(app.__chanlunChart.fmtPrice(43520.6), '43,520.6')
  assert.strictEqual(app.__chanlunChart.fmtPrice(0.0000342), '0.000034')
  assert.strictEqual(app.__chanlunChart.fmtPrice(12.345), '12.35')
})

t('drawChan：全图层开启（含特征序列/合并/背驰/方向中枢）不崩溃且每中枢一矩形', () => {
  const app = loadApp()
  const bars = randomWalk(3000, 123)
  app.__chanlunChart.runChanCalc(bars)
  const centers = app.__chanlunChart.chanState.segmentCenters
  assert(centers.length >= 1, '数据应产生线段中枢')

  const rects = []
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '',
    setLineDash() {},
    fillRect(...a) { rects.push({ kind: 'fill', ...a }) },
    strokeRect(...a) { rects.push({ kind: 'stroke', ...a }) },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, fill() {}, arc() {}, fillText() {}
  }
  const chart = {
    getVisibleRange: () => ({ realFrom: 0, realTo: 3000 }),
    getBarSpace: () => ({ gapBar: 8, halfGapBar: 4 })
  }
  const xAxis = { convertToPixel: (v) => v }
  const yAxis = { convertToPixel: (v) => 1000 - v }

  // 全部图层默认开（含新特性），只跑绘制
  const o = app.__chanlunChart.state.chanOptions
  o.fractal = true; o.stroke = true; o.segment = true; o.featureSeq = true; o.mergedFeatureSeq = true
  o.segmentCenter = true; o.strokeCenter = true; o.divergence = true

  const ret = app.__chanlunChart.drawChan({ ctx, chart, indicator: {}, bounding: {}, xAxis, yAxis })
  assert.strictEqual(ret, true)
  // 关闭会用 fillRect 画K线实体的图层后，每中枢恰好 1 个填充矩形（中枢本身）
  rects.length = 0
  o.mergedFeatureSeq = false
  o.featureSeq = false
  app.__chanlunChart.drawChan({ ctx, chart, indicator: {}, bounding: {}, xAxis, yAxis })
  const fills = rects.filter((r) => r.kind === 'fill')
  assert.strictEqual(
    fills.length,
    app.__chanlunChart.chanState.segmentCenters.length + app.__chanlunChart.chanState.strokeCenters.length,
    '全窗口下绘制全部中枢，且无额外矩形污染'
  )
})

t('darkStyles：红涨绿跌切换生效', () => {
  const app = loadApp()
  app.__chanlunChart.state.indOptions.chinaColors = false
  let s = app.__chanlunChart.darkStyles()
  assert.strictEqual(s.candle.bar.upColor, '#00cc00', '默认阳=绿')
  assert.strictEqual(s.indicator.bars[0].upColor, '#00cc00')
  app.__chanlunChart.state.indOptions.chinaColors = true
  s = app.__chanlunChart.darkStyles()
  assert.strictEqual(s.candle.bar.upColor, '#ef5350', '红涨绿跌阳=红')
  assert.strictEqual(s.indicator.bars[0].upColor, '#ef5350')
  app.__chanlunChart.state.indOptions.chinaColors = false
})

t('drawChan：窗口包含中枢主体时正常绘制（不回归）', () => {
  const app = loadApp()
  const bars = randomWalk(3000, 7)
  app.__chanlunChart.runChanCalc(bars)
  const centers = app.__chanlunChart.chanState.segmentCenters

  const rects = []
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 0,
    fillRect(x, y, w, h) { rects.push({ kind: 'fill', x, y, w, h }) },
    strokeRect(x, y, w, h) { rects.push({ kind: 'stroke', x, y, w, h }) },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, fill() {}, arc() {}, fillText() {}
  }
  const chart = {
    getVisibleRange: () => ({ realFrom: 0, realTo: 3000 }),
    getBarSpace: () => ({ gapBar: 8, halfGapBar: 4 })
  }
  const xAxis = { convertToPixel: (v) => v }
  const yAxis = { convertToPixel: (v) => 1000 - v }
  const o = app.__chanlunChart.state.chanOptions
  o.fractal = false; o.stroke = false; o.segment = false; o.featureSeq = false; o.mergedFeatureSeq = false
  o.segmentCenter = true; o.strokeCenter = false

  app.__chanlunChart.drawChan({ ctx, chart, indicator: {}, bounding: {}, xAxis, yAxis })
  const fills = rects.filter((r) => r.kind === 'fill')
  assert.strictEqual(fills.length, centers.length, '全窗口下绘制全部线段中枢')
})
