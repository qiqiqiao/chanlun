/*!
 * src/stroke.js —— 笔模块
 *
 * 连接相邻顶底分型，且之间合并K线数量满足最小要求（bi.minGap）。
 * 笔必须连贯划分：已成笔的终点就是下一笔的起点（笔与笔首尾相连）。
 * 这里用“有效分型端点序列”维护：同类型更极端的分型出现时，
 * 回退上一笔并延伸到更极端点，保证笔连续且顶底取到真正的极值。
 *
 * createStrokeMachine 是可回放状态机：增量时从快照锚点重放尾部。
 */
(function (global) {
  'use strict'

  function pushStroke(strokes, a, b) {
    const dir = a.type === 'bottom' ? 'up' : 'down'
    strokes.push({
      si: strokes.length,
      dir,
      from: a,
      to: b,
      fromRaw: a.rawMiddle,
      toRaw: b.rawMiddle,
      fromValue: dir === 'up' ? a.low : a.high,
      toValue: dir === 'up' ? b.high : b.low,
      high: Math.max(a.high, b.high),
      low: Math.min(a.low, b.low)
    })
  }

  function strokeStep(state, f, minGap) {
    const endpoints = state.endpoints
    const strokes = state.strokes
    if (endpoints.length === 0) {
      endpoints.push(f)
      return
    }
    const last = endpoints[endpoints.length - 1]
    if (f.type === last.type) {
      // 同类型分型：更极端则回退上一笔并延伸，保证笔连续
      const moreExtreme =
        (f.type === 'top' && f.high > last.high) ||
        (f.type === 'bottom' && f.low < last.low)
      if (moreExtreme) {
        endpoints.pop()
        if (strokes.length) strokes.pop()
        if (endpoints.length) {
          const nl = endpoints[endpoints.length - 1]
          if (f.mi - nl.mi >= minGap) {
            pushStroke(strokes, nl, f)
            endpoints.push(f)
          }
        } else {
          endpoints.push(f)
        }
      }
    } else if (f.mi - last.mi >= minGap) {
      // 相反类型且合并K线数足够 → 成笔
      pushStroke(strokes, last, f)
      endpoints.push(f)
    }
    // 距离不足或不够极端的同类型分型：忽略
  }

  function createStrokeMachine(minGap) {
    const state = { endpoints: [], strokes: [] }
    const snaps = [] // 每个分型处理后的 { e: endpoints 长度, s: strokes 长度 }

    function feed(f) {
      strokeStep(state, f, minGap)
      snaps.push({ e: state.endpoints.length, s: state.strokes.length })
    }

    // 回退到第 anchor 个分型之前的状态，重放 fractals[anchor..]
    // 返回受影响（重放起点）处 strokes 的长度，供上层计算“变化起点”
    function replay(fractals, anchor) {
      if (anchor < 0) anchor = 0
      if (anchor === 0) {
        state.endpoints.length = 0
        state.strokes.length = 0
        snaps.length = 0
      } else {
        const p = snaps[anchor - 1]
        state.endpoints.length = p.e
        state.strokes.length = p.s
        snaps.length = anchor
      }
      for (let i = anchor; i < fractals.length; i++) feed(fractals[i])
      return { affectedFrom: anchor === 0 ? 0 : snaps[anchor - 1].s }
    }

    return {
      state,
      snapCount: () => snaps.length,
      feed,
      replay
    }
  }

  function calcStrokes(fractals, cfg) {
    const machine = createStrokeMachine(cfg.bi.minGap)
    machine.replay(fractals, 0)
    return { strokes: machine.state.strokes, endpoints: machine.state.endpoints }
  }

  const api = { pushStroke, strokeStep, createStrokeMachine, calcStrokes }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    global.Chanlun = global.Chanlun || {}
    global.Chanlun.stroke = api
  }
})(typeof window !== 'undefined' ? window : globalThis)
