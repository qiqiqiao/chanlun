/*!
 * tests/browser-smoke.test.js —— 浏览器装配冒烟测试
 *
 * 项目无构建步骤：index.html 按依赖顺序加载 src/*.js（注册到 window.Chanlun）、
 * chanlun.js（装配 API → window.chanlun）、data-layer.js（→ window.dataLayer）、
 * exchange-adapters.js（→ window.exchangeAdapters）、chart-drawing.js（→ window.chartDrawing）、
 * main.js。本测试用 node:vm 模拟浏览器全局环境，验证：
 *   - 各模块在浏览器路径下正确注册与装配（无 module.exports）
 *   - 装配后的输出与 Node require 路径完全一致
 */
'use strict'
const vm = require('vm')
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { randomWalk } = require('./helpers')
const t = (name, fn) => global.__registerTest('browser: ' + name, fn)

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
  'exchange-adapters.js',
  'realtime.js',
  'chart-drawing.js'
]

function runBrowser(files) {
  const sandbox = { console }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.WebSocket = class { constructor() { throw new Error('no real WS in smoke test') } }
  vm.createContext(sandbox)
  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    vm.runInContext(code, sandbox, { filename: f })
  }
  return sandbox
}

t('src/*.js + chanlun.js 在浏览器路径装配出 window.chanlun', () => {
  const sb = runBrowser(CORE_FILES)
  assert(sb.chanlun, 'window.chanlun 存在')
  assert.strictEqual(typeof sb.chanlun.analyze, 'function')
  assert.strictEqual(typeof sb.chanlun.createAnalyzer, 'function')
  assert.strictEqual(typeof sb.chanlun.segmentScan, 'function')

  const bars = randomWalk(150, 7)
  const r = sb.chanlun.analyze(bars, { biMinGap: 4 })
  assert.strictEqual(r.dataLen, bars.length)
  assert(Array.isArray(r.strokes) && Array.isArray(r.segments) && Array.isArray(r.segmentCenters))
})

t('浏览器装配输出与 Node require 路径逐字段一致', () => {
  const sb = runBrowser(CORE_FILES)
  const c = require('../chanlun.js')
  const bars = randomWalk(220, 13)
  const cfg = { biMinGap: 4 }
  const a = JSON.parse(JSON.stringify(sb.chanlun.analyze(bars, cfg)))
  const b = JSON.parse(JSON.stringify(c.analyze(bars, cfg)))
  assert.deepStrictEqual(a, b)
  // 增量路径一致
  const inc = sb.chanlun.createAnalyzer(cfg)
  inc.update(bars.slice(0, 100))
  for (let i = 100; i < bars.length; i++) inc.update(bars.slice(i, i + 1))
  const ref = c.createAnalyzer(cfg)
  ref.update(bars)
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(inc.state)),
    JSON.parse(JSON.stringify(ref.state))
  )
})

t('data-layer.js 在浏览器路径注册 window.dataLayer', () => {
  const sb = runBrowser(['data-layer.js'])
  assert(sb.dataLayer, 'window.dataLayer 存在')
  const cache = sb.dataLayer.createKlineCache()
  cache.set('k', [{ timestamp: 2, high: 2, low: 1 }, { timestamp: 1, high: 1, low: 0 }])
  // 跨 realm 数组原型不同，用 JSON 比较避免 deepStrictEqual 的引用检查
  assert.strictEqual(JSON.stringify(cache.get('k').map((b) => b.timestamp)), '[1,2]')
})

t('realtime.js 在浏览器路径注册 window.realtime', () => {
  const sb = runBrowser(['realtime.js'])
  assert(sb.realtime, 'window.realtime 存在')
  assert.strictEqual(typeof sb.realtime.createRealtimeUpdater, 'function')
  assert.strictEqual(
    sb.realtime.barSignature({ timestamp: 1, open: 2, high: 3, low: 1, close: 2.5, volume: 9, isBarClosed: true }),
    '1|2|3|1|2.5|9|1'
  )
})

