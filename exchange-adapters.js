/*!
 * exchange-adapters.js —— Binance / OKX REST 与 WebSocket 适配器
 *
 * 通过 create(dataLayer) 注入可靠数据层，避免交易所协议细节与页面集成耦合。
 */
(function (global) {
  'use strict'

  function create(dataLayer) {
    class ExchangeError extends Error {
      constructor(message, options = {}) {
        super(message)
        this.name = 'ExchangeError'
        this.status = options.status || 0
        this.retryable = options.retryable !== false
      }
    }

    const retryFetch = dataLayer.createRetryFetch({
      retries: 3,
      classify: (e) => (e instanceof ExchangeError ? { retryable: e.retryable } : { retryable: true })
    })
    const FETCH_TIMEOUT_MS = 15000

    async function fetchJsonOnce(url, timeoutMs) {
      const ctrl = typeof global.AbortController !== 'undefined' ? new global.AbortController() : null
      const timer = ctrl ? global.setTimeout(() => ctrl.abort(), timeoutMs) : null
      let res
      try {
        try {
          res = ctrl ? await global.fetch(url, { signal: ctrl.signal }) : await global.fetch(url)
        } catch (e) {
          const aborted = (e && e.name === 'AbortError') || (ctrl && ctrl.signal.aborted)
          throw new ExchangeError(
            aborted ? '请求超时（' + Math.round(timeoutMs / 1000) + 's）' : '网络错误：' + (e && e.message),
            { retryable: true }
          )
        }
      } finally {
        if (timer) global.clearTimeout(timer)
      }
      if (res.ok) {
        let text
        try {
          text = await res.text()
        } catch (e) {
          throw new ExchangeError('读取响应失败', { retryable: true })
        }
        try {
          return JSON.parse(text)
        } catch (e) {
          throw new ExchangeError('响应解析失败', { retryable: true })
        }
      }
      const status = res.status
      if (status === 429) throw new ExchangeError('交易所限流 HTTP 429', { status, retryable: true })
      // HTTP 418 通常表示 IP 被风控，重试无意义且可能加重封禁。
      if (status === 418) throw new ExchangeError('IP 被交易所风控 HTTP 418', { status, retryable: false })
      if (status >= 500) throw new ExchangeError('交易所服务错误 HTTP ' + status, { status, retryable: true })
      throw new ExchangeError('请求失败 HTTP ' + status, { status, retryable: false })
    }

    async function fetchJson(url, opts) {
      const timeoutMs = (opts && opts.timeout) || FETCH_TIMEOUT_MS
      return retryFetch(() => fetchJsonOnce(url, timeoutMs))
    }

    const createReconnectingSocket = (url, onMessage, onOpen, onReconnect, extra) =>
      dataLayer.createReconnectingSocket(url, { onMessage, onOpen, onReconnect }, extra)

    const exchangers = {
      binance: {
        label: 'Binance',
        normalize(sym) { return String(sym).toUpperCase().replace(/[-_\s]/g, '') },
        periodStr(type, span) {
          if (type === 'minute') return span + 'm'
          if (type === 'hour') return span + 'h'
          if (type === 'day') return '1d'
          if (type === 'week') return '1w'
          return '1d'
        },
        beforeParam: (timestamp) => timestamp,
        afterParam: (timestamp) => timestamp + 1,
        async fetchKlines(symbol, period, opts = {}) {
          const p = new global.URLSearchParams({
            symbol: this.normalize(symbol),
            interval: this.periodStr(period.type, period.span),
            limit: String(opts.limit || 1000)
          })
          if (opts.before) p.set('endTime', opts.before)
          if (opts.after) p.set('startTime', opts.after)
          const arr = await fetchJson('https://api.binance.com/api/v3/klines?' + p.toString())
          if (!Array.isArray(arr)) throw new ExchangeError('Binance 响应格式异常', { retryable: true })
          return arr.map((k) => ({ timestamp: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }))
        },
        subscribe(symbol, period, cb, opts) {
          const stream = this.normalize(symbol).toLowerCase() + '@kline_' + this.periodStr(period.type, period.span)
          return createReconnectingSocket(
            'wss://stream.binance.com:9443/ws/' + stream,
            (m) => {
              const k = m && m.k
              if (k) cb({ timestamp: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, isBarClosed: !!k.x })
            },
            undefined,
            opts && opts.onReconnect,
            // 低成交量交易对可能数分钟没有推送，不应过早判断为半开连接。
            { idleTimeoutMs: 180000 }
          )
        }
      },
      okx: {
        label: 'OKX',
        normalize(sym) {
          const t = String(sym).toUpperCase().replace(/[-_\s]/g, '')
          const m = t.match(/^(.+?)(USDT|USDC|BTC|ETH)$/)
          return m ? m[1] + '-' + m[2] : t
        },
        periodStr(type, span) {
          if (type === 'minute') return span + 'm'
          if (type === 'hour') return span + 'H'
          if (type === 'day') return '1D'
          if (type === 'week') return '1W'
          return '1D'
        },
        periodWss(type, span) { return 'candle' + this.periodStr(type, span) },
        // OKX 游标方向反向：HTTP after 返回更老，before 返回更新的数据。
        beforeParam: (timestamp) => timestamp,
        afterParam: (timestamp) => timestamp,
        async fetchKlines(symbol, period, opts = {}) {
          const p = new global.URLSearchParams({
            instId: this.normalize(symbol),
            bar: this.periodStr(period.type, period.span),
            limit: String(Math.min(opts.limit || 300, 300))
          })
          if (opts.before) p.set('after', opts.before)
          if (opts.after) p.set('before', opts.after)
          const url = 'https://www.okx.com/api/v5/market/candles?' + p.toString()
          const json = await retryFetch(async () => {
            const j = await fetchJsonOnce(url, FETCH_TIMEOUT_MS)
            if (j.code !== '0') {
              const retryable = ['50013', '50014', '50028', '50111', '50114', '51001'].includes(String(j.code))
              throw new ExchangeError('OKX ' + (j.msg || j.code), { status: Number(j.code) || 0, retryable })
            }
            return j
          })
          return (json.data || []).slice().reverse().map((k) => ({
            timestamp: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
          }))
        },
        subscribe(symbol, period, cb, opts) {
          const instId = this.normalize(symbol)
          return createReconnectingSocket(
            'wss://ws.okx.com:8443/ws/v5/public',
            (m) => {
              if (!m || m.event === 'error' || m.event === 'subscribe') return
              const data = m.data
              if (Array.isArray(data) && Array.isArray(data[0])) {
                const c = data[0]
                cb({ timestamp: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5], isBarClosed: String(c[8]) === '1' })
              }
            },
            (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: this.periodWss(period.type, period.span), instId }] })),
            opts && opts.onReconnect,
            { heartbeatInterval: 25000, heartbeatMessage: 'ping' }
          )
        }
      }
    }

    return { ExchangeError, exchangers, fetchJson }
  }

  const api = { create }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else global.exchangeAdapters = api
})(typeof window !== 'undefined' ? window : globalThis)
