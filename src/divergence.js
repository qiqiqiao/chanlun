/*!
 * src/divergence.js —— 笔背驰模块（结合大级别走势动量）
 *
 * 背驰判据（《教你炒股票》第 15/24/29 课口径的结构化实现）：
 *   1. 局部（笔级别）：同向两笔围绕笔中枢，后笔创出新高/新低，
 *      但动量强度（单位K线同向 MACD 柱面积）弱于前笔 → 笔背驰；
 *   2. 大级别（线段级别）确认：后笔所在线段与其前一同向线段比较动量——
 *      大级别动量同步衰减 → 强背驰（confirmed，反转预警权重高）；
 *      大级别动量仍在扩张 → 弱背驰（更可能是中枢震荡/回调）。
 *   3. 类型：比较区间内同向中枢 ≥2 → trend（趋背）；1 个 → consolidation（盘背）。
 *      回溯距离受 maxLookbackStrokes 限制，避免跨多个结构远距离误配。
 *
 * 动量度量：MACD 柱面积的【单位K线强度】。EMA(12/26) → DIF，DEA=DIF 的 EMA(9)，
 * hist = 2*(DIF-DEA)；区间面积只累计与移动方向同向的柱（上行取正柱、下行取
 * 负柱绝对值），再除以窗口K线数。与 rangeMomentum 同口径；逆势柱不计入，
 * 避免方向定向的净面积为负时被误判为强动量。除以时长使两笔/两线段窗口可公度。
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

  // 单步 MACD 递推（唯一实现）：prev 为处理完第 i-1 根收盘价后的状态
  // （{emaFast, emaSlow, dea}，null 表示尚未开始），返回 { cur, hist }。
  function macdStep(prev, c, kf, ks, kg) {
    if (prev === null) {
      return { cur: { emaFast: c, emaSlow: c, dea: 0 }, hist: 0 }
    }
    const emaFast = prev.emaFast + (c - prev.emaFast) * kf
    const emaSlow = prev.emaSlow + (c - prev.emaSlow) * ks
    const dif = emaFast - emaSlow
    const dea = prev.dea + (dif - prev.dea) * kg
    return { cur: { emaFast, emaSlow, dea }, hist: 2 * (dif - dea) }
  }

  // 一次遍历计算 MACD 柱序列，并返回末两根的递推状态供后续增量续算。
  // 返回 { hists, cur, prev }：cur = 第 n-1 根后的状态，prev = 第 n-2 根后的状态
  // （不存在则为 null）。全量/单步/增量三条路径共用 macdStep，避免三份递推。
  function macdHistogramState(closes, fast, slow, signal) {
    const n = closes.length
    const hists = new Array(n)
    if (n === 0) return { hists, cur: null, prev: null }
    const kf = 2 / (fast + 1)
    const ks = 2 / (slow + 1)
    const kg = 2 / (signal + 1)
    let cur = null
    let prev = null
    for (let i = 0; i < n; i++) {
      prev = cur
      const step = macdStep(cur, closes[i], kf, ks, kg)
      cur = step.cur
      hists[i] = step.hist
    }
    return { hists, cur, prev }
  }

  // MACD 柱序列：hist[i] = 2*(DIF[i] - DEA[i])，与输入收盘价等长
  function macdHistogram(closes, fast, slow, signal) {
    return macdHistogramState(closes, fast, slow, signal).hists
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

  // 动量强度：沿移动方向的 MACD 柱面积 / 窗口K线数。
  //   只累计同向柱（上行取正柱、下行取负柱的绝对值），与 rangeMomentum 同口径；
  //   逆势柱不计入（相当于逐柱“负值截 0”），避免方向定向的净面积为负时被当成
  //   强动量。归一化时长使不同长度的两笔/两线段可公度。
  function windowIntensity(hists, fromRaw, toRaw, dir) {
    const a = Math.max(0, fromRaw)
    const b = Math.min(hists.length - 1, toRaw)
    if (b < a) return 0
    return rangeMomentum(hists, a, b, dir) / (b - a + 1)
  }

  // 合并K线索引窗口 → 原始K线下标窗口
  function rawWindow(merged, fromMi, toMi) {
    const f = merged[fromMi]
    const t = merged[toMi]
    if (!f || !t) return null
    return { from: f.rawStart, to: t.rawEnd }
  }

  // 带缓存的窗口动量：windowIntensity 依赖 [fromRaw, toRaw] 内同向柱面积、窗口长度
  // 与方向。hists 只在尾部变化（dirtyFrom = 最近一次变化的最左下标），故
  // toRaw < dirtyFrom 的窗口可复用上次结果，避免每 tick 重扫整段窗口。
  // cache = { map: Map<fromRaw, Map<toRaw*2+dirBit, number>>, dirtyFrom }。
  function cachedWindowIntensity(hists, fromRaw, toRaw, dir, cache) {
    const key = toRaw * 2 + (dir === 'down' ? 1 : 0)
    if (cache && toRaw < cache.dirtyFrom) {
      const inner = cache.map.get(fromRaw)
      if (inner !== undefined) {
        const hit = inner.get(key)
        if (hit !== undefined) return hit
      }
    }
    const v = windowIntensity(hists, fromRaw, toRaw, dir)
    if (cache) {
      let inner = cache.map.get(fromRaw)
      if (inner === undefined) {
        inner = new Map()
        cache.map.set(fromRaw, inner)
      }
      inner.set(key, v)
    }
    return v
  }

  // 笔动量强度：笔端点分型的 mi 窗口映射到原始下标
  function strokeMomentum(hists, merged, s, cache) {
    if (!s.from || !s.to) return 0
    const w = rawWindow(merged, s.from.mi, s.to.mi)
    return w ? cachedWindowIntensity(hists, w.from, w.to, s.dir, cache) : 0
  }

  // 线段动量强度（大级别走势动量）：同上线段端点 mi 窗口
  function segmentMomentum(hists, merged, seg, cache) {
    if (!seg.from || !seg.to) return 0
    const w = rawWindow(merged, seg.from.mi, seg.to.mi)
    return w ? cachedWindowIntensity(hists, w.from, w.to, seg.dir, cache) : 0
  }

  // 笔所在的大级别线段：覆盖该笔的线段，否则取起点在其之前的最后一条。
  // 线段按 fromRaw 严格递增且首尾相接（toRaw[k] === fromRaw[k+1]），因此可用
  // 二分定位：k = 最后一个 fromRaw <= s.fromRaw 的下标；t = 第一个 toRaw >=
  // s.toRaw 的下标；t <= k 表示线段 t 完整覆盖该笔，否则返回 k（起笔前的最后一条）。
  function enclosingSegment(segments, s) {
    const n = segments.length
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (segments[mid].fromRaw <= s.fromRaw) lo = mid + 1
      else hi = mid
    }
    const k = lo - 1
    if (k < 0) return -1
    lo = 0
    hi = n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (segments[mid].toRaw < s.toRaw) lo = mid + 1
      else hi = mid
    }
    const t = lo
    return t <= k ? t : k
  }

  // 大级别动量对比：所在线段 vs 其前一条已完结的同向线段（segMom 为预计算动量）
  // 返回 { segmentSi, aligned, momentumRatio, fading }；无比价时 momentumRatio/fading 为 null
  function bigLevelContext(segments, segMom, segSi, strokeDir) {
    if (segSi < 0 || segSi >= segments.length) {
      return { segmentSi: -1, aligned: false, momentumRatio: null, fading: null }
    }
    const cur = segments[segSi]
    const curMom = segMom[segSi]
    let prevMom = null
    for (let k = segSi - 1; k >= 0; k--) {
      const p = segments[k]
      if (p.dir === cur.dir && p.finished) {
        prevMom = segMom[k]
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

  // 预计算每个笔的动量强度（原始K线窗口扫描总共 O(n)，避免逐笔重复扫描）
  function precomputeStrokeMoms(hists, merged, strokes, cache) {
    const n = strokes.length
    const out = new Array(n)
    for (let i = 0; i < n; i++) out[i] = strokeMomentum(hists, merged, strokes[i], cache)
    return out
  }

  // 预计算每个线段的动量强度（总 O(n)，避免大级别对比时重复扫描）
  function precomputeSegmentMoms(hists, merged, segments, cache) {
    const n = segments.length
    const out = new Array(n)
    for (let k = 0; k < n; k++) out[k] = segmentMomentum(hists, merged, segments[k], cache)
    return out
  }

  // 中枢区间查询辅助：
  //   cover[i] = 覆盖笔下标 i 的中枢下标（-1 = 无；中枢互不重叠，至多一个）
  //   centerStart 升序、centerEnd 对齐 → “起点位于 (i, j)” 用二分 O(log m)，
  //   “单一中枢覆盖 [i, j]” 用 cover O(1)。
  //   prefixUp/prefixDown 为「进入方向」前缀计数，供同向中枢计数 O(log m) 查询。
  // 与旧实现 strokeCenters.some(...) 逐字段等价（tests/verify 已交叉验证）。
  function buildCenterIndex(strokes, strokeCenters, strokeCount) {
    const n = strokeCenters.length
    const centerStart = new Array(n)
    const centerEnd = new Array(n)
    const prefixUp = new Array(n + 1)
    const prefixDown = new Array(n + 1)
    prefixUp[0] = 0
    prefixDown[0] = 0
    for (let k = 0; k < n; k++) {
      centerStart[k] = strokeCenters[k].startIndex
      centerEnd[k] = strokeCenters[k].endIndex
      const d = centerIncomingDir(strokes, strokeCenters[k])
      prefixUp[k + 1] = prefixUp[k] + (d === 'up' ? 1 : 0)
      prefixDown[k + 1] = prefixDown[k] + (d === 'down' ? 1 : 0)
    }
    const cover = new Array(strokeCount).fill(-1)
    for (let k = 0; k < n; k++) {
      const s = strokeCenters[k].startIndex
      const e = Math.min(strokeCenters[k].endIndex, strokeCount - 1)
      for (let i = s; i <= e; i++) cover[i] = k
    }
    return { centerStart, centerEnd, cover, prefixUp, prefixDown }
  }

  // 两笔 [i, j] 之间是否存在笔中枢（与旧 .some 语义一致）
  function hasCenterBetween(idx, i, j) {
    // A：中枢起点位于 (i, j)
    let lo = 0
    let hi = idx.centerStart.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (idx.centerStart[mid] <= i) lo = mid + 1
      else hi = mid
    }
    if (lo < idx.centerStart.length && idx.centerStart[lo] < j) return true
    // B：单一延伸中枢覆盖 [i, j]
    const ci = idx.cover[i]
    return ci !== -1 && idx.centerEnd[ci] >= j
  }

  // 中枢方向：进入中枢前最后一笔的方向（与绘制层的 centerDirOf 同口径）。
  // 中枢起点为 0 时没有“进入前”的笔，退回中枢首笔方向。
  function centerIncomingDir(strokes, center) {
    const prev = strokes[center.startIndex - 1]
    if (prev) return prev.dir
    const first = strokes[center.startIndex]
    return first ? first.dir : null
  }

  // 两笔比较区间 [i, j] 内同向中枢数量：
  //   缠论趋势背驰要求至少两个同向中枢（趋势），只有一个中枢属于盘整背驰。
  // 中枢与比较区间相交即计入；方向按进入中枢的走势判定。
  // centerScan 生成的中枢 startIndex / endIndex 均严格递增且互不重叠，因此
  // 相交集合恰为 [首个 endIndex >= i, 首个 startIndex > j)，两次二分定位后
  // 用方向前缀和相减即可，替代旧版逐事件遍历全部中枢的 O(k·m)。
  function countSameDirectionCenters(idx, i, j, dir) {
    const m = idx.centerStart.length
    if (!m) return 0
    let lo = 0
    let hi = m
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (idx.centerEnd[mid] < i) lo = mid + 1
      else hi = mid
    }
    const from = lo
    lo = 0
    hi = m
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (idx.centerStart[mid] <= j) lo = mid + 1
      else hi = mid
    }
    const to = lo
    if (to <= from) return 0
    const prefix = dir === 'up' ? idx.prefixUp : idx.prefixDown
    return prefix[to] - prefix[from]
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
   *     - 动量强度为 0 的同向笔（如早期反转笔尚无同向柱）不参与比较，继续向前
   *       找有实际同向动量的同向笔；仍受“极值未被超越即终止”约束。
   *   动量强度比 = 强度(j)/强度(i) < minMomentumDrop → 局部背驰成立。
   *   大级别确认：aligned 且 fading===true → confirmed（强背驰）。
   */
  // 背驰计算上下文：结构输入 + 预计算动量 + 中枢索引。全量计算与实时尾部刷新
  // 共用同一套 divergenceAt，避免两条路径出现口径分歧。analyzer 在结构未变时
  // 持久化它，只更新被脏 hists 影响的尾部窗口。
  function createDivergenceContext(strokes, segments, strokeCenters, merged, closes, cfg, preHists, momCache) {
    const dcfg = cfg.divergence
    // 允许外部传入已增量维护好的 MACD 柱序列（analyzer 增量链路），
    // 未传时按纯函数口径全量计算，保证两条路径逐字段一致。
    const hists = preHists !== undefined
      ? preHists
      : macdHistogram(closes, dcfg.macdFast, dcfg.macdSlow, dcfg.macdSignal)
    return {
      strokes, segments, merged, dcfg, hists, momCache,
      maxLookback: dcfg.maxLookbackStrokes > 0 ? dcfg.maxLookbackStrokes : Infinity,
      strokeMom: precomputeStrokeMoms(hists, merged, strokes, momCache),
      segMom: precomputeSegmentMoms(hists, merged, segments, momCache),
      // 同向中枢计数（趋背/盘背判定）在 requireCenter 关闭时同样需要，
      // 故索引始终构建；hasCenterBetween 仍只在 requireCenter 时使用。
      centerIdx: buildCenterIndex(strokes, strokeCenters, strokes.length)
    }
  }

  // 单根笔 j 的背驰事件（循环体抽成函数，全量与增量尾部重算共用）。
  function divergenceAt(ctx, j) {
    const { strokes, segments, dcfg, maxLookback, strokeMom, segMom, centerIdx } = ctx
    const s = strokes[j]
    const up = s.dir === 'up'
    let prev = -1
    const minI = Math.max(0, j - maxLookback)
    for (let i = j - 2; i >= minI; i -= 2) {
      const p = strokes[i]
      const beyond = up ? s.toValue > p.toValue : s.toValue < p.toValue
      if (!beyond) break
      if (dcfg.requireCenter && !hasCenterBetween(centerIdx, i, j)) continue
      // 同向面积口径下，早期反转笔可能没有任何同向柱（动量为 0）。这种笔
      // 没有“力度”可比，继续向前找有实际同向动量的同向笔。
      if (strokeMom[i] <= 0) continue
      prev = i
      break
    }
    if (prev < 0) return null
    const momCur = strokeMom[j]
    const momPrev = strokeMom[prev]
    const ratio = momCur / momPrev
    if (ratio >= dcfg.minMomentumDrop) return null
    const bigLevel = bigLevelContext(segments, segMom, enclosingSegment(segments, s), s.dir)
    const confirmed = bigLevel.aligned && bigLevel.fading === true
    // 趋势背驰 vs 盘整背驰：同向中枢 ≥2 才是趋势背驰；1 个（或 requireCenter
    // 关闭时 0 个）为盘整背驰。strong 仍表示大级别动量是否同步衰减，
    // 两者是不同维度，不能再用 strength 冒充“趋背/盘背”。
    const trendCenterCount = countSameDirectionCenters(centerIdx, prev, j, s.dir)
    return {
      si: j,
      kind: up ? 'top' : 'bottom',
      dir: s.dir,
      prevSi: prev,
      lookback: j - prev,
      rawIndex: s.toRaw,
      value: s.toValue,
      provisional: j === strokes.length - 1,
      momentum: { current: momCur, previous: momPrev, ratio },
      bigLevel,
      strength: confirmed ? 'strong' : 'weak',
      confirmed,
      divergenceType: trendCenterCount >= 2 ? 'trend' : 'consolidation',
      trendCenterCount
    }
  }

  function calcDivergencesWithContext(ctx) {
    const out = []
    for (let j = 2; j < ctx.strokes.length; j++) {
      const ev = divergenceAt(ctx, j)
      if (ev) out.push(ev)
    }
    return out
  }

  function calcDivergences(strokes, segments, strokeCenters, merged, closes, cfg, preHists, momCache) {
    return calcDivergencesWithContext(
      createDivergenceContext(strokes, segments, strokeCenters, merged, closes, cfg, preHists, momCache)
    )
  }

  // 结构（笔/线段/中枢/merged）完全未变、仅尾部 hists 变化时的增量刷新。
  // 调用方必须保证结构未变；dirtyFrom 为 hists 变化的最左原始下标。
  //   1) 只重算 toRaw >= dirtyFrom 的窗口动量（momCache 对这些窗口自动失效）；
  //   2) 倒着找出需要重算的最小笔下标：自身动量脏，或所在线段动量脏
  //      （bigLevel 依赖所在线段及其前一同向线段的 segMom）；
  //   3) 前缀事件逐字段不变，直接复用；只重算尾部事件。
  // toRaw 递增、enclosingSegment 随笔下标单调不减，故倒扫遇到第一个「两者都
  // 未变」的笔即可停止，更前面的笔必然不受影响。
  function refreshDivergenceTail(ctx, prevResult, dirtyFrom) {
    const { strokes, segments, hists, merged, momCache, strokeMom, segMom } = ctx
    const n = strokes.length
    if (!n) return []
    let dirtySegFrom = segments.length
    for (let k = segments.length - 1; k >= 0 && segments[k].toRaw >= dirtyFrom; k--) {
      segMom[k] = segmentMomentum(hists, merged, segments[k], momCache)
      dirtySegFrom = k
    }
    for (let k = n - 1; k >= 0 && strokes[k].toRaw >= dirtyFrom; k--) {
      strokeMom[k] = strokeMomentum(hists, merged, strokes[k], momCache)
    }
    let fromSi = n
    while (fromSi > 2) {
      const s = strokes[fromSi - 1]
      if (s.toRaw < dirtyFrom && enclosingSegment(segments, s) < dirtySegFrom) break
      fromSi--
    }
    const out = []
    for (const d of prevResult) {
      if (d.si >= fromSi) break
      out.push(d)
    }
    for (let j = Math.max(2, fromSi); j < n; j++) {
      const ev = divergenceAt(ctx, j)
      if (ev) out.push(ev)
    }
    return out
  }

  const api = {
    macdHistogram, macdStep, macdHistogramState, rangeMomentum, windowIntensity,
    calcDivergences, createDivergenceContext, divergenceAt, calcDivergencesWithContext,
    refreshDivergenceTail
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    global.Chanlun = global.Chanlun || {}
    global.Chanlun.divergence = api
  }
})(typeof window !== 'undefined' ? window : globalThis)
