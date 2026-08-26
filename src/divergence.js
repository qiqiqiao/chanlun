/*!
 * src/divergence.js —— 笔背驰模块（结合大级别走势动量）
 *
 * 背驰判据（《教你炒股票》第 15/24/29 课口径的结构化实现）：
 *   1. 局部（笔级别）：同向两笔围绕笔中枢，后笔创出新高/新低，
 *      但动量强度（单位K线 MACD 柱净面积）弱于前笔 → 笔背驰；
 *   2. 大级别（线段级别）确认：后笔所在线段与其前一同向线段比较动量——
 *      大级别动量同步衰减 → 强背驰（confirmed，反转预警权重高）；
 *      大级别动量仍在扩张 → 弱背驰（更可能是中枢震荡/回调）。
 *
 * 动量度量：MACD 柱面积的【单位K线强度】。EMA(12/26) → DIF，DEA=DIF 的 EMA(9)，
 * hist = 2*(DIF-DEA)；区间净面积 = Σhist 按移动方向定向后取绝对值，
 * 再除以窗口K线数。除以时长是为了两笔/两线段窗口可公度（经典“斜率变缓”
 * 口径），取绝对值使 0 轴上下穿越后的同向移动仍可比。
 * 强度比 = 当前强度 / 前同向笔强度，< minMomentumDrop 判背驰。
 *
 * 坐标系：MACD 在【原始K线收盘价】上计算；笔/线段的合并K线窗口
 * 通过 merged[mi].rawStart/rawEnd 映射回原始下标。
 *
 * calcDivergences 为纯函数全量计算（O(n)，与线段/中枢重扫同级开销），
 * 由 analyzer 增量链路与 analyze() 共用，保证两条路径逐字段一致。
 */
