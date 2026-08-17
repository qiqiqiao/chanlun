/*!
 * tests/data-layer.test.js —— 可靠数据层单元测试
 *
 * 全部使用假实现（假 fetch / 假 WebSocket / 假定时器），不依赖网络。
 * 覆盖：去重排序、缓存合并与上限、重试分类与退避、WS 重连与主动关闭、加载器分页与订阅。
 */
'use strict'
const dl = require('../data-layer.js')
const assert = require('assert')
const t = (name, fn) => global.__registerTest('data-layer: ' + name, fn)

function bar(ts, close) {
  return { timestamp: ts, open: close, high: close + 1, low: close - 1, close, volume: 1 }
}

// ---------------------------------------------------------------------------
t('normalizeKlines 按时间戳去重并升序', () => {
  const list = [bar(3, 3), bar(1, 1), bar(2, 2), bar(1, 100), bar(3, 300)]
  const out = dl.normalizeKlines(list)
  assert.deepStrictEqual(out.map((b) => b.timestamp), [1, 2, 3])
  assert.strictEqual(out[0].close, 100, '重复时间戳保留后者（新取数据优先）')
  assert.strictEqual(out[2].close, 300)
})

// ---------------------------------------------------------------------------
t('缓存：merge 去重合并 + 升序', () => {
  const cache = dl.createKlineCache()
  cache.set('k', [bar(1, 1), bar(3, 3)])
  cache.merge('k', [bar(2, 2), bar(3, 300), bar(4, 4)])
  const v = cache.get('k')
  assert.deepStrictEqual(v.map((b) => b.timestamp), [1, 2, 3, 4])
  assert.strictEqual(v[2].close, 300, '3 去重保留新取数据')
  assert.strictEqual(cache.size(), 1)
})

t('缓存：单键上限保留最新', () => {
  const cache = dl.createKlineCache({ maxPerKey: 5 })
  cache.set('k', [bar(1, 1), bar(2, 2), bar(3, 3), bar(4, 4), bar(5, 5), bar(6, 6), bar(7, 7)])
  assert.deepStrictEqual(cache.get('k').map((b) => b.timestamp), [3, 4, 5, 6, 7])
})

t('缓存：键数上限 LRU 淘汰', () => {
  const cache = dl.createKlineCache({ maxKeys: 3 })
  cache.set('a', [bar(1, 1)])
  cache.set('b', [bar(1, 1)])
  cache.set('c', [bar(1, 1)])
  assert.strictEqual(cache.size(), 3)
  cache.get('a') // 触碰 a → 变为最近使用
  cache.set('d', [bar(1, 1)])
  assert.strictEqual(cache.size(), 3, '超过上限淘汰最久未用')
  assert(cache.has('a'), 'a 被触碰后不被淘汰')
  assert(!cache.has('b'), 'b 最久未用被淘汰')
})

// ---------------------------------------------------------------------------
t('重试：可重试错误按退避重试后成功', async () => {
  let attempts = 0
  const delays = []
  const retryFetch = dl.createRetryFetch({
    retries: 4,
    jitter: false,
    sleep: async (ms) => { delays.push(ms) },
    classify: (e) => ({ retryable: e.retryable !== false })
  })
  const r = await retryFetch(async () => {
    attempts++
    if (attempts < 3) throw { retryable: true, message: 'flaky' }
    return 'ok'
  })
  assert.strictEqual(r, 'ok')
  assert.strictEqual(attempts, 3)
  assert.deepStrictEqual(delays, [800, 1600], '指数退避 800 → 1600')
})

t('重试：不可重试错误立即抛出', async () => {
  const retryFetch = dl.createRetryFetch({
    retries: 3,
    classify: (e) => ({ retryable: e.retryable !== false })
  })
  let attempts = 0
  await assert.rejects(
    retryFetch(async () => { attempts++; throw { retryable: false, message: 'bad request' } }),
    (e) => e.message === 'bad request'
  )
  assert.strictEqual(attempts, 1, '不可重试不重试')
})

