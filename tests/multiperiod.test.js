/*!
 * tests/multiperiod.test.js —— 多周期联动
 *
 * 覆盖：
 *   - 周期层级映射 getHigherPeriod（1h→4h、4h→1d、1w→null）
 *   - 主图/副图各自独立的 klinecharts 实例、缠论状态（indicator.id 反查视图）
 *   - 联动开启：副图自动跟随主图更高一级周期
 *   - 联动关闭：副图保持独立周期
 *   - 副图点击 → 主图 scrollToTimestamp（从大周期看全局，点大周期K线看小周期细节）
 *   - 副图默认只显示核心高级别信号（SUB_CHAN_OPTIONS）
 */
'use strict'
const vm = require('vm')
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { randomWalk } = require('./helpers')
const t = (name, fn) => global.__registerTest('multiperiod: ' + name, fn)

const CORE_FILES = [
  'src/config.js',
  'src/merge.js',
  'src/fractal.js',
  'src/stroke.js',
  'src/segment.js',
  'src/center.js',
  'src/divergence.js',
  'src/analyzer.js',
  'chanlun.js',
  'data-layer.js',
  'realtime.js'
]

// 记录型 mock klinecharts：捕获 createIndicator/setPeriod/scrollToTimestamp/点击订阅
function loadMultiApp() {
  const noop = () => {}
  const fakeCtx = {
    beginPath: noop, moveTo: noop, arcTo: noop, closePath: noop, fill: noop,
    fillText: noop, setLineDash: noop, fillRect: noop, strokeRect: noop, lineTo: noop,
    stroke: noop, arc: noop
  }
  const sb = { console, __CHANLUN_TEST__: true, fetch: async () => ({ ok: false, status: 500, text: async () => '' }) }
  sb.window = sb
  sb.globalThis = sb
  sb.WebSocket = class { constructor() { throw new Error('no real WS in test') } }
  sb.setTimeout = (fn) => { fn(); return 0 }
  sb.clearTimeout = () => {}
  const fakeEl = {
    addEventListener() {}, classList: { toggle() {} }, textContent: '', value: '',
    querySelectorAll: () => [], options: [], appendChild() {}, disabled: false
  }
  sb.document = {
    readyState: 'loading',
    addEventListener() {},
    querySelector: () => fakeEl,
    querySelectorAll: () => [],
    createElement: () => ({ getContext: () => fakeCtx, width: 0, height: 0, toDataURL: () => '', appendChild() {} }),
    head: { appendChild() {} }
  }
  vm.createContext(sb)
  for (const f of CORE_FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sb, { filename: f })

  const charts = {}
  const periodCalls = []
  const scrollCalls = []
  const clickCbs = []
  sb.klinecharts = {
    init(id) {
      const c = {
        name: id,
        calls: { create: [] },
        createIndicator(v, isStack) {
          const val = typeof v === 'string' ? v : v.name
          this.calls.create.push([val, v && v.calcParams ? v.calcParams : null, !!isStack])
          return id + '_ind_' + this.calls.create.length
        },
        getIndicators() { return [{ id: 'x', paneId: 'pane_' + id }] },
        removeIndicator() {}, overrideIndicator() {},
        setStyles() {}, setSymbol() {},
        setPeriod(p) { periodCalls.push(id + ':' + (p.label || p.type + p.span)) },
        setDataLoader() {},
        subscribeAction(type, cb) { if (type === 'onCandleBarClick') clickCbs.push(cb) },
        scrollToTimestamp(ts, anim) { scrollCalls.push([id, ts, anim]) },
        getDataList() { return [{ timestamp: 100, close: 1 }, { timestamp: 200, close: 2 }] },
        getVisibleRange() { return { realFrom: 0, realTo: 1 } },
        getBarSpace() { return { gapBar: 8, halfGapBar: 4 } }
      }
      charts[id] = c
      return c
    },
    dispose() {},
    registerIndicator() {}
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), sb, { filename: 'main.js' })
  return { sb, charts, periodCalls, scrollCalls, clickCbs }
}

