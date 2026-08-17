/*!
 * tests/fixtures.js —— 可复用测试数据（测试数据“资产”）
 *
 * 每个场景：确定性 bars + 结构说明 + 预期结构（人工核对/锁定，防回归）。
 * 通用结构不变量由 tests/fixtures.test.js 校验。
 */
'use strict'
const { barsFrom, randomWalk } = require('./helpers')

// 工具：把 [from→to] 的 n 段推进追加进价格序列（每段 n 根K线）
function leg(seq, from, to, n) {
  for (let i = 1; i <= n; i++) seq.push(from + ((to - from) * i) / n)
  return seq
}

// 经典锯齿：每腿 5 根单调推进，笔结构可精确预测（minGap=4）
const ZIGZAG_SEQ = [
  100, 104, 108, 112, 116, 120, // 上升腿
  120, 115, 110, 105, 100, 95,  // 下降腿
  95, 100, 105, 110, 115, 120,  // 上升腿
  120, 114, 108, 102, 96, 90,   // 下降腿
  90, 96, 102, 108, 114, 120    // 上升腿
]

// 波浪：5 段趋势 + 40 根区间 + 突破
function buildWaveSeq() {
  const s = []
  leg(s, 100, 122, 10) // 上升
  leg(s, 122, 101, 9)  // 回调
  leg(s, 101, 128, 10) // 上升
  leg(s, 128, 108, 9)  // 回调
  leg(s, 108, 140, 11) // 上升
  for (let i = 0; i < 40; i++) s.push(140 + [3, -4, 5, -3, 2, -5, 4, -2][i % 8]) // 区间
  leg(s, 138, 160, 10) // 突破
  return s
}

// 宽幅震荡：7 根一循环的锯齿，整体带中枢
function buildRangeSeq() {
  const s = []
  let base = 100
  let d = 1
  for (let i = 0; i < 120; i++) {
    if (i % 7 === 0) d = -d
    base += d * (i % 7 < 3 ? 6 : -2)
    if (base > 112) base = 112
    if (base < 88) base = 88
    s.push(base)
  }
  return s
}

const FIXTURES = {
  classicZigzag: {
    meta: '经典锯齿：每腿 5 根单调推进 → 3 笔（down/up/down），笔端点精确可预测',
    bars: barsFrom(ZIGZAG_SEQ),
    expect: {
      raw: 30,
      merged: 21,
      strokes: 3,
      strokeDirs: ['down', 'up', 'down'],
      endpoints: [6, 12, 18, 24], // 各笔 fromRaw / 末笔 toRaw
      segments: 1,
      segmentDirs: ['down'],
      finishedSegments: 0,
      strokeCenters: 1, // 三笔重叠成中枢 [94,121]
      segmentCenters: 0
    }
  },
  wave: {
    meta: '五段趋势 + 区间 + 突破：多笔、笔中枢、单条未完成向下线段',
    bars: barsFrom(buildWaveSeq()),
    expect: {
      raw: 99,
      merged: 72,
      fractals: 8,
      strokes: 7,
      segments: 1,
      finishedSegments: 0,
      lastSegment: { dir: 'down', fromRaw: 10, toRaw: 87, finished: false },
      strokeCenters: 2,
      segmentCenters: 0
    }
  },
  range: {
    meta: '宽幅震荡（整体区间 88~112）：锯齿笔 + 笔中枢',
    bars: barsFrom(buildRangeSeq()),
    expect: {
      raw: 120,
      merged: 102,
      fractals: 17,
      strokes: 16,
      segments: 1,
      finishedSegments: 0,
      lastSegment: { dir: 'up', fromRaw: 2, toRaw: 115, finished: false },
      strokeCenters: 1,
      segmentCenters: 0
    }
  },
  random: {
    meta: '确定性随机游走（seed 42）：含已终结线段与笔中枢',
    bars: randomWalk(300, 42),
    expect: {
      raw: 300,
      merged: 145,
      fractals: 18,
      strokes: 17,
      segments: 2,
      finishedSegments: 1,
      strokeCenters: 1,
      segmentCenters: 0
    }
  }
}

// 所有场景共用配置（笔最小间隔 4 根合并K线）
const FIXTURE_CONFIG = { biMinGap: 4 }

module.exports = { FIXTURES, FIXTURE_CONFIG, buildWaveSeq, buildRangeSeq, ZIGZAG_SEQ, leg }
