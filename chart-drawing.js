/*!
 * chart-drawing.js —— 缠论主图与背驰副图绘制
 */
(function (global) {
  'use strict'

  function createChartDrawing(deps) {
    const { COLORS, centerPalette, resolveView } = deps

  // opts: { label?: 框内左上角文字, dashed?: 虚线边框（笔中枢） }
  function drawCenterRect(ctx, x, y, w, h, fill, border, opts) {
    ctx.fillStyle = fill
    ctx.strokeStyle = border
    ctx.lineWidth = opts && opts.dashed ? 1 : 1.2
    ctx.fillRect(x, y, w, Math.max(0, h))
    if (opts && opts.dashed && typeof ctx.setLineDash === 'function') {
      ctx.setLineDash([4, 3])
      ctx.strokeRect(x, y, w, Math.max(0, h))
      ctx.setLineDash([])
    } else {
      ctx.strokeRect(x, y, w, Math.max(0, h))
    }
    if (opts && opts.label) {
      ctx.fillStyle = border
      ctx.font = 'bold 9px system-ui, -apple-system, "Segoe UI", sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(opts.label, x + 3, y + 2)
    }
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

  // 价格显示：按量级自适应小数位（千位以上取 1 位，小额取 6 位）
  function fmtPrice(v) {
    if (typeof v !== 'number' || !isFinite(v)) return ''
    const a = Math.abs(v)
    const d = a >= 1000 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6
    return v.toLocaleString('zh-CN', { maximumFractionDigits: d })
  }

  // 给压在K线上的小字加半透明底板（仅在真实 Canvas 环境生效；
  // 测试用 fake ctx 可能没有 measureText，此时退化为无底板）。
  function fillTextBackground(ctx, text, x, y) {
    if (typeof ctx.measureText !== 'function') return
    const w = ctx.measureText(text).width + 6
    ctx.fillStyle = 'rgba(0, 0, 0, 0.62)'
    ctx.fillRect(x - w / 2, y - 10, w, 12)
  }

  // 中枢方向：价格进入中枢前的最后一条线段方向。
  // 中枢是两段趋势之间的震荡，用“进入中枢的走向”判定最贴近缠论直觉；
  // 颜色本身由 centerPalette 跟随当前 K 线涨跌配色。
  function centerDirOf(segments, cc) {
    let incoming = null
    for (const s of segments) {
      if (s.toRaw <= cc.startRaw) incoming = s
      else break
    }
    if (!incoming) {
      for (const s of segments) {
        if (s.toRaw >= cc.startRaw) { incoming = s; break }
      }
    }
    return incoming ? incoming.dir : 'up'
  }

  function drawChan({ ctx, chart, indicator, bounding, xAxis, yAxis }) {
    const view = resolveView(indicator)
    const chanState = view.chanState
    if (!chanState) return true
    const opts = view.chanOptions
    const range = chart.getVisibleRange()
    const { gapBar, halfGapBar } = chart.getBarSpace()
    const from = Math.max(0, Math.floor(range.realFrom))
    const to = Math.min(chanState.dataLen - 1, Math.ceil(range.realTo))
    const X = (rawIndex) => xAxis.convertToPixel(rawIndex)
    const Y = (value) => yAxis.convertToPixel(value)

    // 中枢方向缓存：centerDirOf 会扫描全部线段，同一中心在本次重绘中可能被两次查询
    // （线段中枢 + 笔中枢），缓存避免重复 O(线段数) 扫描。
    const centerDirCache = new Map()
    const centerDirOfCached = (cc) => {
      let dir = centerDirCache.get(cc)
      if (dir === undefined) {
        dir = centerDirOf(chanState.segments, cc)
        centerDirCache.set(cc, dir)
      }
      return dir
    }

    // 1. 中枢（垫底）。颜色跟随 K 线涨跌色，方向由进入中枢的走势决定；线段中枢带上下轨价格标签
    if (opts.segmentCenter) {
      ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      for (const cc of visibleInRange(chanState.segmentCenters, (z) => z.startRaw, (z) => z.endRaw, from, to)) {
        const x = X(cc.startRaw) - halfGapBar
        const w = X(cc.endRaw) - X(cc.startRaw) + gapBar
        const up = centerDirOfCached(cc) === 'up'
        const palette = centerPalette(up)
        drawCenterRect(ctx, x, Y(cc.zsHigh), w, Y(cc.zsLow) - Y(cc.zsHigh), palette.fill, palette.border, { label: '线段中枢' })
        // 上下轨价格标签（画在右轨外侧）
        ctx.fillStyle = palette.border
        ctx.fillText(fmtPrice(cc.zsHigh), X(cc.endRaw) + 4, Y(cc.zsHigh) - 4)
        ctx.fillText(fmtPrice(cc.zsLow), X(cc.endRaw) + 4, Y(cc.zsLow) - 1)
      }
    }
    if (opts.strokeCenter) {
      for (const cc of visibleInRange(chanState.strokeCenters, (z) => z.startRaw, (z) => z.endRaw, from, to)) {
        const x = X(cc.startRaw) - halfGapBar
        const w = X(cc.endRaw) - X(cc.startRaw) + gapBar
        const up = centerDirOfCached(cc) === 'up'
        const palette = centerPalette(up)
        drawCenterRect(
          ctx, x, Y(cc.zsHigh), w, Y(cc.zsLow) - Y(cc.zsHigh),
          palette.fill, palette.border,
          { label: '笔中枢', dashed: true }
        )
      }
    }

    // 2. 线段（被“线段破坏”扩展规则强行终结的段用虚线 + 警示色区分）
    if (opts.segment) {
      ctx.lineWidth = 2.2
      const setSegDash = typeof ctx.setLineDash === 'function' ? (on) => ctx.setLineDash(on ? [6, 4] : []) : null
      for (const seg of visibleInRange(chanState.segments, (s) => s.fromRaw, (s) => s.toRaw, from, to)) {
        const destroyed = seg.destroyed === true
        ctx.strokeStyle = destroyed ? COLORS.segmentDestroyed : COLORS.segment
        if (setSegDash) setSegDash(destroyed)
        ctx.beginPath()
        ctx.moveTo(X(seg.fromRaw), Y(seg.dir === 'up' ? seg.from.low : seg.from.high))
        ctx.lineTo(X(seg.toRaw), Y(seg.dir === 'up' ? seg.to.high : seg.to.low))
        ctx.stroke()
      }
      if (setSegDash) setSegDash(false)
    }

    // 5. 笔
    if (opts.stroke) {
      ctx.lineWidth = 1.6
      for (const s of visibleInRange(chanState.strokes, (st) => st.fromRaw, (st) => st.toRaw, from, to)) {
        ctx.strokeStyle = s.dir === 'up' ? COLORS.strokeUp : COLORS.strokeDown
        ctx.beginPath()
        ctx.moveTo(X(s.fromRaw), Y(s.fromValue))
        ctx.lineTo(X(s.toRaw), Y(s.toValue))
        ctx.stroke()
      }
    }

    // 6. 分型
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

    // 7. 笔背驰标记：▼/▲ 箭头 + 与前比较笔的虚线连接 + 趋背/盘背区分 + 强度比
    //    divergenceType 由同向中枢数量决定（≥2=趋背，1=盘背）；strength 仍表示
    //    大级别线段动量是否同步衰减（实心/空心圆点）。
    //    最后一笔未完成时只给灰色虚线圈 + “预警”，不与已确认背驰同权显示。
    if (opts.divergence && chanState.divergences) {
      ctx.font = 'bold 10px system-ui, -apple-system, "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.lineWidth = 1
      const setDash = typeof ctx.setLineDash === 'function' ? (on) => ctx.setLineDash(on ? [3, 3] : []) : null
      for (const d of visibleInRange(chanState.divergences, (d) => d.rawIndex, (d) => d.rawIndex, from, to)) {
        const strong = d.strength === 'strong'
        const provisional = d.provisional === true
        const color = provisional
          ? COLORS.divergenceProvisional
          : strong
            ? (d.kind === 'top' ? COLORS.divergenceTopStrong : COLORS.divergenceBottomStrong)
            : (d.kind === 'top' ? COLORS.divergenceTopWeak : COLORS.divergenceBottomWeak)
        const x = X(d.rawIndex)
        const yPrice = Y(d.value)
        // 与前一根同向比较笔的虚线连接（一眼看到“拿谁跟谁比”）
        const prevStroke = chanState.strokes[d.prevSi]
        if (prevStroke && setDash) {
          setDash(true)
          ctx.strokeStyle = color
          ctx.beginPath()
          ctx.moveTo(x, yPrice)
          ctx.lineTo(X(prevStroke.toRaw), Y(prevStroke.toValue))
          ctx.stroke()
          setDash(false)
          // 强度比标注在连线中点（当前强度 / 前笔强度）
          ctx.fillStyle = color
          const ratio = d.momentum && typeof d.momentum.ratio === 'number' ? d.momentum.ratio : null
          if (ratio !== null) {
            const mx = (x + X(prevStroke.toRaw)) / 2
            const my = (yPrice + Y(prevStroke.toValue)) / 2
            ctx.fillText(Math.round(ratio * 100) + '%', mx, my - 5)
          }
        }
        // 方向箭头 + 趋背/盘背标签（顶背驰指向下跌 ▼，底背驰指向上涨 ▲）
        const arrow = d.kind === 'top' ? '▼' : '▲'
        const sub = d.divergenceType === 'trend' ? '趋背' : '盘背'
        ctx.fillStyle = color
        ctx.font = 'bold 12px system-ui, -apple-system, "Segoe UI", sans-serif'
        ctx.fillText(arrow, x, d.kind === 'top' ? yPrice - 12 : yPrice + 18)
        ctx.font = 'bold 10px system-ui, -apple-system, "Segoe UI", sans-serif'
        const label = provisional ? (d.kind === 'top' ? '顶预警' : '底预警') : (d.kind === 'top' ? '顶' : '底') + sub
        ctx.fillText(label, x, d.kind === 'top' ? yPrice - 26 : yPrice + 31)
        // 面积数值（面积 = 单位强度 × 窗口K线数；副图高亮失败时也有数据支撑）
        if (d.momentum) {
          const curS = chanState.strokes[d.si]
          const prevS = chanState.strokes[d.prevSi]
          if (curS && prevS) {
            const aCur = d.momentum.current * (curS.toRaw - curS.fromRaw + 1)
            const aPrev = d.momentum.previous * (prevS.toRaw - prevS.fromRaw + 1)
            ctx.font = '9px system-ui, -apple-system, "Segoe UI", sans-serif'
            const areaLabel = 'A ' + aCur.toFixed(1) + ' · B ' + aPrev.toFixed(1)
            const labelY = d.kind === 'top' ? yPrice - 39 : yPrice + 44
            fillTextBackground(ctx, areaLabel, x, labelY)
            ctx.fillStyle = color
            ctx.fillText(areaLabel, x, labelY)
          }
        }
        // 圆点（强=实心 / 弱=空心 / 未完成=灰色虚线圈）
        ctx.strokeStyle = color
        if (setDash) setDash(provisional)
        ctx.beginPath()
        ctx.arc(x, yPrice, strong && !provisional ? 5 : 4, 0, Math.PI * 2)
        if (strong && !provisional) ctx.fill()
        else ctx.stroke()
        if (setDash) setDash(false)
      }
      ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif'
    }

    return true
  }

  // ---------------------------------------------------------------------------
  // MACD 副图：背驰两段面积高亮（CHAN_DIV 指标附加到 MACD pane）
  // ---------------------------------------------------------------------------
  // 在 MACD 副图上，把每个背驰事件的「被比较两段走势」的 MACD 柱区域用半透明色
  // 高亮（与蜡烛图 ▼/▲ 标记同一来源 chanState.divergences），并用虚线连接两段，
  // 在各自末端标注面积数值（面积 = 动量强度 × 窗口K线数）。
  function drawChanDiv({ ctx, chart, indicator, bounding, xAxis, yAxis }) {
    const view = resolveView(indicator)
    const chanState = view.chanState
    if (!chanState || !chanState.divergences || !chanState.divergences.length) return true
    const range = chart.getVisibleRange()
    const { gapBar, halfGapBar } = chart.getBarSpace()
    const from = Math.max(0, Math.floor(range.realFrom))
    const to = Math.min(chanState.dataLen - 1, Math.ceil(range.realTo))
    const X = (i) => xAxis.convertToPixel(i)
    const Y = (v) => yAxis.convertToPixel(v)
    const res = indicator.result
    const hist = Array.isArray(res) ? res.map((r) => (r && typeof r.value === 'number' ? r.value : 0)) : null
    if (!hist) return true
    const y0 = Y(0)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    const dash = typeof ctx.setLineDash === 'function' ? (on) => ctx.setLineDash(on ? [2, 2] : []) : null
    const areaColor = (d) =>
      d.kind === 'top'
        ? (d.strength === 'strong' ? COLORS.divAreaTopStrong : COLORS.divAreaTopWeak)
        : (d.strength === 'strong' ? COLORS.divAreaBottomStrong : COLORS.divAreaBottomWeak)

    // 仅绘制可见窗口内的背驰（避免全量遍历所有分歧）
    const visibleDivs = visibleInRange(chanState.divergences, (d) => d.rawIndex, (d) => d.rawIndex, from, to)
    for (const d of visibleDivs) {
      const cur = chanState.strokes[d.si]
      const prev = chanState.strokes[d.prevSi]
      if (!cur || !prev) continue
      const color = areaColor(d)
      ctx.fillStyle = color
      // 两段走势的 MACD 柱区域高亮
      for (const rng of [[prev.fromRaw, prev.toRaw], [cur.fromRaw, cur.toRaw]]) {
        const a = Math.max(from, rng[0])
        const b = Math.min(to, rng[1])
        for (let i = a; i <= b && i < hist.length; i++) {
          const h = hist[i]
          const top = Math.min(y0, Y(h))
          const bot = Math.max(y0, Y(h))
          ctx.fillRect(X(i) - halfGapBar, top, gapBar, Math.max(1, bot - top))
        }
      }
      // 虚线连接两段（基准段末端 → 背驰段末端）
      if (dash) {
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        dash(true)
        ctx.beginPath()
        ctx.moveTo(X(prev.toRaw), y0)
        ctx.lineTo(X(cur.toRaw), y0)
        ctx.stroke()
        dash(false)
      }
      // 面积数值标注（面积 = 单位强度 × 窗口K线数）
      ctx.font = 'bold 9px system-ui, -apple-system, "Segoe UI", sans-serif'
      ctx.fillStyle = color
      if (d.momentum) {
        const aPrev = d.momentum.previous * (prev.toRaw - prev.fromRaw + 1)
        const aCur = d.momentum.current * (cur.toRaw - cur.fromRaw + 1)
        ctx.fillText('B:' + aPrev.toFixed(1), X(prev.toRaw), y0 - 4)
        ctx.fillText('A:' + aCur.toFixed(1), X(cur.toRaw), y0 - 4)
      }
    }
    return true
  }

    return { drawCenterRect, lowerBound, visibleInRange, fmtPrice, fillTextBackground, centerDirOf, drawChan, drawChanDiv }
  }

  const api = { create: createChartDrawing }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else global.chartDrawing = api
})(typeof window !== 'undefined' ? window : globalThis)