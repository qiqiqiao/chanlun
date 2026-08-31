/*!
 * main.js —— 缠论图表：KLineChart v10 集成 + 加密货币数据 + 缠论绘制
 */
(function () {
  'use strict'

  const $ = (sel) => document.querySelector(sel)

  const state = {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    period: { type: 'day', span: 1 },
    chanOptions: {
      fractal: true,
      stroke: true,
      segment: true,
      featureSeq: true,
      segmentCenter: true,
      strokeCenter: false,
      divergence: true
    },
    indOptions: {
      volume: true,
      macd: true
    }
  }

  let volId = null
  let macdId = null

  const PERIODS = [
    { label: '1m', type: 'minute', span: 1 },
    { label: '5m', type: 'minute', span: 5 },
    { label: '15m', type: 'minute', span: 15 },
    { label: '30m', type: 'minute', span: 30 },
    { label: '1h', type: 'hour', span: 1 },
    { label: '4h', type: 'hour', span: 4 },
    { label: '1d', type: 'day', span: 1 },
    { label: '1w', type: 'week', span: 1 }
  ]

  const QUICK_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT']

  const COLORS = {
    fractalTop: '#ff5b6a',
    fractalBottom: '#3fd67f',
    strokeUp: '#ffa940',
    strokeDown: '#40c4ff',
    segment: '#ff4d8f',
    // 特征序列（线段内特征方向笔的虚拟K线，未做包含合并）：up=青 / down=粉
    featureUp: 'rgba(0, 229, 255, 0.9)',
    featureDown: 'rgba(255, 107, 178, 0.9)',
    segmentCenter: 'rgba(88, 101, 242, 0.22)',
    segmentCenterBorder: '#5865f2',
    strokeCenter: 'rgba(180, 100, 230, 0.20)',
    strokeCenterBorder: '#b464e6',
    // 背驰标记：强背驰高亮（顶=红 / 底=绿），弱背驰半透明提示
    divergenceTopStrong: '#ff2d55',
    divergenceTopWeak: 'rgba(255, 93, 122, 0.6)',
    divergenceBottomStrong: '#00e676',
    divergenceBottomWeak: 'rgba(63, 214, 127, 0.55)'
  }

  let chart = null
  let chanState = null
  let faviconSymbol = null

  // ---------------------------------------------------------------------------
  // 交易所数据层（可靠性机制在 data-layer.js：缓存/重试/重连/加载器）
  // ---------------------------------------------------------------------------

  // 交易所 API 错误：区分可重试（限流/5xx/网络）与不可重试（400/参数错误）
  class ExchangeError extends Error {
    constructor(message, options = {}) {
      super(message)
      this.name = 'ExchangeError'
      this.status = options.status || 0
      this.retryable = options.retryable !== false
    }
  }

  // 指数退避 + 随机抖动重试（分类由 ExchangeError.retryable 决定）
  const retryFetch = window.dataLayer.createRetryFetch({
    retries: 3,
    classify: (e) => (e instanceof ExchangeError ? { retryable: e.retryable } : { retryable: true })
  })

  // 拉取并解析 JSON，统一分类 HTTP 错误
  async function fetchJson(url) {
    return retryFetch(async () => {
      let res
      try {
        res = await fetch(url)
      } catch (e) {
        throw new ExchangeError('网络错误：' + e.message, { retryable: true })
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
      if (status === 429) {
        throw new ExchangeError('交易所限流 HTTP 429', { status, retryable: true })
      }
      // HTTP 418 通常表示 IP 已被封禁/风控，重试无意义甚至加重封禁 → 不重试
      if (status === 418) {
        throw new ExchangeError('IP 被交易所风控 HTTP 418', { status, retryable: false })
      }
      if (status >= 500) {
        throw new ExchangeError('交易所服务错误 HTTP ' + status, { status, retryable: true })
      }
      throw new ExchangeError('请求失败 HTTP ' + status, { status, retryable: false })
    })
  }

  // WebSocket 自动重连由 data-layer.js 提供（指数退避 + 抖动；close 后不再重连）
  const createReconnectingSocket = (url, onMessage, onOpen) =>
    window.dataLayer.createReconnectingSocket(url, { onMessage, onOpen })

  const exchangers = {
    binance: {
      label: 'Binance',
      normalize(sym) {
        return String(sym).toUpperCase().replace(/[-_\s]/g, '')
      },
      periodStr(type, span) {
        if (type === 'minute') return span + 'm'
        if (type === 'hour') return span + 'h'
        if (type === 'day') return '1d'
        if (type === 'week') return '1w'
        return '1d'
      },
      async fetchKlines(symbol, period, opts = {}) {
        const p = new URLSearchParams({
          symbol: this.normalize(symbol),
          interval: this.periodStr(period.type, period.span),
          limit: String(opts.limit || 1000)
        })
        if (opts.before) p.set('endTime', opts.before)
        if (opts.after) p.set('startTime', opts.after)
        const url = 'https://api.binance.com/api/v3/klines?' + p.toString()
        const arr = await fetchJson(url)
        if (!Array.isArray(arr)) throw new ExchangeError('Binance 响应格式异常', { retryable: true })
        return arr.map((k) => ({ timestamp: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }))
      },
      subscribe(symbol, period, cb) {
        const stream = this.normalize(symbol).toLowerCase() + '@kline_' + this.periodStr(period.type, period.span)
        return createReconnectingSocket('wss://stream.binance.com:9443/ws/' + stream, (m) => {
          const k = m && m.k
          if (k) {
            cb({
              timestamp: k.t,
              open: +k.o,
              high: +k.h,
              low: +k.l,
              close: +k.c,
              volume: +k.v,
              isBarClosed: !!k.x
            })
          }
        })
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
      periodWss(type, span) {
        return 'candle' + this.periodStr(type, span)
      },
      async fetchKlines(symbol, period, opts = {}) {
        const p = new URLSearchParams({
          instId: this.normalize(symbol),
          bar: this.periodStr(period.type, period.span),
          limit: String(Math.min(opts.limit || 300, 300))
        })
        if (opts.before) p.set('before', opts.before)
        if (opts.after) p.set('after', opts.after)
        const url = 'https://www.okx.com/api/v5/market/candles?' + p.toString()
        const json = await fetchJson(url)
        if (json.code !== '0') {
          const retryable = ['50013', '50014', '50028', '50111', '50114', '51001'].includes(String(json.code))
          throw new ExchangeError('OKX ' + (json.msg || json.code), { status: Number(json.code) || 0, retryable })
        }
        const arr = (json.data || []).slice().reverse()
        return arr.map((k) => ({ timestamp: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }))
      },
      subscribe(symbol, period, cb) {
        const instId = this.normalize(symbol)
        return createReconnectingSocket(
          'wss://ws.okx.com:8443/ws/v5/public',
          (m) => {
            if (!m || m.event === 'error' || m.event === 'subscribe') return
            const data = m.data
            if (Array.isArray(data) && Array.isArray(data[0])) {
              const c = data[0]
              cb({
                timestamp: +c[0],
                open: +c[1],
                high: +c[2],
                low: +c[3],
                close: +c[4],
                volume: +c[5],
                isBarClosed: false
              })
            }
          },
          (ws) => {
            ws.send(
              JSON.stringify({
                op: 'subscribe',
                args: [{ channel: this.periodWss(period.type, period.span), instId }]
              })
            )
          }
        )
      }
    }
  }

  function currentExchange() {
    return exchangers[state.exchange] || exchangers.binance
  }

  // ---------------------------------------------------------------------------
  // 缠论计算与绘制
  // ---------------------------------------------------------------------------
  // 实时更新策略在 realtime.js：用【内容签名】判断末根变化（对象原地改值也能识别），
  // 而不是对象引用。klinecharts 可能复用同一 bar 对象并原地修改 OHLC，
  // 引用判断会漏判 → 缠论不刷新（P0 已修复）。
  const chanUpdater = window.realtime.createRealtimeUpdater({
    createAnalyzer: (cfg) => window.chanlun.createAnalyzer(cfg),
    config: { biMinGap: 4 }
  })

  function runChanCalc(dataList) {
    const n = dataList.length
    if (!n) {
      updateStatus()
      return dataList
    }
    const r = chanUpdater.update(dataList)
    chanState = r.state
    updateStatus()
    return dataList.map(() => ({ v: 0 }))
  }

  function updateStatus() {
    const el = $('#status')
    if (!el) return
    if (!chanState) {
      el.textContent = ''
      return
    }
    const finished = chanState.segments.filter((s) => s.finished).length
    const divs = chanState.divergences || []
    const strongDivs = divs.filter((d) => d.confirmed).length
    el.textContent =
      state.symbol +
      ' · ' + currentExchange().label +
      ' | 分型 ' + chanState.fractals.length +
      ' · 笔 ' + chanState.strokes.length +
      ' · 线段 ' + finished + '+' + (chanState.segments.length - finished) +
      ' · 线段中枢 ' + chanState.segmentCenters.length +
      ' · 笔中枢 ' + chanState.strokeCenters.length +
      ' · 背驰 ' + strongDivs + '/' + divs.length
  }

  function drawCenterRect(ctx, x, y, w, h, fill, border) {
    ctx.fillStyle = fill
    ctx.strokeStyle = border
    ctx.lineWidth = 1
    ctx.fillRect(x, y, w, Math.max(0, h))
    ctx.strokeRect(x, y, w, Math.max(0, h))
  }

  // 二分查找：首个 getKey(element) >= v 的下标（数组按 getKey 单调递增）
  function lowerBound(arr, getKey, v) {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (getKey(arr[mid]) < v) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  // 可见窗口 [from, to] 内应绘制的元素：起点 <= to 且终点 >= from。
  // 关键：二分按起点定位会漏掉「起点 < from 但终点 >= from」的元素
  // （横跨窗口左边界）。线段中枢通常只有 1~2 个，一旦横跨左边界就整体
  // 消失（笔中枢遍布全数据所以不明显）。修复：二分定位后前补一个元素。
  // 前提：起点单调递增、元素不重叠（中枢不重叠；笔/线段首尾相连），
  // 因此最多只有一个元素横跨左边界。
  function visibleInRange(arr, startKey, endKey, from, to) {
    let i = lowerBound(arr, startKey, from)
    if (i > 0 && endKey(arr[i - 1]) >= from) i--
    const result = []
    for (; i < arr.length && startKey(arr[i]) <= to; i++) {
      const el = arr[i]
      if (endKey(el) < from) continue
      result.push(el)
    }
    return result
  }

  function drawChan({ ctx, chart, indicator, bounding, xAxis, yAxis }) {
    if (!chanState) return true
    const opts = state.chanOptions
    const range = chart.getVisibleRange()
    const { gapBar, halfGapBar } = chart.getBarSpace()
    const from = Math.max(0, Math.floor(range.realFrom))
    const to = Math.min(chanState.dataLen - 1, Math.ceil(range.realTo))
    const X = (rawIndex) => xAxis.convertToPixel(rawIndex)
    const Y = (value) => yAxis.convertToPixel(value)

    // 1. 中枢（垫底）
    if (opts.segmentCenter) {
      for (const cc of visibleInRange(chanState.segmentCenters, (z) => z.startRaw, (z) => z.endRaw, from, to)) {
        const x = X(cc.startRaw) - halfGapBar
        const w = X(cc.endRaw) - X(cc.startRaw) + gapBar
        drawCenterRect(ctx, x, Y(cc.zsHigh), w, Y(cc.zsLow) - Y(cc.zsHigh), COLORS.segmentCenter, COLORS.segmentCenterBorder)
      }
    }
    if (opts.strokeCenter) {
      for (const cc of visibleInRange(chanState.strokeCenters, (z) => z.startRaw, (z) => z.endRaw, from, to)) {
        const x = X(cc.startRaw) - halfGapBar
        const w = X(cc.endRaw) - X(cc.startRaw) + gapBar
        drawCenterRect(ctx, x, Y(cc.zsHigh), w, Y(cc.zsLow) - Y(cc.zsHigh), COLORS.strokeCenter, COLORS.strokeCenterBorder)
      }
    }

    // 2. 线段
    if (opts.segment) {
      ctx.lineWidth = 2
      ctx.strokeStyle = COLORS.segment
      for (const seg of visibleInRange(chanState.segments, (s) => s.fromRaw, (s) => s.toRaw, from, to)) {
        ctx.beginPath()
        ctx.moveTo(X(seg.fromRaw), Y(seg.dir === 'up' ? seg.from.low : seg.from.high))
        ctx.lineTo(X(seg.toRaw), Y(seg.dir === 'up' ? seg.to.high : seg.to.low))
        ctx.stroke()
      }
    }

    // 3. 特征序列（线段特征方向的虚拟K线，raw 原始笔，不做包含合并）
    if (opts.featureSeq) {
      ctx.lineWidth = 1
      const tickW = Math.max(2, Math.min(4, gapBar * 0.3))
      for (const seg of visibleInRange(chanState.segments, (s) => s.fromRaw, (s) => s.toRaw, from, to)) {
        const feats = seg.features
        if (!feats || !feats.length) continue
        for (let i = 0; i < feats.length; i++) {
          const f = feats[i]
          if (f.toRaw < from || f.fromRaw > to) continue
          const x = X((f.fromRaw + f.toRaw) / 2)
          ctx.strokeStyle = f.dir === 'up' ? COLORS.featureUp : COLORS.featureDown
          ctx.beginPath()
          ctx.moveTo(x, Y(f.high))
          ctx.lineTo(x, Y(f.low))
          ctx.stroke()
          // 开盘/收盘小横线（虚拟K线影线端）
          ctx.beginPath()
          ctx.moveTo(x - tickW, Y(f.fromValue))
          ctx.lineTo(x + tickW, Y(f.fromValue))
          ctx.stroke()
          ctx.beginPath()
          ctx.moveTo(x - tickW, Y(f.toValue))
          ctx.lineTo(x + tickW, Y(f.toValue))
          ctx.stroke()
        }
      }
    }

    // 4. 笔
    if (opts.stroke) {
      ctx.lineWidth = 1.4
      for (const s of visibleInRange(chanState.strokes, (st) => st.fromRaw, (st) => st.toRaw, from, to)) {
        ctx.strokeStyle = s.dir === 'up' ? COLORS.strokeUp : COLORS.strokeDown
        ctx.beginPath()
        ctx.moveTo(X(s.fromRaw), Y(s.fromValue))
        ctx.lineTo(X(s.toRaw), Y(s.toValue))
        ctx.stroke()
      }
    }

    // 5. 分型
    if (opts.fractal) {
      const marker = Math.max(3.5, Math.min(7, gapBar * 0.3))
      ctx.lineWidth = 1
      for (const f of visibleInRange(chanState.fractals, (f) => f.rawMiddle, (f) => f.rawMiddle, from, to)) {
        const x = X(f.rawMiddle)
        if (f.type === 'top') {
          const y = Y(f.high) + 3
          ctx.fillStyle = COLORS.fractalTop
          ctx.beginPath()
          ctx.moveTo(x, y - marker)
          ctx.lineTo(x - marker, y)
          ctx.lineTo(x + marker, y)
          ctx.closePath()
          ctx.fill()
        } else {
          const y = Y(f.low) - 3
          ctx.fillStyle = COLORS.fractalBottom
          ctx.beginPath()
          ctx.moveTo(x, y + marker)
          ctx.lineTo(x - marker, y)
          ctx.lineTo(x + marker, y)
          ctx.closePath()
          ctx.fill()
        }
      }
    }

    // 6. 笔背驰标记（结合大级别线段动量：强背驰高亮 + 圆环，弱背驰半透明文字）
    if (opts.divergence && chanState.divergences) {
      ctx.font = 'bold 10px system-ui, -apple-system, "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.lineWidth = 1
      for (const d of visibleInRange(chanState.divergences, (d) => d.rawIndex, (d) => d.rawIndex, from, to)) {
        const strong = d.strength === 'strong'
        ctx.fillStyle = strong
          ? (d.kind === 'top' ? COLORS.divergenceTopStrong : COLORS.divergenceBottomStrong)
          : (d.kind === 'top' ? COLORS.divergenceTopWeak : COLORS.divergenceBottomWeak)
        const x = X(d.rawIndex)
        const yPrice = Y(d.value)
        const label = d.kind === 'top' ? '顶背驰' : '底背驰'
        const labelY = d.kind === 'top' ? yPrice - 16 : yPrice + 18
        ctx.fillText(label, x, labelY)
        if (strong) {
          ctx.strokeStyle = ctx.fillStyle
          ctx.beginPath()
          ctx.arc(x, yPrice, 5, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
    }

    return true
  }

  // ---------------------------------------------------------------------------
  // 暗色主题
  // ---------------------------------------------------------------------------
  function darkStyles() {
    // 柔和纯绿：K线阳线 / VOL / MACD 柱统一（纯绿色相 #00cc00，亮度 80%，避免 #00ff00 刺眼）
    const GREEN = '#00cc00'
    return {
      grid: {
        horizontal: { show: true, color: 'rgba(255,255,255,0.06)', size: 1 },
        vertical: { show: true, color: 'rgba(255,255,255,0.06)', size: 1 }
      },
      candle: {
        bar: {
          upColor: GREEN,
          downColor: '#ef5350',
          noChangeColor: '#8a8a8a',
          upBorderColor: GREEN,
          downBorderColor: '#ef5350',
          noChangeBorderColor: '#8a8a8a',
          upWickColor: GREEN,
          downWickColor: '#ef5350',
          noChangeWickColor: '#8a8a8a'
        },
        priceMark: {
          high: { show: true, color: 'rgba(255,255,255,0.4)', textOffset: 5, textSize: 10 },
          low: { show: true, color: 'rgba(255,255,255,0.4)', textOffset: 5, textSize: 10 },
          last: {
            show: true,
            upColor: GREEN,
            downColor: '#ef5350',
            noChangeColor: '#8a8a8a',
            line: { show: true, color: 'rgba(255,255,255,0.25)', style: 'dashed', size: 1, dashValue: [3, 3] }
          }
        }
      },
      // VOL / MACD 柱子颜色（klinecharts 读取 styles.indicator.bars[0].upColor/downColor）
      indicator: {
        bars: [{ upColor: GREEN }]
      },
      xAxis: {
        axisLine: { color: 'rgba(255,255,255,0.15)', size: 1 },
        tickLine: { color: 'rgba(255,255,255,0.15)', size: 1, length: 4 },
        tickText: { color: 'rgba(255,255,255,0.55)', size: 11 }
      },
      yAxis: {
        axisLine: { color: 'rgba(255,255,255,0.15)', size: 1 },
        tickLine: { color: 'rgba(255,255,255,0.15)', size: 1, length: 4 },
        tickText: { color: 'rgba(255,255,255,0.55)', size: 11 }
      },
      separator: { color: 'rgba(255,255,255,0.1)', size: 1 },
      crosshair: {
        horizontal: {
          line: { show: true, color: 'rgba(255,255,255,0.35)', style: 'dashed', size: 1, dashValue: [3, 3] }
        },
        vertical: {
          line: { show: true, color: 'rgba(255,255,255,0.35)', style: 'dashed', size: 1, dashValue: [3, 3] }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 标签页信息：标题显示「币种 + 最新价」，图标随币种变化
  // ---------------------------------------------------------------------------
  const COIN_STYLES = {
    BTC: '#f7931a',
    ETH: '#627eea',
    SOL: '#9945ff',
    BNB: '#f3ba2f',
    XRP: '#23a9f2',
    DOGE: '#c2a633',
    ADA: '#0d5cc9',
    DOT: '#e6007a',
    LTC: '#345d9d',
    LINK: '#2a5ada',
    TRX: '#eb0029',
    AVAX: '#e84142',
    USDT: '#26a17b',
    USDC: '#2775ca',
    BUSD: '#f0b90b',
    EUR: '#003399',
    USD: '#26a69a'
  }

  const QUOTE_CURRENCIES = [
    'USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USDP', 'USDD', 'AEUR',
    'USD', 'BTC', 'ETH', 'TRY', 'EUR', 'DAI', 'CNY'
  ]

  function coinOf(symbol) {
    let s = String(symbol || '').toUpperCase().replace(/-/g, '')
    for (const q of QUOTE_CURRENCIES) {
      if (s.length > q.length && s.endsWith(q)) {
        s = s.slice(0, -q.length)
        break
      }
    }
    return s || 'COIN'
  }

  function setFavicon(symbol) {
    // 实时行情每次回调都会刷新标题；币种不变时 favicon 也不变，避免重复创建
    // canvas、编码 data URL 并触发浏览器图标更新。
    if (faviconSymbol === symbol) return
    faviconSymbol = symbol
    const coin = coinOf(symbol)
    const color = COIN_STYLES[coin] || '#5865f2'
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    // 圆角方块背景
    const r = 14
    const w = canvas.width
    ctx.beginPath()
    ctx.moveTo(r, 0)
    ctx.arcTo(w, 0, w, w, r)
    ctx.arcTo(w, w, 0, w, r)
    ctx.arcTo(0, w, 0, 0, r)
    ctx.arcTo(0, 0, w, 0, r)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    // 币种缩写（过长则压缩字号）
    const label = coin.length > 4 ? coin.slice(0, 4) : coin
    const fontSize = label.length >= 4 ? 20 : label.length >= 3 ? 24 : 30
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold ' + fontSize + 'px system-ui, -apple-system, "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, 32, 34)
    let link = document.querySelector('link[rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = canvas.toDataURL('image/png')
  }

  function updateTabTitle(symbol, price) {
    let fmt = ''
    if (typeof price === 'number' && isFinite(price)) {
      const decimals = price < 0.01 ? 6 : price < 1 ? 4 : 2
      fmt = price.toLocaleString('zh-CN', { maximumFractionDigits: decimals, minimumFractionDigits: 0 })
    }
    document.title = fmt
      ? symbol + ' ' + fmt + ' · 缠论图表'
      : symbol + ' · 缠论图表'
  }

  // 从图表最后一根K线读取最新价并刷新标题
  function refreshTabInfo() {
    let price = null
    if (chart) {
      const dataList = chart.getDataList()
      if (dataList && dataList.length) price = dataList[dataList.length - 1].close
    }
    setFavicon(state.symbol)
    updateTabTitle(state.symbol, price)
  }

  // ---------------------------------------------------------------------------
  // 图表初始化
  // ---------------------------------------------------------------------------

  // 每个(交易所, 品种, 周期)的K线缓存（data-layer.js 实现：去重合并/单键上限/键数上限）。
  // 关键：切换周期时不再“重新取最新的1000根”，而是复用已加载的历史并只补齐更新的K线，
  // 使缠论分析的左边界（首根K线）固定不变。否则滑动窗口每次变化都会让
  // “笔→线段→中枢”这条从起点连成串的链条整体重算，导致切回原周期后中枢位置漂移。
  const klineCache = window.dataLayer.createKlineCache({ maxPerKey: 5000, maxKeys: 12 })

  // 图表切换后，旧序列的首根时间戳和 OHLC 在极少数情况下可能与新序列碰巧相同。
  // 显式重置可避免实时更新器复用上一标的/周期的分析状态，也避免新数据到达前绘制旧结构。
  function resetChanCalc() {
    chanUpdater.reset()
    chanState = null
    updateStatus()
  }

  // klinecharts v10 数据加载器（data-layer.js 实现：init/forward/backward 分页 + 实时订阅）
  function buildDataLoader() {
    return window.dataLayer.createKlineLoader({
      getExchange: currentExchange,
      cache: klineCache,
      onError: (msg) => {
        console.error('数据加载失败：' + msg)
        showToast('数据加载失败：' + msg)
      },
      onLoadingChange: setLoading,
      onData: refreshTabInfo
    })
  }

  function initChart() {
    resetChanCalc()
    if (chart) {
      klinecharts.dispose('chart')
    }
    chart = klinecharts.init('chart')
    window.__chart = chart
    chart.setStyles(darkStyles())
    chart.createIndicator({ name: 'CHAN', paneId: 'candle_pane' }, true)
    applyIndicators()
    chart.setSymbol({ ticker: state.symbol })
    chart.setPeriod(state.period)
    chart.setDataLoader(buildDataLoader())
  }

  function applyIndicators() {
    if (!chart) return
    if (state.indOptions.volume) {
      volId = chart.createIndicator({ name: 'VOL' })
    }
    if (state.indOptions.macd) {
      macdId = chart.createIndicator({ name: 'MACD', calcParams: [12, 26, 9] })
    }
  }

  function toggleIndicator(key, on) {
    state.indOptions[key] = on
    if (!chart) return
    if (on) {
      if (key === 'volume') volId = chart.createIndicator({ name: 'VOL' })
      else if (key === 'macd') macdId = chart.createIndicator({ name: 'MACD', calcParams: [12, 26, 9] })
    } else {
      if (key === 'volume') {
        chart.removeIndicator({ id: volId })
        volId = null
      } else if (key === 'macd') {
        chart.removeIndicator({ id: macdId })
        macdId = null
      }
    }
  }

  function refreshChart() {
    if (!chart) return
    resetChanCalc()
    chart.setSymbol({ ticker: state.symbol })
    chart.setPeriod(state.period)
    refreshTabInfo()
  }

  // ---------------------------------------------------------------------------
  // UI 交互
  // ---------------------------------------------------------------------------
  function setLoading(on) {
    const el = $('#loading')
    if (el) el.classList.toggle('hidden', !on)
  }

  let toastTimer = null
  function showToast(msg) {
    const el = $('#toast')
    if (!el) return
    el.textContent = msg
    el.classList.remove('hidden')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3500)
  }

  function setActiveState() {
    const period = PERIODS.find((p) => p.type === state.period.type && p.span === state.period.span)
    const periodLabel = period ? period.label : ''
    $('#quick-symbols').querySelectorAll('.chip').forEach((b) => {
      b.classList.toggle('active', b.dataset.symbol === state.symbol)
    })
    $('#periods').querySelectorAll('.chip').forEach((b) => {
      b.classList.toggle('active', b.dataset.period === periodLabel)
    })
  }

  function toggleChanOption(key, on) {
    state.chanOptions[key] = on
    if (chart) {
      chart.overrideIndicator({ name: 'CHAN', paneId: 'candle_pane', extendData: { ...state.chanOptions } })
    }
  }

  function bindUI() {
    $('#exchange').addEventListener('change', (e) => {
      state.exchange = e.target.value
      initChart()
    })

    $('#go').addEventListener('click', () => {
      const v = $('#symbol').value.trim()
      if (!v) return
      state.symbol = v.toUpperCase()
      $('#symbol').value = state.symbol
      refreshChart()
      setActiveState()
    })
    $('#symbol').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#go').click()
    })

    $('#quick-symbols').addEventListener('click', (e) => {
      const btn = e.target.closest('.chip[data-symbol]')
      if (!btn) return
      state.symbol = btn.dataset.symbol
      $('#symbol').value = state.symbol
      refreshChart()
      setActiveState()
    })

    $('#periods').addEventListener('click', (e) => {
      const btn = e.target.closest('.chip[data-period]')
      if (!btn) return
      const label = btn.dataset.period
      const period = PERIODS.find((p) => p.label === label)
      if (!period) return
      state.period = { type: period.type, span: period.span }
      refreshChart()
      setActiveState()
    })

    $('#tg-fractal').addEventListener('change', (e) => toggleChanOption('fractal', e.target.checked))
    $('#tg-stroke').addEventListener('change', (e) => toggleChanOption('stroke', e.target.checked))
    $('#tg-segment').addEventListener('change', (e) => toggleChanOption('segment', e.target.checked))
    $('#tg-featureseq').addEventListener('change', (e) => toggleChanOption('featureSeq', e.target.checked))
    $('#tg-segcenter').addEventListener('change', (e) => toggleChanOption('segmentCenter', e.target.checked))
    $('#tg-strcenter').addEventListener('change', (e) => toggleChanOption('strokeCenter', e.target.checked))
    $('#tg-divergence').addEventListener('change', (e) => toggleChanOption('divergence', e.target.checked))
    $('#tg-volume').addEventListener('change', (e) => toggleIndicator('volume', e.target.checked))
    $('#tg-macd').addEventListener('change', (e) => toggleIndicator('macd', e.target.checked))
  }

  // ---------------------------------------------------------------------------
  // 入口
  // ---------------------------------------------------------------------------
  function init() {
    klinecharts.registerIndicator({
      name: 'CHAN',
      shortName: '缠论',
      series: 'price',
      zLevel: 1,
      figures: [],
      calc: runChanCalc,
      draw: drawChan
    })

    bindUI()
    initChart()
    setActiveState()
    refreshTabInfo()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // 测试钩子（仅测试环境）：node 测试通过 vm 加载 main.js 时设置 window.__CHANLUN_TEST__ = true。
  // 生产浏览器中该值为空，不产生任何导出。
  if (window.__CHANLUN_TEST__) {
    window.__chanlunChart = {
      exchangers,
      state,
      klineCache,
      buildDataLoader,
      runChanCalc,
      lowerBound,
      visibleInRange,
      drawChan,
      get chanState() {
        return chanState
      }
    }
  }
})()
