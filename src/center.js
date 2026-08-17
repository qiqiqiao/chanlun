/*!
 * src/center.js —— 中枢模块
 *
 * 至少 minElements 个元素（笔/线段）有共同重叠区间，之后延伸。
 *   centerScan 可从任意扫描位置续接（增量重放尾部）
 */
(function (global) {
  'use strict'

  function centerScan(items, startPos, minElements) {
    const centers = []
    const n = items.length
    let i = startPos
    while (i + minElements <= n) {
      let zsLow = items[i].low
      let zsHigh = items[i].high
      for (let t = 1; t < minElements; t++) {
        const e = items[i + t]
        zsLow = Math.max(zsLow, e.low)
        zsHigh = Math.min(zsHigh, e.high)
      }
      if (zsLow < zsHigh) {
        let j = i + minElements
        // 后续元素与中枢区间有重叠 → 中枢延伸
        while (j < n) {
          const s = items[j]
          if (s.low < zsHigh && s.high > zsLow) {
            j++
          } else {
            break
          }
        }
        centers.push({
          startIndex: i,
          endIndex: j - 1,
          startRaw: items[i].fromRaw,
          endRaw: items[j - 1].toRaw,
          zsLow,
          zsHigh
        })
        i = j
      } else {
        i++
      }
    }
    return centers
  }

  function calcCenters(items, cfg) {
    return centerScan(items, 0, cfg.center.minElements)
  }

  const api = { centerScan, calcCenters }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    global.Chanlun = global.Chanlun || {}
    global.Chanlun.center = api
  }
})(typeof window !== 'undefined' ? window : globalThis)
