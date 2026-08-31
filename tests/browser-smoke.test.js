/*!
 * tests/browser-smoke.test.js —— 浏览器装配冒烟测试
 *
 * 项目无构建步骤：index.html 按依赖顺序加载 src/*.js（注册到 window.Chanlun）、
 * chanlun.js（装配 API → window.chanlun）、data-layer.js（→ window.dataLayer）、
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
  'realtime.js'
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
  sb.__chanlunChart.__setChartForTest(mockChart)
  sb.__chanlunChart.createMacd()

  const macd = mockChart.getIndicators({ name: 'MACD' })
  const div = mockChart.getIndicators({ name: 'CHAN_DIV' })
  assert.strictEqual(macd.length, 1, 'MACD 必须保留，不得被 CHAN_DIV 清掉')
  assert.strictEqual(div.length, 1, 'CHAN_DIV 已创建')
  assert.strictEqual(macd[0].paneId, div[0].paneId, 'CHAN_DIV 必须与 MACD 同 pane')
  const divCreate = log.find((l) => l.startsWith('CREATE:CHAN_DIV|'))
  assert(divCreate && /stack=true/.test(divCreate), 'CHAN_DIV 必须 isStack=true，实际: ' + JSON.stringify(log))
})

t('index.html 脚本清单可全部加载（除 CDN 与 main.js 的 DOM 依赖）', () => {
  // 按 index.html 的顺序加载核心脚本，确保没有依赖顺序错误
  const sb = runBrowser(CORE_FILES)
  assert(sb.chanlun && sb.dataLayer && sb.realtime)
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
