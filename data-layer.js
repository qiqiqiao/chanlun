/*!
 * data-layer.js —— 可靠数据层（纯 JS，无依赖）
 *
 * 职责与可靠性保证：
 *   - normalizeKlines()           按时间戳去重 + 升序，防止分页/缓存拼接出现重复或乱序K线
 *   - createKlineCache()          按(交易所,品种,周期)键控缓存：去重合并、单键上限、
 *                                 键数上限（LRU 淘汰）
 *   - createRetryFetch()          指数退避 + 随机抖动重试；错误可分类（可重试/不可重试）
 *   - createReconnectingSocket()  WebSocket 自动重连（指数退避 + 抖动）；
 *                                 close() 为主动关闭（订阅端解绑），不再重连
 *   - createKlineLoader()         klinecharts v10 setDataLoader 适配：
 *                                 init/forward/backward 分页 + 实时订阅，统一走缓存
 *
 * 可注入性：重试的 sleep、重连的 connect/schedule、加载器的 getExchange/回调
 * 全部可注入，便于在 Node 中用假实现做单元测试（见 tests/data-layer.test.js）。
 */
(function (global) {
  'use strict'

  // 按时间戳去重并升序排序（重复/乱序防护）
  function normalizeKlines(list) {
    const map = new Map()
    for (const k of list) {
      if (k && typeof k.timestamp === 'number') map.set(k.timestamp, k)
    }
    return [...map.values()].sort((a, b) => a.timestamp - b.timestamp)
  }

  // K线缓存：maxPerKey 单键上限（保留最新），maxKeys 键数上限（LRU 淘汰）
  function createKlineCache(opts) {
    opts = opts || {}
    const maxPerKey = opts.maxPerKey || 5000
    const maxKeys = opts.maxKeys || 12
    const map = new Map()

    function touch(key) {
      if (map.has(key)) {
        const v = map.get(key)
        map.delete(key)
        map.set(key, v)
      }
    }
    function evict() {
      while (map.size > maxKeys) map.delete(map.keys().next().value)
    }
    function put(key, list) {
      map.set(key, normalizeKlines(list).slice(-maxPerKey))
      evict()
    }

    return {
      get(key) {
        touch(key)
        const v = map.get(key)
        return v ? v.slice() : null
      },
      has(key) { return map.has(key) },
      set(key, list) { put(key, list) },
      merge(key, list) {
        const cur = map.get(key) || []
        put(key, cur.concat(list))
      },
      remove(key) { map.delete(key) },
      clear() { map.clear() },
      size() { return map.size },
      keys() { return [...map.keys()] },
      stats() {
        let bars = 0
        for (const v of map.values()) bars += v.length
        return { keys: map.size, bars }
      }
    }
  }

  // 重试抓取：指数退避 + 随机抖动；classify 决定错误是否可重试
  function createRetryFetch(opts) {
    opts = opts || {}
    const retries = opts.retries || 3
    const baseDelay = opts.baseDelay || 800
    const maxDelay = opts.maxDelay || 8000
    const jitter = opts.jitter !== false
    const sleepImpl = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
    const classify = opts.classify || ((e) => ({ retryable: true }))

    return async function retryFetch(fn, hooks) {
      hooks = hooks || {}
      let lastErr = null
      for (let i = 0; i < retries; i++) {
        try {
          return await fn()
        } catch (e) {
          lastErr = e
          if (!classify(e).retryable) throw e
          if (i >= retries - 1) break
          let delay = Math.min(baseDelay * 2 ** i, maxDelay)
          if (jitter) delay *= 0.8 + Math.random() * 0.4
          if (hooks.onRetry) hooks.onRetry(i + 1, delay, e)
          await sleepImpl(delay)
        }
      }
      throw lastErr
    }
  }

  // WebSocket 自动重连：指数退避 + 抖动；close() 主动关闭后不再重连
  function createReconnectingSocket(url, handlers, opts) {
    handlers = handlers || {}
    opts = opts || {}
    const onMessage = handlers.onMessage || (() => {})
    const onOpen = handlers.onOpen || null
    const connectImpl = opts.connect || ((u) => new WebSocket(u))
    const schedule = opts.schedule || ((delay, fn) => setTimeout(fn, delay))
    const clear = opts.clear || ((timer) => clearTimeout(timer))
    const baseDelay = opts.baseDelay || 1000
    const maxDelay = opts.maxDelay || 15000
    const jitter = opts.jitter !== false

    let ws = null
    let closed = false
    let retries = 0
    let timer = null

    function connect() {
      if (closed) return
      ws = connectImpl(url)
      ws.onopen = () => {
        retries = 0
        if (onOpen) onOpen(ws)
      }
      ws.onerror = () => { /* 统一交给 onclose 处理重连 */ }
      ws.onmessage = (ev) => {
        let m
        try {
          m = JSON.parse(ev.data)
        } catch (e) {
          return
        }
        onMessage(m)
      }
      ws.onclose = () => {
        if (closed) return
        let delay = Math.min(baseDelay * 2 ** retries, maxDelay)
        if (jitter) delay *= 0.8 + Math.random() * 0.4
        retries++
        timer = schedule(delay, connect)
      }
    }

    connect()

    return {
      close() {
        closed = true
        if (timer) clear(timer)
        if (ws) {
          try { ws.close() } catch (e) { /* noop */ }
        }
        ws = null
      },
      get state() {
        return { closed, retries, connected: !!(ws && !closed) }
      }
    }
  }

  // klinecharts v10 setDataLoader 适配
  // deps: { getExchange, cache, onError, onLoadingChange, onData }
  function createKlineLoader(deps) {
    const getExchange = deps.getExchange || (() => null)
    const cache = deps.cache || createKlineCache()
    const onError = deps.onError || (() => {})
    const onLoadingChange = deps.onLoadingChange || (() => {})
    const onData = deps.onData || (() => {})

    let loadSeq = 0
    let activeWs = null

    function cacheKey(ex, ticker, period) {
      return ex.label + ':' + ticker + ':' + ex.periodStr(period.type, period.span)
    }

    return {
      getBars: async ({ type, timestamp, symbol, period, callback }) => {
        const ex = getExchange()
        if (!ex) {
          callback([])
          return
        }
        const ticker = (symbol && symbol.ticker) || ''
        const key = cacheKey(ex, ticker, period)
        const seq = ++loadSeq
        onLoadingChange(true)
        try {
          let data = []
          let more
          if (type === 'init') {
            const cached = cache.get(key)
            if (cached && cached.length) {
              // 复用缓存：左边界保持在上次起点，只补齐更晚出现的K线
              const lastTs = cached[cached.length - 1].timestamp
              const newer = await ex.fetchKlines(ticker, period, { limit: 1000, after: lastTs + 1 })
              if (newer.length) cache.merge(key, newer)
              data = cache.get(key)
            } else {
              const fresh = await ex.fetchKlines(ticker, period, { limit: 1000 })
              cache.set(key, fresh)
              data = cache.get(key)
            }
            more = { forward: true, backward: true }
          } else if (type === 'forward') {
            data = await ex.fetchKlines(ticker, period, { limit: 1000, before: timestamp })
            if (data.length) cache.merge(key, data)
            more = { forward: data.length > 0, backward: false }
          } else if (type === 'backward') {
            data = await ex.fetchKlines(ticker, period, { limit: 1000, after: timestamp + 1 })
            if (data.length) cache.merge(key, data)
            more = { forward: false, backward: data.length > 0 }
          } else {
            more = undefined
          }
          if (seq !== loadSeq) return
          callback(data, more)
          onData()
        } catch (e) {
          if (seq !== loadSeq) return
          onError(e && e.message ? e.message : String(e))
          callback([])
        } finally {
          if (seq === loadSeq) onLoadingChange(false)
        }
      },

      subscribeBar: ({ symbol, period, callback }) => {
        const ex = getExchange()
        if (!ex || !ex.subscribe) return
        const ticker = (symbol && symbol.ticker) || ''
        // 同一时刻只保留一个订阅：先解绑旧订阅
        if (activeWs) {
          try { activeWs.close() } catch (e) { /* noop */ }
          activeWs = null
        }
        activeWs = ex.subscribe(ticker, period, (bar) => {
          callback(bar)
          onData()
        })
      },

      unsubscribeBar: () => {
        if (activeWs) {
          try { activeWs.close() } catch (e) { /* noop */ }
          activeWs = null
        }
      }
    }
  }

  const api = {
    normalizeKlines,
    createKlineCache,
    createRetryFetch,
    createReconnectingSocket,
    createKlineLoader
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    global.dataLayer = api
  }
})(typeof window !== 'undefined' ? window : globalThis)