(function (global) {
  'use strict'

  // MACD 柱序列：hist[i] = 2*(DIF[i] - DEA[i])，与输入收盘价等长
  function macdHistogram(closes, fast, slow, signal) {
    const n = closes.length
    const hists = new Array(n)
    if (n === 0) return hists
    const kf = 2 / (fast + 1)
    const ks = 2 / (slow + 1)
    const kg = 2 / (signal + 1)
    let emaFast = closes[0]
    let emaSlow = closes[0]
    let dea = 0
    for (let i = 0; i < n; i++) {
        const c = closes[i]
        if (i > 0) {
            emaFast += (c - emaFast) * kf
            emaSlow += (c - emaSlow) * ks
        }
        const dif = emaFast - emaSlow
        if (i === 0) {
            dea = dif
        } else {
            dea += (dif - dea) * kg
        }
        hists[i] = 2 * (dif - dea)
    }
    return hists
  }

  // 区间 [fromRaw, toRaw] 内同方向 MACD 柱面积（dir: 'up' 取正柱和，'down' 取负柱绝对值和）
  function rangeMomentum(hists, fromRaw, toRaw, dir) {
    let sum = 0
    const a = Math.max(0, fromRaw)
    const b = Math.min(hists.length - 1, toRaw)
    for (let i = a; i <= b; i++) {
      const h = hists[i]
      if (dir === 'up' ? h > 0 : h < 0) sum += dir === 'up' ? h : -h
    }
    return sum
  }

  // 动量强度：按移动方向定向的 MACD 柱净面积绝对值 / 窗口K线数。
  //   定向：上行取 +Σhist、下行取 -Σhist（下跌趋势中的反弹笔同样可测）；
  //   归一化时长使不同长度的两笔/两线段可公度；取绝对值兼容 0 轴穿越。
  function windowIntensity(hists, fromRaw, toRaw, dir) {
    const a = Math.max(0, fromRaw)
    const b = Math.min(hists.length - 1, toRaw)
    if (b < a) return 0
    let sum = 0
    for (let i = a; i <= b; i++) sum += hists[i]
    return Math.abs(dir === 'up' ? sum : -sum) / (b - a + 1)
  }

  // 合并K线索引窗口 → 原始K线下标窗口
  function rawWindow(merged, fromMi, toMi) {
    const f = merged[fromMi]
    const t = merged[toMi]
    if (!f || !t) return null
    return { from: f.rawStart, to: t.rawEnd }
  }

  // 笔动量强度：笔端点分型的 mi 窗口映射到原始下标
  function strokeMomentum(hists, merged, s) {
    const w = rawWindow(merged, s.from.mi, s.to.mi)
    return w ? windowIntensity(hists, w.from, w.to, s.dir) : 0
  }

  // 线段动量强度（大级别走势动量）：同上线段端点 mi 窗口
  function segmentMomentum(hists, merged, seg) {
    const w = rawWindow(merged, seg.from.mi, seg.to.mi)
    return w ? windowIntensity(hists, w.from, w.to, seg.dir) : 0
  }

  // 笔所在的大级别线段：覆盖该笔的线段，否则取起点在其之前的最后一条
  function enclosingSegment(segments, s) {
    let hit = -1
    for (let k = 0; k < segments.length; k++) {
      const seg = segments[k]
      if (seg.fromRaw <= s.fromRaw && s.toRaw <= seg.toRaw) return k
      if (seg.fromRaw <= s.fromRaw) hit = k
    }
    return hit
  }

  // 大级别动量对比：所在线段 vs 其前一条已完结的同向线段
  // 返回 { segmentSi, aligned, momentumRatio, fading }；无比价时 momentumRatio/fading 为 null
  function bigLevelContext(hists, merged, segments, segSi, strokeDir) {
    if (segSi < 0 || segSi >= segments.length) {
      return { segmentSi: -1, aligned: false, momentumRatio: null, fading: null }
    }
    const cur = segments[segSi]
    const curMom = segmentMomentum(hists, merged, cur)
    let prevMom = null
    for (let k = segSi - 1; k >= 0; k--) {
      const p = segments[k]
      if (p.dir === cur.dir && p.finished) {
        prevMom = segmentMomentum(hists, merged, p)
        break
      }
    }
    const ratio = prevMom !== null && prevMom > 0 ? curMom / prevMom : null
    return {
      segmentSi: segSi,
      aligned: cur.dir === strokeDir,
      momentumRatio: ratio,
      fading: ratio !== null ? ratio < 1 : null
    }
  }

  /*
   * 笔背驰检测：
   *   对每根笔 j 向前找同向笔 i，满足：
   *     - 极值超越：up 后笔 toValue 更高 / down 后笔 toValue 更低；
   *       遇到第一根未被超越的同向笔即终止（趋势未延伸，无背驰比较意义，
   *       也避免跨段远距离误配对；两中枢趋势可跨过中间同向笔）；
   *     - requireCenter 时两笔之间存在笔中枢：中枢起于两笔之间
   *       （c.startIndex ∈ (i, j)，允许延伸越过 j —— “离开段尝试”的实时判定），
   *       或中枢整体覆盖两笔区间（单一延伸大中枢内的盘整背驰）。
   *   动量强度比 = 强度(j)/强度(i) < minMomentumDrop → 局部背驰成立。
   *   大级别确认：aligned 且 fading===true → confirmed（强背驰）。
   */
  function calcDivergences(strokes, segments, strokeCenters, merged, closes, cfg) {
    const dcfg = cfg.divergence
    const hists = macdHistogram(closes, dcfg.macdFast, dcfg.macdSlow, dcfg.macdSignal)
    const out = []
    for (let j = 2; j < strokes.length; j++) {
      const s = strokes[j]
      const up = s.dir === 'up'
      let prev = -1
      for (let i = j - 2; i >= 0; i -= 2) {
        const p = strokes[i]
        const beyond = up ? s.toValue > p.toValue : s.toValue < p.toValue
        if (!beyond) break
        if (dcfg.requireCenter) {
          const hasCenter = strokeCenters.some(
            (c) =>
              (c.startIndex > i && c.startIndex < j) ||
              (c.startIndex <= i && c.endIndex >= j)
          )
          if (!hasCenter) continue
        }
        prev = i
        break
      }
      if (prev < 0) continue
      const p = strokes[prev]
      const momCur = strokeMomentum(hists, merged, s)
      const momPrev = strokeMomentum(hists, merged, p)
      if (momPrev <= 0) continue
      const ratio = momCur / momPrev
      if (ratio >= dcfg.minMomentumDrop) continue
      const bigLevel = bigLevelContext(
        hists,
        merged,
        segments,
        enclosingSegment(segments, s),
        s.dir
      )
      const confirmed = bigLevel.aligned && bigLevel.fading === true
      out.push({
        si: j,
        kind: up ? 'top' : 'bottom',
        dir: s.dir,
        prevSi: prev,
        rawIndex: s.toRaw,
        value: s.toValue,
        provisional: j === strokes.length - 1,
        momentum: { current: momCur, previous: momPrev, ratio },
        bigLevel,
        strength: confirmed ? 'strong' : 'weak',
        confirmed
      })
    }
    return out
  }

  const api = { macdHistogram, rangeMomentum, calcDivergences }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    global.Chanlun = global.Chanlun || {}
    global.Chanlun.divergence = api
  }
})(typeof window !== 'undefined' ? window : globalThis)
