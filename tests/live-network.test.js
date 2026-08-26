/*!
 * tests/live-network.test.js —— 真实网络链路压力测试（默认跳过）
 *
 * 启用：LIVE_NETWORK=1 node tests/run.js tests/live-network.test.js
 *
 * 流程（真实 Binance/OKX 公共接口）：
 *   1. REST 拉取 1000 根K线 → 初始化 Analyzer；
 *   2. 订阅真实 WebSocket 行情，把每条推送合入本地 dataList（与 klinecharts
 *      相同：同时间戳原地改末根对象 / 新时间戳追加）；
 *   3. 每个 tick 经 realtime updater 更新后，断言状态与全量 analyze 逐字段一致；
 *   4. 覆盖「当前K跳动 → 收盘 → 新K」自然循环（P0 修复在真实行情下的验证）。
 *
 * 说明：真实行情时序不确定，测试对事件数量与耗时设上限（超时判失败），
 * 属于可重复运行但非确定性的冒烟/压测，故默认不随单元测试执行。
 */
'use strict'
const vm = require('vm')
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const c = require('../chanlun.js')
const realtime = require('../realtime.js')
const t = (name, fn) => global.__registerTest('live: ' + name, fn)

const ENABLED = process.env.LIVE_NETWORK === '1'
const CORE = ['src/config.js', 'src/merge.js', 'src/fractal.js', 'src/stroke.js', 'src/segment.js', 'src/center.js', 'src/divergence.js', 'src/analyzer.js', 'chanlun.js', 'data-layer.js', 'realtime.js', 'main.js']

function loadApp() {
  const sb = { console, __CHANLUN_TEST__: true, fetch, WebSocket, setTimeout, clearTimeout }
  sb.window = sb
  sb.globalThis = sb
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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时 ' + ms + 'ms')), ms))
  ])
}

// 驱动实时链路：把行情推送合入 dataList（同时间戳原地改末根 / 新时间戳追加）
function driveLive(app, ex, symbol, period, { maxEvents, maxMs }) {
  return new Promise(async (resolve, reject) => {
    const updater = realtime.createRealtimeUpdater({
      createAnalyzer: (cfg) => c.createAnalyzer(cfg),
      config: { biMinGap: 4 }
    })
    let dataList = []
    let events = 0
    let replaceLastCount = 0
    let appendCount = 0
    const fail = (msg) => { try { sock && sock.close() } catch (e) {} reject(new Error(msg)) }

    // 1. REST 初始化
    let bars
    try {
      bars = await ex.fetchKlines(symbol, period, { limit: 1000 })
    } catch (e) {
      return fail('REST 拉取失败: ' + e.message)
    }
    if (!bars || bars.length < 500) return fail('K线不足 500: ' + (bars && bars.length))
    dataList = bars
    let r = updater.update(dataList)
    if (r.action !== 'init') return fail('init 失败: ' + r.action)
    try {
      assert.deepStrictEqual(r.state, c.analyze(dataList, { biMinGap: 4 }), 'init 与全量不一致')
    } catch (e) { return fail(e.message) }

    // 2. WS 订阅
    let sock = null
    const timer = setTimeout(() => fail('行情事件不足 ' + maxEvents + '（已收 ' + events + '）'), maxMs)
    const done = (okMsg) => {
      clearTimeout(timer)
      try { sock && sock.close() } catch (e) {}
      resolve(okMsg)
    }
    try {
      sock = ex.subscribe(symbol, period, (bar) => {
        try {
          const last = dataList[dataList.length - 1]
          if (last && bar.timestamp === last.timestamp) {
            // 与 klinecharts 相同：复用同一对象原地改值（P0 场景）
            last.open = bar.open
            last.high = bar.high
            last.low = bar.low
            last.close = bar.close
            last.volume = bar.volume
            last.isBarClosed = !!bar.isBarClosed
          } else if (!last || bar.timestamp > last.timestamp) {
            dataList.push({ ...bar })
            appendCount++
          } else {
            return // 过期/乱序推送，忽略
          }
          const rr = updater.update(dataList)
          if (rr.action === 'replaceLast') replaceLastCount++
          events++
          // 每个 tick 与全量重算逐字段一致（真实行情下 P0 修复的可靠性证明）
          assert.deepStrictEqual(rr.state, c.analyze(dataList, { biMinGap: 4 }), 'tick ' + events + ' 与全量不一致')
          if (events >= maxEvents) done('完成 ' + events + ' 个行情 tick（replaceLast ' + replaceLastCount + ' / append ' + appendCount + '）')
        } catch (e) {
          fail('tick 校验失败: ' + e.message)
        }
      })
    } catch (e) {
      return fail('WS 订阅失败: ' + e.message)
    }
  })
}

if (!ENABLED) {
  t('跳过：真实网络压测需 LIVE_NETWORK=1（默认不联网）', () => {
    console.log('  （跳过 live-network：设置 LIVE_NETWORK=1 启用真实 Binance/OKX 链路压测）')
  })
} else {
  t('Binance：REST 1000K + WS 连续更新（跳动/收盘/新K）与全量一致', async () => {
    const app = loadApp()
    const msg = await withTimeout(
      driveLive(app, app.__chanlunChart.exchangers.binance, 'BTCUSDT', { type: 'minute', span: 1 }, { maxEvents: 15, maxMs: 45000 }),
      60000,
      'Binance live'
    )
    console.log('  ' + msg)
  }, 90000)

  t('OKX：REST 300K + WS 连续更新（跳动/收盘/新K）与全量一致', async () => {
    const app = loadApp()
    const msg = await withTimeout(
      driveLive(app, app.__chanlunChart.exchangers.okx, 'BTC-USDT', { type: 'minute', span: 1 }, { maxEvents: 10, maxMs: 45000 }),
      60000,
      'OKX live'
    )
    console.log('  ' + msg)
  }, 90000)
}