t('重试：次数耗尽后抛出最后错误', async () => {
  const retryFetch = dl.createRetryFetch({
    retries: 2,
    jitter: false,
    sleep: async () => {},
    classify: () => ({ retryable: true })
  })
  let attempts = 0
  await assert.rejects(retryFetch(async () => { attempts++; throw new Error('x') }))
  assert.strictEqual(attempts, 2)
})

// ---------------------------------------------------------------------------
// 假 WebSocket：可触发 onopen/onmessage/onclose
function FakeWs() {
  this.onopen = null
  this.onmessage = null
  this.onclose = null
  this.onerror = null
  this.closed = false
}
FakeWs.prototype.close = function () {
  this.closed = true
  if (this.onclose) this.onclose()
}

t('WS：断线自动重连（退避）且 close() 后不再重连', () => {
  const connects = []
  const scheduled = []
  const received = []
  const opened = []
  const ws = dl.createReconnectingSocket('wss://x', {
    onMessage: (m) => { received.push(m) },
    onOpen: (w) => { opened.push(w) }
  }, {
    connect: (url) => {
      const w = new FakeWs()
      w.url = url
      connects.push(w)
      return w
    },
    schedule: (delay, fn) => { scheduled.push({ delay, fn }); return { delay, fn } },
    clear: () => {},
    baseDelay: 1000,
    maxDelay: 5000,
    jitter: false
  })

  // 首次连接
  assert.strictEqual(connects.length, 1)
  connects[0].onopen()
  assert.strictEqual(opened.length, 1, 'onOpen 分发')
  connects[0].onclose() // 断线
  assert.strictEqual(scheduled.length, 1)
  assert.strictEqual(scheduled[0].delay, 1000, '首次重连退避 1000ms')
  scheduled[0].fn() // 执行重连
  assert.strictEqual(connects.length, 2)
  connects[1].onclose() // 再断
  assert.strictEqual(scheduled.length, 2)
  assert.strictEqual(scheduled[1].delay, 2000, '指数退避 2000ms')
  scheduled[1].fn()
  assert.strictEqual(connects.length, 3)
  // 主动关闭 → 不再重连
  ws.close()
  connects[2].onclose()
  assert.strictEqual(scheduled.length, 2, 'close 后不再调度重连')
})

t('WS：onmessage 解析 JSON 并分发', () => {
  const received = []
  let fake = null
  dl.createReconnectingSocket('wss://x', {
    onMessage: (m) => received.push(m)
  }, {
    connect: () => { fake = new FakeWs(); return fake },
    schedule: () => { return {} },
    clear: () => {}
  })
  fake.onmessage({ data: '{"a":1}' })
  fake.onmessage({ data: 'not-json' }) // 忽略解析失败
  assert.deepStrictEqual(received, [{ a: 1 }])
})

// ---------------------------------------------------------------------------
// 假交易所
function FakeExchange(klinesByOpts) {
  this.label = 'Fake'
  this.calls = []
  this.periodStr = (type, span) => type + '-' + span
  this.fetchKlines = async (symbol, period, opts) => {
    this.calls.push({ symbol, period, opts })
    const key = JSON.stringify(opts)
    return klinesByOpts[key] || []
  }
  this.subscribe = (symbol, period, cb) => {
    this.subCb = cb
    this.subArgs = { symbol, period }
    return { close: () => { this.subClosed = true } }
  }
}

function mkLoader(ex) {
  const cache = dl.createKlineCache()
  const errors = []
  const loading = []
  const dataEvts = []
  return {
    loader: dl.createKlineLoader({
      getExchange: () => ex,
      cache,
      onError: (msg) => errors.push(msg),
      onLoadingChange: (on) => loading.push(on),
      onData: () => dataEvts.push(1)
    }),
    cache,
    errors,
    loading,
    dataEvts
  }
}

