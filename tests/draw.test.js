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

const CORE = ['src/config.js', 'src/merge.js', 'src/fractal.js', 'src/stroke.js', 'src/segment.js', 'src/center.js', 'src/analyzer.js', 'chanlun.js', 'data-layer.js', 'realtime.js', 'main.js']

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
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, fill() {}
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
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, fill() {}
  }
  const chart = {
    getVisibleRange: () => ({ realFrom: 0, realTo: 3000 }),
    getBarSpace: () => ({ gapBar: 8, halfGapBar: 4 })
  }
  const xAxis = { convertToPixel: (v) => v }
  const yAxis = { convertToPixel: (v) => 1000 - v }
  const o = app.__chanlunChart.state.chanOptions
  o.fractal = false; o.stroke = false; o.segment = false; o.segmentCenter = true; o.strokeCenter = false

  app.__chanlunChart.drawChan({ ctx, chart, indicator: {}, bounding: {}, xAxis, yAxis })
  const fills = rects.filter((r) => r.kind === 'fill')
  assert.strictEqual(fills.length, centers.length, '全窗口下绘制全部线段中枢')
})
