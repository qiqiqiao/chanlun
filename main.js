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
      segmentCenter: true,
      strokeCenter: false,
      divergence: true,
      // 线段破坏是扩展规则（非 67/71 课字面内容），默认关闭
      segmentDestroy: false
    },
    indOptions: {
      volume: true,
      macd: true,
      chinaColors: false
    }
  }

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

  const periodOf = (label) => PERIODS.find((p) => p.label === label)
  const labelOf = (period) => {
    const p = PERIODS.find((x) => x.type === period.type && x.span === period.span)
    return p ? p.label : ''
  }

  const QUICK_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT']

  // ---------------------------------------------------------------------------
  // UI 状态持久化（localStorage）：交易所/品种/周期/全部显示开关，刷新后恢复
  // ---------------------------------------------------------------------------
  const UI_STATE_KEY = 'chanlun.ui.v1'

  // 可持久化的布尔开关：[state 分组, 键, 对应复选框 id]
  const TOGGLES = [
    ['chanOptions', 'fractal', 'tg-fractal'],
    ['chanOptions', 'stroke', 'tg-stroke'],
    ['chanOptions', 'segment', 'tg-segment'],
    ['chanOptions', 'segmentCenter', 'tg-segcenter'],
    ['chanOptions', 'strokeCenter', 'tg-strcenter'],
    ['chanOptions', 'divergence', 'tg-divergence'],
    ['chanOptions', 'segmentDestroy', 'tg-segdestroy'],
    ['indOptions', 'volume', 'tg-volume'],
    ['indOptions', 'macd', 'tg-macd'],
    ['indOptions', 'chinaColors', 'tg-china']
  ]

  // 恢复上次会话的 UI 状态。逐字段白名单校验：存储损坏/缺字段/篡改值都退回默认。
  // localStorage 不可用（隐私模式、file:// 限制）时静默跳过，不影响功能。
  function loadPersistedState() {
    let saved
    try {
      saved = JSON.parse(localStorage.getItem(UI_STATE_KEY) || 'null')
    } catch (e) {
      return
    }
    if (!saved || typeof saved !== 'object') return
    if (saved.exchange === 'binance' || saved.exchange === 'okx') state.exchange = saved.exchange
    if (typeof saved.symbol === 'string') {
      const s = saved.symbol.trim().toUpperCase()
      if (s && s.length <= 24) state.symbol = s
    }
    if (
      saved.period &&
      PERIODS.some((p) => p.type === saved.period.type && p.span === saved.period.span)
    ) {
      state.period = { type: saved.period.type, span: saved.period.span }
    }
    for (const [group, key] of TOGGLES) {
      const g = saved[group]
      if (g && typeof g === 'object' && typeof g[key] === 'boolean') state[group][key] = g[key]
    }
  }

  function saveState() {
    try {
      localStorage.setItem(
        UI_STATE_KEY,
        JSON.stringify({
          exchange: state.exchange,
          symbol: state.symbol,
          period: state.period,
          chanOptions: state.chanOptions,
          indOptions: state.indOptions
        })
      )
    } catch (e) {
      /* 写失败（配额/隐私模式）不影响运行 */
    }
  }

  // 把恢复后的状态同步到顶部栏控件（select / 输入框 / 复选框勾选态）
  function syncControlsFromState() {
    const ex = $('#exchange')
    if (ex) ex.value = state.exchange
    const sym = $('#symbol')
    if (sym) sym.value = state.symbol
    for (const [group, key, id] of TOGGLES) {
      const el = $('#' + id)
      if (el) el.checked = !!state[group][key]
    }
  }

  const COLORS = {
    fractalTop: '#ff5b6a',
    fractalBottom: '#3fd67f',
    strokeUp: '#ffb35c',
    strokeDown: '#55ccff',
    segment: '#ff5fa0',
    // 特征序列（线段内特征方向笔的虚拟K线，未做包含合并）：up=青 / down=粉
    featureUp: 'rgba(0, 229, 255, 0.9)',
    featureDown: 'rgba(255, 107, 178, 0.9)',
    // 特征序列包含处理高亮：被合并进上一根的原始特征笔（展示算法如何处理包含关系）
    featureMerged: '#ffd54f',
    // MACD 副图面积高亮（背驰两段）：顶背驰红 / 底背驰绿
    divAreaTopStrong: 'rgba(255, 45, 85, 0.40)',
    divAreaTopWeak: 'rgba(255, 93, 122, 0.22)',
    divAreaBottomStrong: 'rgba(0, 230, 118, 0.40)',
    divAreaBottomWeak: 'rgba(63, 214, 127, 0.22)',
    // 被线段破坏规则强行终结的线段（扩展规则才会出现）
    segmentDestroyed: '#ffd54f',
    // 背驰标记：强背驰高亮（顶=红 / 底=绿），弱背驰半透明提示
    divergenceTopStrong: '#ff2d55',
    divergenceTopWeak: 'rgba(255, 93, 122, 0.6)',
    divergenceBottomStrong: '#00e676',
    divergenceBottomWeak: 'rgba(63, 214, 127, 0.55)',
    // 最后一笔尚未完成：预警状态，与已确认背驰区分（灰色虚线圈）
    divergenceProvisional: 'rgba(176, 184, 196, 0.9)'
  }

  // 中枢配色跟随 K 线涨跌色（默认西式阳绿阴红 / 中国习惯阳红阴绿）。
  // 这样向上中枢不会在绿涨红跌的图里被误读成“上涨”。
  function centerPalette(up) {
    const china = !!state.indOptions.chinaColors
    const upRgb = china ? '239, 83, 80' : '0, 204, 0'
    const downRgb = china ? '0, 204, 0' : '239, 83, 80'
    const rgb = up ? upRgb : downRgb
    return {
      fill: 'rgba(' + rgb + ', ' + (up ? 0.18 : 0.14) + ')',
      border: 'rgb(' + rgb + ')'
    }
  }

  // 单图表视图的运行状态（多周期联动已移除，不再需要视图反查表/兜底视图）
  let mainView = null
  let faviconSymbol = null

  // ---------------------------------------------------------------------------
  // Binance / OKX REST 与 WebSocket 适配器独立于页面集成。
  const exchangeAdapters = window.exchangeAdapters.create(window.dataLayer)
  const exchangers = exchangeAdapters.exchangers

  function currentExchange() {
    return exchangers[state.exchange] || exchangers.binance
  }

  // ---------------------------------------------------------------------------
  // 缠论计算与绘制
  // ---------------------------------------------------------------------------
  // 算法默认参数单一来源（src/config.js）：避免 MACD 12/26/9 在多处硬编码。
  const ALGO_DEFAULTS = window.chanlun.DEFAULT_CONFIG
  const MACD_PARAMS = [
    ALGO_DEFAULTS.divergence.macdFast,
    ALGO_DEFAULTS.divergence.macdSlow,
    ALGO_DEFAULTS.divergence.macdSignal
  ]
  // 配置快照：线段破坏开关来自 UI（默认关，标准特征序列规则）
  function chanConfig() {
    return {
      bi: { minGap: ALGO_DEFAULTS.bi.minGap },
      segment: {
        destroyOnBreach: state.chanOptions.segmentDestroy === true
      }
    }
  }

  // 实时更新策略在 realtime.js：用【内容签名】判断末根变化（对象原地改值也能识别），
  // 而不是对象引用。klinecharts 可能复用同一 bar 对象并原地修改 OHLC，
  // 引用判断会漏判 → 缠论不刷新（P0 已修复）。
  function createUpdater() {
    return window.realtime.createRealtimeUpdater({
      createAnalyzer: (cfg) => window.chanlun.createAnalyzer(cfg),
      config: chanConfig()
    })
  }

  // 惰性视图：浏览器 initCharts 会创建带图表的视图；测试环境不初始化
  // klinecharts 时，runChanCalc 仍需要一份状态容器。
  function ensureView() {
    if (!mainView) {
      mainView = {
        symbol: state.symbol,
        exchange: state.exchange,
        period: state.period,
        chanState: null,
        // 与模块默认开关共享引用：测试直接改 state.chanOptions 即生效
        chanOptions: state.chanOptions,
        updater: createUpdater(),
        chart: null,
        volId: null,
        macdId: null,
        chanDivId: null
      }
    }
    return mainView
  }

  function resolveView() {
    return ensureView()
  }

  // CHAN calc 的返回值不被消费（figures 为空）：单项共享 + 按视图/长度缓存数组，
  // 避免每次计算分配数千个 { v: 0 } 对象
  const ZERO_RESULT_ITEM = { v: 0 }
  function zeroResultFor(view, n) {
    let arr = view.zeroResult
    if (!arr || arr.length !== n) {
      arr = new Array(n).fill(ZERO_RESULT_ITEM)
      view.zeroResult = arr
    }
    return arr
  }

  function runChanCalc(dataList, indicator) {
    const view = resolveView(indicator)
    const n = dataList.length
    if (!n) {
      updateStatus()
      return zeroResultFor(view, n)
    }
    const r = view.updater.update(dataList)
    view.chanState = r.state
    // skip 表示长度与末根内容都没变，缠论状态和状态栏文本必然不变；
    // 缩放/平移触发的指标重算会走到这里，省掉每帧的 filter + 拼串 + DOM 写入。
    if (r.action !== 'skip') updateStatus()
    return zeroResultFor(view, n)
  }

  let lastStatusText = null
  function updateStatus() {
    const el = $('#status')
    if (!el) return
    const chanState = mainView ? mainView.chanState : null
    let text = ''
    if (chanState) {
      const finished = chanState.segments.filter((s) => s.finished).length
      const divs = chanState.divergences || []
      const strongDivs = divs.filter((d) => d.confirmed).length
      text =
        state.symbol +
        ' · ' + currentExchange().label +
        // chanState.fractals 实际是笔端点（过滤后的有效分型序列），不是全部分型
        ' | 笔端点 ' + chanState.fractals.length +
        ' · 笔 ' + chanState.strokes.length +
        ' · 线段 ' + finished + '+' + (chanState.segments.length - finished) +
        ' · 线段中枢 ' + chanState.segmentCenters.length +
        ' · 笔中枢 ' + chanState.strokeCenters.length +
        ' · 背驰 ' + strongDivs + '/' + divs.length
    }
    // 文本未变就不碰 DOM：footer 带 aria-live，重复写入会反复触发辅助技术播报
    if (text !== lastStatusText) {
      el.textContent = text
      lastStatusText = text
    }
  }

  // 绘制逻辑独立于页面与图表生命周期。
  const chartDrawing = window.chartDrawing.create({ COLORS, centerPalette, resolveView })
  const { drawCenterRect, lowerBound, visibleInRange, fmtPrice, fillTextBackground, centerDirOf, drawChan, drawChanDiv } = chartDrawing

  // ---------------------------------------------------------------------------
  // 暗色主题
  // ---------------------------------------------------------------------------
  function darkStyles() {
    // 默认西式（阳=绿 / 阴=红）；chinaColors 开启后切换为中国习惯（阳=红 / 阴=绿）
    const CHINA = !!state.indOptions.chinaColors
    const GREEN = '#00cc00'
    const RED = '#ef5350'
    const UP = CHINA ? RED : GREEN
    const DOWN = CHINA ? GREEN : RED
    return {
      grid: {
        horizontal: { show: true, color: 'rgba(255,255,255,0.06)', size: 1 },
        vertical: { show: true, color: 'rgba(255,255,255,0.06)', size: 1 }
      },
      candle: {
        bar: {
          upColor: UP,
          downColor: DOWN,
          noChangeColor: '#8a8a8a',
          upBorderColor: UP,
          downBorderColor: DOWN,
          noChangeBorderColor: '#8a8a8a',
          upWickColor: UP,
          downWickColor: DOWN,
          noChangeWickColor: '#8a8a8a'
        },
        priceMark: {
          high: { show: true, color: 'rgba(255,255,255,0.4)', textOffset: 5, textSize: 10 },
          low: { show: true, color: 'rgba(255,255,255,0.4)', textOffset: 5, textSize: 10 },
          last: {
            show: true,
            upColor: UP,
            downColor: DOWN,
            noChangeColor: '#8a8a8a',
            line: { show: true, color: 'rgba(255,255,255,0.25)', style: 'dashed', size: 1, dashValue: [3, 3] }
          }
        }
      },
      // VOL / MACD 柱子颜色（klinecharts 读取 styles.indicator.bars[0].upColor/downColor）
      indicator: {
        bars: [{ upColor: UP, downColor: DOWN }]
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

  // 从主图最后一根K线读取最新价并刷新标题
  function refreshTabInfo() {
    let price = null
    if (mainView && mainView.chart) {
      const dataList = mainView.chart.getDataList()
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
  function resetView(view) {
    if (!view) return
    view.updater.reset()
    view.chanState = null
  }

  function resetChanCalc() {
    resetView(mainView)
    updateStatus()
  }

  // klinecharts v10 数据加载器（data-layer.js 实现：init/forward/backward 分页 + 实时订阅）。
  // 共享 klineCache（键 = 交易所:品种:周期），避免重复请求同周期数据。
  function buildDataLoader(view) {
    return window.dataLayer.createKlineLoader({
      getExchange: currentExchange,
      cache: klineCache,
      onError: (msg) => {
        console.error('数据加载失败：' + msg)
        showToast('数据加载失败：' + msg)
      },
      onLoadingChange: setLoading,
      onData: () => {
        refreshTabInfo()
      }
    })
  }

  // 创建图表视图：klinecharts 实例 + 缠论状态 + 显示开关 + 加载器
  function createChartView({ containerId }) {
    const view = {
      symbol: state.symbol,
      exchange: state.exchange,
      period: state.period,
      chanState: null,
      chanOptions: { ...state.chanOptions },
      // 必须恢复持久化后的指标开关；写死 true 会导致刷新/切换交易所后
      // 已关闭的 VOL/MACD 又被创建，复选框状态与图表不一致。
      indOptions: { ...state.indOptions },
      chart: null,
      updater: createUpdater(),
      volId: null,
      macdId: null,
      chanDivId: null
    }
    view.chart = klinecharts.init(containerId)
    view.chart.setStyles(darkStyles())
    view.chart.createIndicator({ name: 'CHAN', paneId: 'candle_pane' }, true)
    applyIndicators(view)
    view.chart.setSymbol({ ticker: state.symbol })
    view.chart.setPeriod(view.period)
    view.chart.setDataLoader(buildDataLoader(view))
    return view
  }

  function createMacd(view) {
    view = view || ensureView()
    const ch = view.chart
    if (!ch) return
    if (view.macdId && ch.getIndicators && ch.getIndicators({ id: view.macdId }).length) return
    view.macdId = ch.createIndicator({ name: 'MACD', calcParams: MACD_PARAMS.slice() })
    // 把「背驰面积」指标附加到 MACD 所在的 pane（失败则静默降级，不影响主图）
    try {
      const mi = ch.getIndicators({ id: view.macdId })
      const paneId = mi && mi.length ? mi[0].paneId : null
      // 关键：isStack=true，否则 klinecharts 会把 MACD pane 里已有的指标（含 MACD）先删掉
      // （StoreImp.addIndicator 在 !isStack 时 removeIndicator({paneId})），导致 MACD 消失。
      if (paneId) {
        const divId = ch.createIndicator({ name: 'CHAN_DIV', paneId }, true)
        view.chanDivId = divId
      }
    } catch (e) {
      view.chanDivId = null
    }
  }

  function removeMacd(view) {
    if (!view || !view.chart) return
    if (view.chanDivId) {
      view.chart.removeIndicator({ id: view.chanDivId })
      view.chanDivId = null
    }
    if (view.macdId) {
      view.chart.removeIndicator({ id: view.macdId })
      view.macdId = null
    }
  }

  function applyIndicators(view) {
    if (!view || !view.chart) return
    if (view.indOptions.volume) {
      // VOL 带成交量均线（MA5 / MA10 / MA20）
      view.volId = view.chart.createIndicator({ name: 'VOL', calcParams: [5, 10, 20] })
    }
    if (view.indOptions.macd) {
      createMacd(view)
    }
  }

  function toggleIndicator(key, on) {
    state.indOptions[key] = on
    saveState()
    const view = mainView
    if (!view || !view.chart) return
    // view.indOptions 必须与 state 同步，否则重建视图/重复点击会按旧状态叠加指标
    view.indOptions[key] = on
    if (on) {
      if (key === 'volume') {
        if (!view.volId) view.volId = view.chart.createIndicator({ name: 'VOL', calcParams: [5, 10, 20] })
      } else if (key === 'macd') {
        if (!view.macdId) createMacd(view)
      }
    } else {
      if (key === 'volume' && view.volId) {
        view.chart.removeIndicator({ id: view.volId })
        view.volId = null
      } else if (key === 'macd') {
        removeMacd(view)
      }
    }
  }

  function initCharts() {
    resetChanCalc()
    if (mainView && mainView.chart) klinecharts.dispose(mainView.chart)
    mainView = createChartView({ containerId: 'chart' })
    refreshTabInfo()
  }

  function refreshChart() {
    if (!mainView || !mainView.chart) return
    resetChanCalc()
    mainView.symbol = state.symbol
    mainView.chart.setSymbol({ ticker: state.symbol })
    mainView.chart.setPeriod(state.period)
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
    saveState()
    if (mainView) {
      mainView.chanOptions[key] = on
      if (mainView.chart) {
        mainView.chart.overrideIndicator({ name: 'CHAN', paneId: 'candle_pane', extendData: { ...mainView.chanOptions } })
      }
    }
  }

  // 改变会影响计算结构的规则（如线段破坏）时，重建 analyzer 并重算当前数据。
  // 否则只切换显示开关不会刷新线段/中枢。
  function toggleChanRule(key, on) {
    state.chanOptions[key] = on
    saveState()
    if (!mainView) return
    mainView.chanOptions[key] = on
    mainView.updater = createUpdater()
    mainView.chanState = null
    if (!mainView.chart) return
    const dataList = mainView.chart.getDataList()
    if (dataList && dataList.length) {
      const r = mainView.updater.update(dataList)
      mainView.chanState = r.state
      updateStatus()
    }
    mainView.chart.overrideIndicator({
      name: 'CHAN',
      paneId: 'candle_pane',
      extendData: { ...mainView.chanOptions }
    })
  }

  function bindUI() {
    $('#exchange').addEventListener('change', (e) => {
      state.exchange = e.target.value
      saveState()
      initCharts()
    })

    $('#go').addEventListener('click', () => {
      const v = $('#symbol').value.trim()
      if (!v) return
      state.symbol = v.toUpperCase()
      $('#symbol').value = state.symbol
      saveState()
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
      saveState()
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
      saveState()
      refreshChart()
      setActiveState()
    })

    $('#tg-fractal').addEventListener('change', (e) => toggleChanOption('fractal', e.target.checked))
    $('#tg-stroke').addEventListener('change', (e) => toggleChanOption('stroke', e.target.checked))
    $('#tg-segment').addEventListener('change', (e) => toggleChanOption('segment', e.target.checked))
    $('#tg-segcenter').addEventListener('change', (e) => toggleChanOption('segmentCenter', e.target.checked))
    $('#tg-strcenter').addEventListener('change', (e) => toggleChanOption('strokeCenter', e.target.checked))
    $('#tg-divergence').addEventListener('change', (e) => toggleChanOption('divergence', e.target.checked))
    $('#tg-segdestroy').addEventListener('change', (e) => toggleChanRule('segmentDestroy', e.target.checked))
    $('#tg-volume').addEventListener('change', (e) => toggleIndicator('volume', e.target.checked))
    $('#tg-macd').addEventListener('change', (e) => toggleIndicator('macd', e.target.checked))
    $('#tg-china').addEventListener('change', (e) => {
      state.indOptions.chinaColors = e.target.checked
      saveState()
      if (mainView && mainView.chart) mainView.chart.setStyles(darkStyles())
    })
  }

  // ---------------------------------------------------------------------------
  // 入口
  // ---------------------------------------------------------------------------
  function init() {
    // 外部唯一 CDN 依赖缺失时给出可见提示（否则静默白屏）
    if (typeof klinecharts === 'undefined') {
      const el = $('#chart')
      if (el) {
        const msg = document.createElement('div')
        msg.className = 'cdn-error'
        msg.textContent = '图表库加载失败：无法从 cdn.jsdelivr.net 获取 klinecharts。请检查网络或代理后刷新页面。'
        el.appendChild(msg)
      }
      return
    }
    klinecharts.registerIndicator({
      name: 'CHAN',
      shortName: '缠论',
      series: 'price',
      zLevel: 1,
      figures: [],
      calc: runChanCalc,
      draw: drawChan
    })

    // 背驰面积高亮（附加到 MACD 副图；仅当 MACD 开启时创建）
    klinecharts.registerIndicator({
      name: 'CHAN_DIV',
      shortName: '背驰面积',
      series: 'normal',
      figures: [],
      calc: (dataList) => {
        const closes = dataList.map((d) => d.close)
        const hist = window.chanlun.macdHistogram(closes, MACD_PARAMS[0], MACD_PARAMS[1], MACD_PARAMS[2])
        return hist.map((h) => ({ value: h }))
      },
      draw: drawChanDiv
    })

    loadPersistedState()
    syncControlsFromState()
    bindUI()
    initCharts()
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
      fetchJson: exchangeAdapters.fetchJson,
      runChanCalc,
      lowerBound,
      visibleInRange,
      fmtPrice,
      centerDirOf,
      centerPalette,
      darkStyles,
      drawChan,
      drawChanDiv,
      createMacd,
      periodOf,
      labelOf,
      resolveView,
      resetView,
      initCharts,
      toggleIndicator,
      get mainView() {
        return mainView
      },
      get chanState() {
        return mainView ? mainView.chanState : null
      }
    }
  }
})()
