/*!
 * tests/exchange-adapters.test.js —— 交易所适配器契约测试（vm 加载 main.js，HTTP 层打桩）
 *
 * 不依赖网络：在浏览器环境模拟中加载真实 main.js，用 fetch stub 模拟交易所 HTTP，
 * 验证：
 *   - Binance/OKX 的 URL 参数、映射、错误分类（418 不重试 / 5xx 重试 / OKX code 分类）
 *   - OKX 降序响应 → 升序、limit 300 上限、before/after 分页语义
 *   - 加载器 backward/forward 与 OKX 分页模型集成：翻页 → 去重 → 左边界固定
 *   - 端到端 P0：通过 main.js 的 runChanCalc，同一对象原地改值必须刷新缠论
 */
'use strict'
const vm = require('vm')
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const c = require('../chanlun.js')
const { randomWalk } = require('./helpers')
const t = (name, fn) => global.__registerTest('exchange: ' + name, fn)

const CORE = ['src/config.js', 'src/merge.js', 'src/fractal.js', 'src/stroke.js', 'src/segment.js', 'src/center.js', 'src/analyzer.js', 'chanlun.js', 'data-layer.js', 'realtime.js', 'main.js']

// 在浏览器模拟环境加载真实 main.js（init 延迟，不触碰真实 DOM）
function loadApp(fetchImpl) {
  const sb = { console, __CHANLUN_TEST__: true, fetch: fetchImpl }
  sb.window = sb
  sb.globalThis = sb
  sb.WebSocket = class { constructor() { throw new Error('no real WS') } }
  sb.setTimeout = (fn) => { fn(); return 0 } // retry sleep 立即返回
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
  for (const f of CORE) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sb, { filename: f })
  }
  return sb
}

// fetch stub：按 URL 路由，记录调用
function routeFetch(routes) {
  const calls = []
  const fn = async (url) => {
    calls.push(String(url))
    const route = routes.find((r) => r.match.test(String(url)))
    if (!route) return { ok: false, status: 404, text: async () => 'not found' }
    const body = typeof route.body === 'function' ? route.body(String(url)) : route.body
    return { ok: route.ok !== false, status: route.status || 200, text: async () => JSON.stringify(body) }
  }
  fn.calls = calls
  return fn
}

// OKX 模拟：升序 history（原始数组 [ts,o,h,l,c,vol,...]），降序返回，limit≤300
function okxApi(history) {
  return (url) => {
    const p = new URL(url).searchParams
    const limit = Math.min(+(p.get('limit') || 300), 300)
    const before = p.get('before')
    const after = p.get('after')
    let rows = history
    if (before !== null) rows = rows.filter((r) => r[0] < +before)
    if (after !== null) rows = rows.filter((r) => r[0] > +after)
    const page = rows.slice(-limit).reverse() // OKX 返回降序（最新在前）
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: '0', msg: '', data: page }) }
  }
}

function rawBars(n, start = 1, step = 1) {
  const out = []
  for (let i = 0; i < n; i++) out.push([start + i * step, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000, 0, 0, 0])
  return out
}

// ---------------------------------------------------------------------------
// OKX
// ---------------------------------------------------------------------------
t('OKX fetchKlines：URL 参数 / limit 300 上限 / 降序→升序映射', async () => {
  const history = rawBars(400)
  const sb = loadApp(okxApi(history))
  const okx = sb.__chanlunChart.exchangers.okx
  const bars = await okx.fetchKlines('BTC-USDT', { type: 'minute', span: 1 }, { limit: 1000 }) // 超限 → 300
  assert.strictEqual(bars.length, 300)
  assert.strictEqual(bars[0].timestamp, history[100][0], '返回最新 300 根')
  assert.strictEqual(bars[299].timestamp, history[399][0])
  assert.strictEqual(bars[0].close, 100.5 + 100)
  // URL 参数
  const call = sb.__chanlunChart.state ? null : null
  const url = sb.fetch.calls[0]
  const p = new URL(url).searchParams
  assert.strictEqual(p.get('instId'), 'BTC-USDT')
  assert.strictEqual(p.get('bar'), '1m')
  assert.strictEqual(p.get('limit'), '300', 'OKX limit 上限 300')
})

