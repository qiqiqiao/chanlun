/*!
 * src/merge.js —— 包含关系处理模块
 *
 * 把存在包含关系的K线合并，得到“缠论K线”。
 *   mergeBars  = 全量；resumeMerge = 从已有 merged 续接（增量/回退重放共用）
 *   dirs[i] 记录“处理完 merged[i] 后的方向”，增量续接时从此恢复
 *   hiIdx/loIdx 记录贡献合并K线最高/最低价的原始K线下标（笔端点定位用）
 *
 * 合并方向规则（《教你炒股票》第 65 课）：
 *   向上趋势：包含时取更高的高点与更高的低点（高高）
 *   向下趋势：包含时取更低的高点与更低的低点（低低）
 *   方向未知：保留更大的区间
 */
(function (global) {
  'use strict'

  function resumeMerge(merged, dirs, klines, startIndex) {
    let direction = dirs.length ? dirs[dirs.length - 1] : 0
    const baseLen = merged.length
    let pushedCount = 0
    let lastUpdated = false

    for (let i = 0; i < klines.length; i++) {
      const k = klines[i]
      const gi = startIndex + i
      if (merged.length === 0) {
        merged.push({ high: k.high, low: k.low, rawIndices: [gi], hiIdx: gi, loIdx: gi })
        dirs.push(0)
        pushedCount++
        continue
      }
      const last = merged[merged.length - 1]
      const contained =
        (k.high >= last.high && k.low <= last.low) ||
        (k.high <= last.high && k.low >= last.low)
      if (contained) {
        const prevHigh = last.high
        const prevLow = last.low
        if (direction === 1) {
          // 向上趋势：包含时取更高的高点与更高的低点
          last.high = Math.max(last.high, k.high)
          last.low = Math.max(last.low, k.low)
        } else if (direction === -1) {
          // 向下趋势：包含时取更低的高点与更低的低点
          last.high = Math.min(last.high, k.high)
          last.low = Math.min(last.low, k.low)
        } else {
          // 方向未知：保留更大的区间
          last.high = Math.max(last.high, k.high)
          last.low = Math.min(last.low, k.low)
        }
        // 记录真正贡献极值的原始K线下标（分型/笔端点必须落在影线尖上）。
        // 相等时保留原下标，保证回退重放与全量合并的结果一致。
        if (last.high !== prevHigh) last.hiIdx = gi
        if (last.low !== prevLow) last.loIdx = gi
        last.rawIndices.push(gi)
        lastUpdated = true
      } else {
        direction = k.high > last.high ? 1 : -1
        merged.push({ high: k.high, low: k.low, rawIndices: [gi], hiIdx: gi, loIdx: gi })
        dirs.push(direction)
        pushedCount++
      }
    }

    // 重算受影响元素的 raw 元数据（被更新的 last 及之后）
    const metaFrom = Math.max(0, Math.min(baseLen - 1, merged.length - 1))
    for (let i = metaFrom; i < merged.length; i++) {
      const b = merged[i]
      b.rawMiddle = b.rawIndices[Math.floor(b.rawIndices.length / 2)]
      b.rawStart = b.rawIndices[0]
      b.rawEnd = b.rawIndices[b.rawIndices.length - 1]
    }
    return { mergeDir: direction, pushedCount, lastUpdated, baseLen }
  }

  function mergeBars(klineDataList) {
    const merged = []
    const dirs = []
    resumeMerge(merged, dirs, klineDataList, 0)
    return { merged, dirs }
  }

  const api = { resumeMerge, mergeBars }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    global.Chanlun = global.Chanlun || {}
    global.Chanlun.merge = api
  }
})(typeof window !== 'undefined' ? window : globalThis)
