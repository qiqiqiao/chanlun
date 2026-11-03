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
    const onReconnect = handlers.onReconnect || null
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
    let hasOpened = false // 区分首次连接与重连（重连需要补拉断线期间的K线）
    let paused = false // 回补期间缓冲实时消息，避免较新的消息把回补的旧K线挡掉
    let pending = []

    // onOpen 里通常会发订阅消息（OKX）。socket 可能仍在 CONNECTING（例如回补期间
    // 又断线重连），send 会抛 InvalidStateError；订阅失败由后续重连自愈，这里吞掉。
    function safeOpen(socket) {
      if (!onOpen) return
      try {
        onOpen(socket)
      } catch (e) {
        /* 订阅失败：交给下一次重连重新订阅 */
      }
    }

    // 回补完成后：先重新订阅（OKX 需要在 onOpen 里发 subscribe；Binance 隐含在 URL），
    // 再按序放行缓冲消息。
    // 若回补期间又发生了新的连接（socket !== ws），本次 resume 作废——让新连接
    // 自己走回补/订阅，避免对陈旧或尚未 OPEN 的 socket 发消息。
    function resume(socket) {
      if (closed || socket !== ws) return
      safeOpen(socket)
      const msgs = pending
      pending = []
      paused = false
      for (let i = 0; i < msgs.length; i++) onMessage(msgs[i])
    }

    function connect() {
      if (closed) return
      const sock = connectImpl(url)
      ws = sock
      sock.onopen = () => {
        retries = 0
        if (!hasOpened) {
          hasOpened = true
          safeOpen(sock)
          return
        }
        // 重连：暂停消息 → REST 回补 → 恢复并重新订阅
        paused = true
        pending = []
        if (!onReconnect) {
          resume(sock)
          return
        }
        Promise.resolve()
          .then(() => onReconnect(sock))
          .then(() => resume(sock), () => resume(sock))
      }
      sock.onerror = () => { /* 统一交给 onclose 处理重连 */ }
      sock.onmessage = (ev) => {
        if (sock !== ws) return // 已被新连接取代，丢弃旧 socket 的消息
        let m
        try {
          m = JSON.parse(ev.data)
        } catch (e) {
          return
        }
        if (paused) { pending.push(m); return }
        onMessage(m)
      }
      sock.onclose = () => {
        if (closed || sock !== ws) return
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
        paused = false
        pending = []
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

  // 缓存补齐的最大轮次（每轮最多拉取 limit 根）。缓存单键本身有上限，
  // 超过此轮次仍未追平（异常交易所/超长缺口）则丢弃缓存重载最新。
  const MAX_CATCHUP_ROUNDS = 100

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
    let subSeq = 0 // 订阅代际：切换品种/周期后使进行中的回补失效
    let lastBarTs = null // 图表已知的末根时间戳（订阅回调 + 初始化缓存）

    function cacheKey(ex, ticker, period) {
      return ex.label + ':' + ticker + ':' + ex.periodStr(period.type, period.span)
    }

    function noteBarTs(ts) {
      if (typeof ts === 'number' && (lastBarTs === null || ts > lastBarTs)) lastBarTs = ts
    }

    // 重连回补：从最新K线往回翻页，收集 >= sinceTs 的K线，返回升序数组。
    // 不依赖交易所“向前分页”的方向语义（OKX 的 before 返回最新一段而非紧邻一段），
    // 而是统一用“最新一页 + before 向前翻”直到覆盖 sinceTs，两家都适用。
    async function fetchSince(ex, ticker, period, sinceTs, beforeOf) {
      const byTs = new Map()
      let chunk = await ex.fetchKlines(ticker, period, { limit: 1000 })
      for (let round = 0; chunk.length && round < MAX_CATCHUP_ROUNDS; round++) {
        const oldest = chunk[0].timestamp
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i].timestamp >= sinceTs) byTs.set(chunk[i].timestamp, chunk[i])
        }
        if (oldest <= sinceTs) break
        const older = await ex.fetchKlines(ticker, period, { limit: 1000, before: beforeOf(oldest) })
        if (!older.length || older[0].timestamp >= oldest) break // 无进展
        chunk = older
      }
      return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp)
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
          // 分页边界由交易所适配器换算（各家包含/排除语义不同，见 beforeParam/afterParam；
          // 缺省保持 Binance 口径：老向取整、新向 +1ms）
          const beforeOf = ex.beforeParam || ((ts) => ts)
          const afterOf = ex.afterParam || ((ts) => ts + 1)
          if (type === 'init') {
            const cached = cache.get(key)
            if (cached && cached.length) {
              // 复用缓存：左边界保持在上次起点，循环补齐更晚的K线直到追平。
              // 用 afterOf(lastTs - 1) 重新包含末根：首次缓存时末根可能尚未收盘，
              // 只拉 lastTs 之后会永久漏掉它的终值；merge 按时间戳覆盖旧值。
              let lastTs = cached[cached.length - 1].timestamp
              let caughtUp = false
              for (let round = 0; round < MAX_CATCHUP_ROUNDS; round++) {
                if (seq !== loadSeq) { caughtUp = true; break } // 已被更新的请求取代，停止补拉
                const newer = await ex.fetchKlines(ticker, period, { limit: 1000, after: afterOf(lastTs - 1) })
                if (!newer.length) { caughtUp = true; break }
                // 返回的首根仍晚于 lastTs：交易所一次给的是“最新一段”而非紧邻缓存的
                // 一段（中间有缺口），丢弃缓存重载最新，避免图表出现时间断层。
                if (newer[0].timestamp > lastTs) {
                  const fresh = await ex.fetchKlines(ticker, period, { limit: 1000 })
                  cache.set(key, fresh)
                  caughtUp = true
                  break
                }
                cache.merge(key, newer)
                const newLastTs = newer[newer.length - 1].timestamp
                if (newLastTs <= lastTs) { caughtUp = true; break } // 无进展（已追平）
                lastTs = newLastTs
              }
              if (!caughtUp) {
                // 轮次耗尽仍未追平（异常/超长缺口）：丢弃缓存重载最新
                const fresh = await ex.fetchKlines(ticker, period, { limit: 1000 })
                cache.set(key, fresh)
              }
              data = cache.get(key)
            } else {
              const fresh = await ex.fetchKlines(ticker, period, { limit: 1000 })
              cache.set(key, fresh)
              data = cache.get(key)
            }
            more = { forward: true, backward: true }
          } else if (type === 'forward') {
            data = await ex.fetchKlines(ticker, period, { limit: 1000, before: beforeOf(timestamp) })
            if (data.length) cache.merge(key, data)
            more = { forward: data.length > 0, backward: false }
          } else if (type === 'backward') {
            data = await ex.fetchKlines(ticker, period, { limit: 1000, after: afterOf(timestamp) })
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
        const key = cacheKey(ex, ticker, period)
        const gen = ++subSeq
        const beforeOf = ex.beforeParam || ((ts) => ts)
        // 以缓存末根作为重连回补锚点（init 后缓存与图表末尾一致）
        const cached = cache.get(key)
        lastBarTs = cached && cached.length ? cached[cached.length - 1].timestamp : null

        // WS 重连后补拉断线期间的K线：逐根喂给图表回调（klinecharts update 语义为
        // timestamp > 末根则追加、== 末根则替换），含末根以刷新其终值。
        const onReconnect = async () => {
          if (gen !== subSeq) return
          const since = lastBarTs
          if (since === null) return
          const bars = await fetchSince(ex, ticker, period, since, beforeOf)
          if (gen !== subSeq) return
          if (!bars.length) return
          cache.merge(key, bars)
          for (let i = 0; i < bars.length; i++) {
            callback(bars[i])
            noteBarTs(bars[i].timestamp)
          }
          onData()
        }

        activeWs = ex.subscribe(ticker, period, (bar) => {
          callback(bar)
          noteBarTs(bar && bar.timestamp)
          onData()
        }, { onReconnect })
      },

      unsubscribeBar: () => {
        subSeq++ // 使进行中的回补失效
        lastBarTs = null
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