t('getHigherPeriod：1h→4h、4h→1d、1d→1w、1w→null', () => {
  const { sb } = loadMultiApp()
  const g = sb.__chanlunChart.getHigherPeriod
  assert.strictEqual(sb.__chanlunChart.labelOf(g({ type: 'hour', span: 1 })), '4h')
  assert.strictEqual(sb.__chanlunChart.labelOf(g({ type: 'hour', span: 4 })), '1d')
  assert.strictEqual(sb.__chanlunChart.labelOf(g({ type: 'day', span: 1 })), '1w')
  assert.strictEqual(g({ type: 'week', span: 1 }), null, '1w 已到顶')
})

t('initCharts：主图 1h → 副图自动 4h；副图默认核心信号', () => {
  const { sb } = loadMultiApp()
  sb.__chanlunChart.state.period = { type: 'hour', span: 1 }
  sb.__chanlunChart.initCharts()
  const main = sb.__chanlunChart.mainView
  const sub = sb.__chanlunChart.subView
  assert(main && sub, '主副图均已创建')
  assert.strictEqual(sb.__chanlunChart.labelOf(main.period), '1h')
  assert.strictEqual(sb.__chanlunChart.labelOf(sub.period), '4h', '副图跟随更高一级周期')
  // 副图默认只显示高级别核心信号
  assert.strictEqual(sub.chanOptions.fractal, false)
  assert.strictEqual(sub.chanOptions.segmentCenter, true)
  assert.strictEqual(sub.chanOptions.divergence, true)
  assert.strictEqual(sub.chanOptions.featureSeq, false)
  assert.strictEqual(main.chanOptions.fractal, true, '主图保持完整开关')
})

t('数据隔离：indicator.id 反查视图，主副图 chanState 互不影响', () => {
  const { sb } = loadMultiApp()
  sb.__chanlunChart.state.period = { type: 'hour', span: 1 }
  sb.__chanlunChart.initCharts()
  const main = sb.__chanlunChart.mainView
  const sub = sb.__chanlunChart.subView
  sb.__chanlunChart.runChanCalc(randomWalk(120, 1), { id: 'chart_ind_1' })
  sb.__chanlunChart.runChanCalc(randomWalk(200, 2), { id: 'subChart_ind_1' })
  assert.strictEqual(main.chanState.dataLen, 120)
  assert.strictEqual(sub.chanState.dataLen, 200)
  assert.strictEqual(sb.__chanlunChart.chanState.dataLen, 120, 'chanState 取主图')
  // 无 indicator 时回退主图
  sb.__chanlunChart.runChanCalc(randomWalk(90, 3))
  assert.strictEqual(main.chanState.dataLen, 90)
  assert.strictEqual(sub.chanState.dataLen, 200, '副图不受影响')
})

t('联动：主图周期变化 → 副图自动跟随更高一级周期', () => {
  const { sb } = loadMultiApp()
  sb.__chanlunChart.state.period = { type: 'hour', span: 1 }
  sb.__chanlunChart.initCharts()
  const sub = sb.__chanlunChart.subView
  assert.strictEqual(sb.__chanlunChart.labelOf(sub.period), '4h')
  sb.__chanlunChart.state.period = { type: 'hour', span: 4 }
  sb.__chanlunChart.syncSubPeriod()
  assert.strictEqual(sb.__chanlunChart.labelOf(sub.period), '1d')
  sb.__chanlunChart.state.period = { type: 'day', span: 1 }
  sb.__chanlunChart.syncSubPeriod()
  assert.strictEqual(sb.__chanlunChart.labelOf(sub.period), '1w')
})

t('联动关闭：副图可独立选周期，主图变化不再影响', () => {
  const { sb } = loadMultiApp()
  sb.__chanlunChart.state.period = { type: 'hour', span: 1 }
  sb.__chanlunChart.initCharts()
  const sub = sb.__chanlunChart.subView
  sb.__chanlunChart.state.linkage.enabled = false
  sb.__chanlunChart.setSubPeriod({ type: 'day', span: 1 })
  assert.strictEqual(sb.__chanlunChart.labelOf(sub.period), '1d')
  sb.__chanlunChart.state.period = { type: 'hour', span: 1 }
  sb.__chanlunChart.syncSubPeriod()
  assert.strictEqual(sb.__chanlunChart.labelOf(sub.period), '1d', '关闭联动后主图变化不影响副图')
  // 重新开启联动 → 跟随
  sb.__chanlunChart.state.linkage.enabled = true
  sb.__chanlunChart.syncSubPeriod()
  assert.strictEqual(sb.__chanlunChart.labelOf(sub.period), '4h')
})