t('createMacd：CHAN_DIV 必须以 isStack=true 附加，不得删掉 MACD（klinecharts 回归）', () => {
  // 复刻 klinecharts v10 StoreImp.addIndicator 的关键行为：
  //   !isStack 时先 removeIndicator({paneId}) 再放入新指标 —— 即「不叠放就清空该 pane」。
  // 若 CHAN_DIV 创建时漏传 isStack=true，会把 MACD pane 里的 MACD 指标清掉
  // （真实故障：截图只剩孤立的「背驰面积」，MACD 消失）。
  const indicators = {}
  let seq = 0
  const log = []
  const mockChart = {
    createIndicator(value, isStack) {
      const v = typeof value === 'string' ? { name: value } : value
      const id = v.id || (v.name + '_' + (++seq))
      const paneId = v.paneId || ('pane_' + (++seq))
      if (!isStack) {
        log.push('REMOVE:' + paneId)
        delete indicators[paneId]
      }
      indicators[paneId] = indicators[paneId] || []
      indicators[paneId].push({ id, name: v.name, paneId })
      log.push('CREATE:' + v.name + '|stack=' + !!isStack + '|pane=' + paneId)
      return id
    },
    getIndicators(filter) {
      const out = []
      for (const p in indicators) {
        for (const ind of indicators[p]) {
          if (filter.id !== undefined ? ind.id === filter.id : true) {
            if (filter.name !== undefined ? ind.name === filter.name : true) {
              if (filter.paneId !== undefined ? ind.paneId === filter.paneId : true) out.push(ind)
            }
          }
        }
      }
      return out
    },
    removeIndicator(filter) {
      if (filter.id) for (const p in indicators) indicators[p] = indicators[p].filter((i) => i.id !== filter.id)
    }
  }

  const sb = runBrowser(CORE_FILES)
  const klinechartsStub = {
    init: () => ({ setStyles() {}, setSymbol() {}, setPeriod() {}, setDataLoader() {} }),
    dispose() {},
    registerIndicator() {}
  }
  sb.klinecharts = klinechartsStub
  sb.__CHANLUN_TEST__ = true
  const fakeEl = {
    addEventListener() {}, classList: { toggle() {} }, textContent: '', value: '', querySelectorAll: () => []
  }
  sb.document = {
    readyState: 'loading', addEventListener() {}, querySelector: () => fakeEl, querySelectorAll: () => [],
    createElement: () => ({ getContext: () => ({}), width: 0, height: 0, toDataURL: () => '' }), head: { appendChild() {} }
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), sb, { filename: 'main.js' })

  assert(sb.__chanlunChart, '测试钩子已暴露')
  // 直接注入 mock 图表（不再需要生产代码里的 __setChartForTest）
  sb.__chanlunChart.createMacd({ chart: mockChart })

  const macd = mockChart.getIndicators({ name: 'MACD' })
  const div = mockChart.getIndicators({ name: 'CHAN_DIV' })
  assert.strictEqual(macd.length, 1, 'MACD 必须保留，不得被 CHAN_DIV 清掉')
  assert.strictEqual(div.length, 1, 'CHAN_DIV 已创建')
  assert.strictEqual(macd[0].paneId, div[0].paneId, 'CHAN_DIV 必须与 MACD 同 pane')
  const divCreate = log.find((l) => l.startsWith('CREATE:CHAN_DIV|'))
  assert(divCreate && /stack=true/.test(divCreate), 'CHAN_DIV 必须 isStack=true，实际: ' + JSON.stringify(log))
})