t('OKX before/after 分页参数透传', async () => {
  const history = rawBars(100)
  const sb = loadApp(okxApi(history))
  const okx = sb.__chanlunChart.exchangers.okx
  await okx.fetchKlines('BTC-USDT', { type: 'day', span: 1 }, { before: 50 })
  let p = new URL(sb.fetch.calls[0]).searchParams
  assert.strictEqual(p.get('before'), '50')
  assert.strictEqual(p.get('after'), null)
  await okx.fetchKlines('BTC-USDT', { type: 'day', span: 1 }, { after: 60 })
  p = new URL(sb.fetch.calls[1]).searchParams
  assert.strictEqual(p.get('after'), '60')
})

t('OKX code !== 0：50013 可重试 / 未知 code 不重试', async () => {
  const sb = loadApp(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: '50013', msg: 'Rate limit' }) }))
  const okx = sb.__chanlunChart.exchangers.okx
  await assert.rejects(() => okx.fetchKlines('BTC-USDT', { type: 'day', span: 1 }, {}), (e) => e.name === 'ExchangeError')
  assert.strictEqual(sb.fetch.calls.length, 3, '50013 可重试 → 3 次')

  const sb2 = loadApp(() => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: '1', msg: 'bad' }) }))
  const okx2 = sb2.__chanlunChart.exchangers.okx
  await assert.rejects(() => okx2.fetchKlines('BTC-USDT', { type: 'day', span: 1 }, {}))
  assert.strictEqual(sb2.fetch.calls.length, 1, '未知 code 不重试')
})

// ---------------------------------------------------------------------------
// Binance
// ---------------------------------------------------------------------------
t('Binance fetchKlines：URL / 映射 / 418 不重试 / 5xx 重试', async () => {
  // 正常
  const okRoute = routeFetch([{ match: /api\.binance\.com/, body: [[1, 10, 11, 9, 10.5, 100, 1000, 2000, 0, 0, 0, 0]] }])
  const sb = loadApp(okRoute)
  const binance = sb.__chanlunChart.exchangers.binance
  const bars = await binance.fetchKlines('BTCUSDT', { type: 'day', span: 1 }, { limit: 1000, before: 123 })
  assert.strictEqual(bars.length, 1)
  assert.deepStrictEqual(bars[0], { timestamp: 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100 })
  const p = new URL(okRoute.calls[0]).searchParams
  assert.strictEqual(p.get('symbol'), 'BTCUSDT')
  assert.strictEqual(p.get('interval'), '1d')
  assert.strictEqual(p.get('limit'), '1000')
  assert.strictEqual(p.get('endTime'), '123', 'before → endTime')

  // 418：不重试（IP 风控）
  const r418 = routeFetch([{ match: /binance/, status: 418, ok: false, body: {} }])
  const sb418 = loadApp(r418)
  await assert.rejects(() => sb418.__chanlunChart.exchangers.binance.fetchKlines('BTCUSDT', { type: 'day', span: 1 }, {}), (e) => e.message.includes('418'))
  assert.strictEqual(r418.calls.length, 1, '418 不重试')

  // 5xx：重试 3 次
  const r5xx = routeFetch([{ match: /binance/, status: 500, ok: false, body: {} }])
  const sb5xx = loadApp(r5xx)
  await assert.rejects(() => sb5xx.__chanlunChart.exchangers.binance.fetchKlines('BTCUSDT', { type: 'day', span: 1 }, {}))
  assert.strictEqual(r5xx.calls.length, 3, '5xx 重试 3 次')
})