t('副图点击 K 线 → 主图 scrollToTimestamp（看小周期细节）', () => {
  const { sb, scrollCalls, clickCbs } = loadMultiApp()
  sb.__chanlunChart.state.period = { type: 'hour', span: 1 }
  sb.__chanlunChart.initCharts()
  assert.strictEqual(clickCbs.length, 1, '副图订阅了 K 线点击')
  clickCbs[0]({ kLineData: { timestamp: 999 } })
  assert.deepStrictEqual(scrollCalls, [['chart', 999, 500]], '主图滚动到点击的高级别K线时间')
})

t('视觉联动：副图 drawChan 画主图可见范围高亮，主图画高级别边界（不崩溃）', () => {
  const { sb, charts } = loadMultiApp()
  sb.__chanlunChart.state.period = { type: 'hour', span: 1 }
  sb.__chanlunChart.initCharts()
  sb.__chanlunChart.runChanCalc(randomWalk(120, 5), { id: 'chart_ind_1' })
  sb.__chanlunChart.runChanCalc(randomWalk(200, 6), { id: 'subChart_ind_1' })
  const mkCtx = (record) => ({
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '',
    setLineDash() {}, fillRect() { record.fill++ }, strokeRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() { record.stroke++ }, closePath() {},
    fill() { record.fill++ }, arc() {}, fillText() {}
  })
  const args = (id) => ({
    ctx: mkCtx({ fill: 0, stroke: 0 }),
    chart: charts[id],
    indicator: { id: id + '_ind_1' },
    bounding: { top: 0, bottom: 100, left: 0, right: 400 },
    xAxis: { convertToPixel: (v) => v, convertTimestampToPixel: (ts) => ts },
    yAxis: { convertToPixel: (v) => 100 - v }
  })
  assert.strictEqual(sb.__chanlunChart.drawChan(args('chart')), true)
  assert.strictEqual(sb.__chanlunChart.drawChan(args('subChart')), true)
})

t('BOLL：主图创建布林带（20,2），副图不叠加', () => {
  const { sb, charts } = loadMultiApp()
  sb.__chanlunChart.state.period = { type: 'hour', span: 1 }
  sb.__chanlunChart.initCharts()
  const mainCalls = charts['chart'].calls.create.map((c) => c[0])
  const subCalls = charts['subChart'].calls.create.map((c) => c[0])
  assert(mainCalls.includes('BOLL'), '主图创建 BOLL')
  assert(!subCalls.includes('BOLL'), '副图不叠加布林带，避免信息过载')
  const boll = charts['chart'].calls.create.find((c) => c[0] === 'BOLL')
  assert.deepStrictEqual(boll[1], [20, 2], 'BOLL 参数：20 周期 2 倍标准差')
  assert.strictEqual(boll[2], false, 'BOLL 是独立 pane 的常规指标，无需 isStack=true（不像 CHAN 叠在主K线上）')
})

t('BOLL 开关：toggleIndicator 可增删', () => {
  const { sb, charts } = loadMultiApp()
  sb.__chanlunChart.state.period = { type: 'hour', span: 1 }
  sb.__chanlunChart.initCharts()
  const chart = charts['chart']
  const bollId = sb.__chanlunChart.mainView.bollId
  assert(bollId, '开启时持有 bollId')
  sb.__chanlunChart.toggleIndicator('boll', false)
  assert.strictEqual(sb.__chanlunChart.mainView.bollId, null, '关闭后清除 bollId')
  sb.__chanlunChart.toggleIndicator('boll', true)
  assert(sb.__chanlunChart.mainView.bollId, '重新开启后生成新 BOLL')
  const bolls = chart.calls.create.filter((c) => c[0] === 'BOLL')
  assert.strictEqual(bolls.length, 2, '共创建过两次 BOLL（初始 + 重新开启）')
})