t('加载器：init 无缓存 → 拉取并写缓存', async () => {
  const ex = new FakeExchange({
    '{"limit":1000}': [bar(1, 1), bar(2, 2)]
  })
  const env = mkLoader(ex)
  let cbArgs = null
  await env.loader.getBars({ type: 'init', symbol: { ticker: 'BTC' }, period: { type: 'day', span: 1 }, callback: (d, more) => { cbArgs = { d, more } } })
  assert.strictEqual(cbArgs.d.length, 2)
  assert.deepStrictEqual(cbArgs.more, { forward: true, backward: true })
  assert.strictEqual(env.cache.get('Fake:BTC:day-1').length, 2)
  assert.deepStrictEqual(env.loading, [true, false], '加载状态开合')
  assert.strictEqual(env.dataEvts.length, 1)
})

t('加载器：init 有缓存 → 只补齐更新的K线（左边界固定）', async () => {
  const ex = new FakeExchange({
    '{"limit":1000,"after":11}': [bar(12, 12), bar(13, 13)]
  })
  const env = mkLoader(ex)
  env.cache.set('Fake:BTC:day-1', [bar(10, 10), bar(11, 11)])
  let cbArgs = null
  await env.loader.getBars({ type: 'init', symbol: { ticker: 'BTC' }, period: { type: 'day', span: 1 }, callback: (d, more) => { cbArgs = { d, more } } })
  assert.deepStrictEqual(cbArgs.d.map((b) => b.timestamp), [10, 11, 12, 13], '缓存首根 10 保持，补齐 12/13')
  assert.deepStrictEqual(ex.calls[0].opts, { limit: 1000, after: 11 })
})

t('加载器：forward/backward 分页合并去重', async () => {
  const ex = new FakeExchange({
    '{"limit":1000,"before":11}': [bar(8, 8), bar(9, 9), bar(10, 10)],
    '{"limit":1000,"after":12}': [bar(13, 13), bar(14, 14), bar(10, 10)]
  })
  const env = mkLoader(ex)
  env.cache.set('Fake:BTC:day-1', [bar(10, 10), bar(11, 11), bar(12, 12)])
  let fwd = null
  await env.loader.getBars({ type: 'forward', timestamp: 11, symbol: { ticker: 'BTC' }, period: { type: 'day', span: 1 }, callback: (d, more) => { fwd = { d, more } } })
  assert.deepStrictEqual(fwd.more, { forward: true, backward: false })
  assert.deepStrictEqual(env.cache.get('Fake:BTC:day-1').map((b) => b.timestamp), [8, 9, 10, 11, 12], 'forward 合并去重升序')
  let bwd = null
  await env.loader.getBars({ type: 'backward', timestamp: 12, symbol: { ticker: 'BTC' }, period: { type: 'day', span: 1 }, callback: (d, more) => { bwd = { d, more } } })
  assert.deepStrictEqual(bwd.more, { forward: false, backward: true })
  assert.deepStrictEqual(env.cache.get('Fake:BTC:day-1').map((b) => b.timestamp), [8, 9, 10, 11, 12, 13, 14], 'backward 合并去重升序')
})

t('加载器：拉取失败 → onError + 空回调', async () => {
  const ex = new FakeExchange({})
  ex.fetchKlines = async () => { throw new Error('network down') }
  const env = mkLoader(ex)
  let got = null
  await env.loader.getBars({ type: 'init', symbol: { ticker: 'BTC' }, period: { type: 'day', span: 1 }, callback: (d) => { got = d } })
  assert.deepStrictEqual(got, [])
  assert.deepStrictEqual(env.errors, ['network down'])
})

t('加载器：订阅/解绑', () => {
  const ex = new FakeExchange({})
  const env = mkLoader(ex)
  const bars = []
  env.loader.subscribeBar({ symbol: { ticker: 'BTC' }, period: { type: 'day', span: 1 }, callback: (b) => bars.push(b) })
  ex.subCb({ timestamp: 1, close: 1 })
  assert.strictEqual(bars.length, 1)
  assert.strictEqual(env.dataEvts.length, 1, '订阅推送后触发 onData')
  env.loader.unsubscribeBar()
  assert.strictEqual(ex.subClosed, true)
})