// ---------------------------------------------------------------------------
// 加载器 × OKX 分页模型集成（用户建议的 OKX 分页验证组）
// ---------------------------------------------------------------------------
t('OKX 分页集成：init → forward 翻历史 → backward 补新 → 去重、左边界固定', async () => {
  const history = rawBars(1000)
  const sb = loadApp(okxApi(history))
  const app = sb.__chanlunChart
  app.state.exchange = 'okx'
  const loader = app.buildDataLoader()
  const period = { type: 'day', span: 1 }
  const symbol = { ticker: 'BTC-USDT' }
  const key = 'OKX:BTC-USDT:day-1'

  // init：最新 300 根
  let r = await callLoader(loader, { type: 'init', symbol, period })
  assert.strictEqual(r.data.length, 300)
  assert.strictEqual(r.data[0].timestamp, 701, 'init 左边界 701')
  assert.deepStrictEqual(r.more, { forward: true, backward: true })
  assert.deepStrictEqual(app.klineCache.get(key).map((b) => b.timestamp), Array.from({ length: 300 }, (_, i) => 701 + i))

  // forward 翻页（更旧）：直到 1
  for (const expectedLeft of [401, 101, 1]) {
    r = await callLoader(loader, { type: 'forward', timestamp: r.data[0].timestamp, symbol, period })
    assert.strictEqual(r.data[0].timestamp, expectedLeft, 'forward 到 ' + expectedLeft)
  }
  // 再 forward → 无更多
  r = await callLoader(loader, { type: 'forward', timestamp: 1, symbol, period })
  assert.strictEqual(r.more.forward, false)
  assert.strictEqual(r.data.length, 0)

  // 缓存完整 1..1000 且升序无重复
  let cache = app.klineCache.get(key).map((b) => b.timestamp)
  assert.strictEqual(cache.length, 1000)
  assert.strictEqual(cache[0], 1)
  assert.strictEqual(cache[999], 1000)
  assert.strictEqual(new Set(cache).size, 1000, '无重复')

  // 实时出现 50 根新K → backward 补齐
  history.push(...rawBars(50, 1001))
  r = await callLoader(loader, { type: 'backward', timestamp: 1000, symbol, period })
  assert.strictEqual(r.data.length, 50)
  cache = app.klineCache.get(key).map((b) => b.timestamp)
  assert.strictEqual(cache.length, 1050)
  assert.strictEqual(cache[0], 1, '左边界保持 1（不漂移）')
  assert.strictEqual(cache[1049], 1050)
  assert.strictEqual(new Set(cache).size, 1050)
})

function callLoader(loader, args) {
  return new Promise((resolve, reject) => {
    loader.getBars({
      ...args,
      callback: (data, more) => resolve({ data, more })
    })
  })
}

// ---------------------------------------------------------------------------
// 端到端 P0：通过 main.js 的 runChanCalc
// ---------------------------------------------------------------------------
t('端到端：runChanCalc 下同一对象原地改值 → 缠论刷新（P0）', () => {
  const sb = loadApp(() => ({ ok: false, status: 500, text: async () => '' }))
  const bars = randomWalk(150, 31)
  const out1 = sb.__chanlunChart.runChanCalc(bars)
  assert.strictEqual(out1.length, bars.length)
  assert.strictEqual(out1[0].v, 0)
  const s1 = JSON.parse(JSON.stringify(sb.__chanlunChart.chanState))
  assert.deepStrictEqual(s1, JSON.parse(JSON.stringify(c.analyze(bars, { biMinGap: 4 }))))

  // klinecharts 复用同一对象原地改值（引用不变、内容变）
  const last = bars[bars.length - 1]
  last.close = last.close + 8
  last.high = last.close + 1
  sb.__chanlunChart.runChanCalc(bars)
  const s2 = JSON.parse(JSON.stringify(sb.__chanlunChart.chanState))
  const ref = JSON.parse(JSON.stringify(c.analyze(bars, { biMinGap: 4 })))
  assert.notDeepStrictEqual(s2, s1, '原地改值后缠论必须刷新')
  assert.deepStrictEqual(s2, ref, '刷新结果与全量一致')

  // 同批次再算 → 跳过（状态不变）
  sb.__chanlunChart.runChanCalc(bars)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.__chanlunChart.chanState)), ref)
})
