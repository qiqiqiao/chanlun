/*!
 * tests/helpers.js —— 共享测试工具：bar 构造、确定性数据生成
 */
'use strict'

// 由一组收盘价序列生成 bar（相邻收盘价作为 open/close，上下影线各 1）
function barsFrom(seq) {
  const bars = []
  let p = 100
  for (let i = 0; i < seq.length; i++) {
    const cl = seq[i]
    bars.push({
      timestamp: 1700000000000 + i * 60000,
      open: p,
      high: Math.max(p, cl) + 1,
      low: Math.min(p, cl) - 1,
      close: cl,
      volume: 100
    })
    p = cl
  }
  return bars
}

// LCG 伪随机数（确定性）
function makeRng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

// 确定性交替方向笔序列（直接喂给 segmentScan / calcSegments）。
// 偶发大波动可制造特征序列缺口（触发第二种情况/待确认状态）。
// 注意：与 merge/fractal/stroke 流水线无关，仅用于线段层测试。
function randStrokes(n, seed) {
  const rnd = makeRng(seed)
  const strokes = []
  let price = 100
  let dir = rnd() > 0.5 ? 'up' : 'down'
  for (let i = 0; i < n; i++) {
    const move = rnd() > 0.9 ? 6 * (2 + rnd() * 3) : 6 * (0.4 + rnd() * 1.2)
    const to = dir === 'up' ? price + move : price - move
    const high = Math.max(price, to)
    const low = Math.min(price, to)
    strokes.push({
      si: i,
      dir,
      from: { high, low },
      to: { high, low },
      fromRaw: i * 5,
      toRaw: i * 5 + 5,
      high,
      low
    })
    price = to
    dir = dir === 'up' ? 'down' : 'up'
  }
  return strokes
}

// 带影线的随机游走：能触发包含关系合并与多笔结构
function randomWalk(n, seed) {
  const rnd = makeRng(seed)
  const bars = []
  let price = 100
  for (let i = 0; i < n; i++) {
    const o = price
    const drift = (rnd() - 0.48) * 2
    const cl = o + drift
    const wick = rnd() > 0.75 ? (rnd() - 0.5) * 4 : 0
    bars.push({
      timestamp: 1700000000000 + i * 60000,
      open: o,
      high: Math.max(o, cl) + Math.abs(wick),
      low: Math.min(o, cl) - Math.abs(wick),
      close: cl,
      volume: 100
    })
    price = cl
  }
  return bars
}

module.exports = { barsFrom, makeRng, randomWalk, randStrokes }