t('恢复持久化指标开关：初始图表与重建视图都不得创建已关闭的 VOL/MACD', () => {
  const sb = runBrowser(CORE_FILES)
  const created = []
  const chart = {
    setStyles() {},
    setSymbol() {},
    setPeriod() {},
    setDataLoader() {},
    getDataList() { return [] },
    getIndicators() { return [] },
    removeIndicator() {},
    createIndicator(value) {
      const name = typeof value === 'string' ? value : value.name
      created.push(name)
      return name + '_id'
    }
  }
  const klinechartsStub = {
    init: () => chart,
    dispose() {},
    registerIndicator() {}
  }
  sb.klinecharts = klinechartsStub
  sb.__CHANLUN_TEST__ = true
  const fakeEl = {
    addEventListener() {}, classList: { toggle() {} }, textContent: '', value: '', querySelectorAll: () => []
  }
  sb.document = {
    readyState: 'loading',
    addEventListener() {},
    querySelector: () => fakeEl,
    querySelectorAll: () => [],
    createElement: () => ({
      getContext: () => ({
        beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, fillText() {},
        set fillStyle(v) {}, set font(v) {}, set textAlign(v) {}, set textBaseline(v) {}
      }),
      width: 0, height: 0, toDataURL: () => ''
    }),
    head: { appendChild() {} }
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), sb, { filename: 'main.js' })

  // 模拟 loadPersistedState 恢复出的关闭状态
  sb.__chanlunChart.state.indOptions.volume = false
  sb.__chanlunChart.state.indOptions.macd = false
  sb.__chanlunChart.initCharts()
  assert(!created.includes('VOL'), '恢复 volume=false 后不得创建 VOL: ' + created.join(','))
  assert(!created.includes('MACD'), '恢复 macd=false 后不得创建 MACD: ' + created.join(','))
  assert(!created.includes('CHAN_DIV'), 'MACD 关闭时不得创建 CHAN_DIV')
  assert.strictEqual(sb.__chanlunChart.mainView.indOptions.volume, false)
  assert.strictEqual(sb.__chanlunChart.mainView.indOptions.macd, false)

  // 切换交易所会走 initCharts 重建，仍应尊重关闭状态
  created.length = 0
  sb.__chanlunChart.initCharts()
  assert(!created.includes('VOL') && !created.includes('MACD'), '重建视图不得重新打开已关闭指标')

  // 重新打开只创建一次，并同步 view.indOptions
  created.length = 0
  sb.__chanlunChart.toggleIndicator('volume', true)
  sb.__chanlunChart.toggleIndicator('volume', true) // 重复开启（异常调用）不得叠出第二个 VOL
  assert.strictEqual(sb.__chanlunChart.mainView.indOptions.volume, true)
  assert.strictEqual(created.filter((n) => n === 'VOL').length, 1, 'VOL 不得重复创建: ' + created.join(','))
})

t('交易所订阅的 WebSocket 参数：OKX 心跳 / Binance 更宽静默阈值', () => {
  const sb = runBrowser(CORE_FILES)
  const calls = []
  sb.dataLayer.createReconnectingSocket = (url, handlers, opts) => {
    calls.push({ url, handlers, opts })
    return { close() {} }
  }
  const klinechartsStub = {
    init: () => ({ setStyles() {}, setSymbol() {}, setPeriod() {}, setDataLoader() {}, getDataList: () => [] }),
    dispose() {},
    registerIndicator() {}
  }
  sb.klinecharts = klinechartsStub
  sb.__CHANLUN_TEST__ = true
  const fakeEl = {
    addEventListener() {}, classList: { toggle() {} }, textContent: '', value: '', querySelectorAll: () => []
  }
  sb.document = {
    readyState: 'loading',
    addEventListener() {},
    querySelector: () => fakeEl,
    querySelectorAll: () => [],
    createElement: () => ({ getContext: () => ({}), width: 0, height: 0, toDataURL: () => '' }),
    head: { appendChild() {} }
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), sb, { filename: 'main.js' })

  sb.__chanlunChart.exchangers.okx.subscribe('BTCUSDT', { type: 'minute', span: 1 }, () => {})
  sb.__chanlunChart.exchangers.binance.subscribe('BTCUSDT', { type: 'minute', span: 1 }, () => {})
  assert.strictEqual(calls.length, 2)
  assert.strictEqual(calls[0].opts.heartbeatInterval, 25000, 'OKX 每 25s 发心跳')
  assert.strictEqual(calls[0].opts.heartbeatMessage, 'ping', 'OKX 心跳内容为 ping')
  assert.strictEqual(calls[1].opts.idleTimeoutMs, 180000, 'Binance 冷门交易对放宽到 3 分钟')
  assert.strictEqual(calls[1].opts.heartbeatInterval, undefined, 'Binance 不需要应用层心跳')
})

t('index.html 脚本清单可全部加载（除 CDN 与 main.js 的 DOM 依赖）', () => {
  // 按 index.html 的顺序加载核心脚本，确保没有依赖顺序错误
  const sb = runBrowser(CORE_FILES)
  assert(sb.chanlun && sb.dataLayer && sb.exchangeAdapters && sb.realtime && sb.chartDrawing)
  // 加载 main.js：klinecharts 需 stub；document.readyState=loading → init 延迟执行
  sandbox_main(sb)
})

function sandbox_main(sb) {
  const klinechartsStub = {
    init: () => ({ setStyles() {}, createIndicator() {}, setSymbol() {}, setPeriod() {}, setDataLoader() {} }),
    dispose() {},
    registerIndicator() {}
  }
  sb.klinecharts = klinechartsStub
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
  const code = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  vm.runInContext(code, sb, { filename: 'main.js' })
  assert(sb.document, 'main.js 加载无异常（init 已延迟，未触碰真实 DOM）')
}
