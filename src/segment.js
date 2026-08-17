/*!
 * src/segment.js —— 线段模块（特征序列法，依据《教你炒股票》第 67 / 71 课）
 *
 *   向上线段：特征序列为向下笔，只考察顶分型
 *   向下线段：特征序列为向上笔，只考察底分型
 *
 *   出现分型后分两种情况：
 *     第一种情况：分型第一、二元素间无缺口 → 线段立即在该分型处终结
 *     第二种情况：分型第一、二元素间有缺口 → 等待新线段特征序列出现分型确认
 *       - 确认：旧线段终结于待确认点，新线段从该点开始（含新线段的特征序列）
 *       - 否定：出现比待确认点更极端的笔 → 待确认点失效，旧线段继续。
 *
 *   segmentScan(strokes, segStart) 可从任意已确认起点恢复扫描（增量重放）。
 *
 * ── 第二种情况（缺口）的否定处理 ───────────────────────────────
 * 待确认期间到达的笔同时属于两种解读：
 *   - 新线段方向（= 旧线段特征方向）的笔：可能是旧线段特征序列的延续；
 *   - 旧线段方向（= 新线段特征方向）的笔：构成新线段特征序列（待确认分型）。
 *
 * 旧版实现被否定时 `features = features.concat(pendingFeatures)`，这是错的：
 * pendingFeatures 是“新线段方向”的笔（对继续延伸的旧线段而言是非特征元素），
 * 而真正的旧线段特征元素（新线段方向的笔）在待确认期间被跳过、丢失了。
 * 特征序列被污染/缺失会导致顶底分型漏判或误判（线段终点漂移）。
 *
 * 正确做法（本实现）：被否定时把待确认期间“被跳过的笔”按正常分支重放——
 * 旧线段方向的笔进特征序列（并立即做分型/缺口判断），新线段方向的笔跳过；
 * 与“该缺口分型从未发生”等价。触发该分型的笔已在特征序列中、不重放，
 * 因此不会再次进入同一个第二种情况（链式缺口场景由后续重放自然覆盖）。
 * ────────────────────────────────────────────────────────────────
 */
(function (global) {
  'use strict'

  // 三笔是否有共同重叠区间（线段起点判定）
  function overlap3(a, b, c) {
    const maxLow = Math.max(a.low, b.low, c.low)
    const minHigh = Math.min(a.high, b.high, c.high)
    return maxLow < minHigh
  }

  // 特征序列元素：仅保留 strokeIndex 与该元素的高/低（一笔看成一根虚拟K线）
  function pushFeature(features, s, segDir) {
    let feature = { strokeIndex: s.si, high: s.high, low: s.low }
    if (features.length === 0) {
      features.push(feature)
      return features
    }
    const lastF = features[features.length - 1]
    const contained =
      (feature.high <= lastF.high && feature.low >= lastF.low) ||
      (feature.high >= lastF.high && feature.low <= lastF.low)
    if (!contained) {
      features.push(feature)
      return features
    }
    // 71课：包含方向看“前两个元素的关系”（向上：取高高低高；向下：取低低高低）
    const prev = features.length >= 2 ? features[features.length - 2] : null
    let up = null
    if (prev) {
      if (feature.high > prev.high) up = true
      else if (feature.low < prev.low) up = false
    }
    if (up === null) up = segDir === 'up'
    if (up) {
      feature = { strokeIndex: s.si, high: Math.max(lastF.high, feature.high), low: Math.max(lastF.low, feature.low) }
    } else {
      feature = { strokeIndex: s.si, high: Math.min(lastF.high, feature.high), low: Math.min(lastF.low, feature.low) }
    }
    features[features.length - 1] = feature
    return features
  }

  // 在特征序列中查找顶分型(向上线段)/底分型(向下线段)，返回中间元素或 null
  function findFeatureFractal(features, segDir) {
    if (features.length < 3) return null
    const f0 = features[features.length - 3]
    const f1 = features[features.length - 2]
    const f2 = features[features.length - 1]
    if (segDir === 'up') {
      if (f1.high > f0.high && f1.high > f2.high && f1.low > f0.low && f1.low > f2.low) return f1
    } else {
      if (f1.low < f0.low && f1.low < f2.low && f1.high < f0.high && f1.high < f2.high) return f1
    }
    return null
  }

  // 从 segStart（已确认线段终点所在笔的索引）开始恢复扫描
  function segmentScan(strokes, segStart) {
    const segments = []
    const confirmedSis = [] // 每次确认线段的终点笔索引（供增量锚点维护）
    const n = strokes.length

    let segDir = strokes[segStart].dir
    let features = [] // 当前线段的特征序列（标准特征序列）
    let pending = null // 第二种情况的待确认点 { strokeIndex, newDir }
    let pendingFeatures = [] // 新线段的特征序列
    let pendingBuffer = [] // 待确认期间被跳过的新线段方向笔（否定时按正常分支重放）
    let j = segStart + 1

    // 从特征分型的中间元素取线段终点（上下线段都是该元素起点处为极值点）
    const endPointOf = (si) => {
      const s = strokes[si]
      return { point: s.from, raw: s.fromRaw, high: s.from.high, low: s.from.low }
    }

    while (j < n) {
      const s = strokes[j]

      // ---- 第二种情况：正在等待新线段特征序列的分型确认 ----
      if (pending) {
        if (s.dir === pending.newDir) {
          // 新线段方向的笔：既可能是旧线段特征序列的延续（否定时需重放），先记录
          pendingBuffer.push(s)
          j++
          continue
        }
        // 该笔既可能是新线段的特征元素，也可能否定待确认点
        const negExtreme = segDir === 'up'
          ? s.high > strokes[pending.strokeIndex].from.high
          : s.low < strokes[pending.strokeIndex].from.low
        if (negExtreme) {
          // 待确认点被否定，原线段继续：重放待确认期间被跳过的笔。
          // 触发分型的笔已在 features 中（不重放），避免再次进入同一分型；
          // 重放会重新做分型/缺口判断，等价于“该缺口分型从未发生”。
          const replayFrom = j - pendingBuffer.length
          pending = null
          pendingFeatures = []
          pendingBuffer = []
          j = replayFrom
          continue
        }
        // 新线段的特征元素（方向与 newDir 相反，即与 segDir 相同）
        pushFeature(pendingFeatures, s, pending.newDir)
        const pF = findFeatureFractal(pendingFeatures, pending.newDir)
        if (pF) {
          // 确认：旧线段终结于待确认点，新线段终结于确认分型处
          const ss = strokes[segStart]
          const pp = endPointOf(pending.strokeIndex)
          segments.push({
            dir: segDir,
            from: ss.from,
            to: pp.point,
            fromRaw: ss.fromRaw,
            toRaw: pp.raw,
            high: Math.max(ss.from.high, pp.high),
            low: Math.min(ss.from.low, pp.low),
            finished: true
          })
          confirmedSis.push(pending.strokeIndex)
          const cp = endPointOf(pF.strokeIndex)
          segments.push({
            dir: pending.newDir,
            from: pp.point,
            to: cp.point,
            fromRaw: pp.raw,
            toRaw: cp.raw,
            high: Math.max(pp.high, cp.high),
            low: Math.min(pp.low, cp.low),
            finished: true
          })
          confirmedSis.push(pF.strokeIndex)
          // 从确认分型笔开始新的线段
          segStart = pF.strokeIndex
          segDir = strokes[segStart].dir
          features = []
          pending = null
          pendingFeatures = []
          pendingBuffer = []
          j = segStart + 1
          continue
        }
        j++
        continue
      }

      // ---- 第一种情况：正常构建特征序列 ----
      if (s.dir === segDir) {
        j++
        continue
      }
      pushFeature(features, s, segDir)
      const f1 = findFeatureFractal(features, segDir)
      if (f1) {
        const f0 = features[features.length - 3]
        // 第一、二元素间是否存在缺口
        const gap = f1.low > f0.high || f1.high < f0.low
        if (!gap) {
          // 第一种情况：立即终结
          const ss = strokes[segStart]
          const pp = endPointOf(f1.strokeIndex)
          segments.push({
            dir: segDir,
            from: ss.from,
            to: pp.point,
            fromRaw: ss.fromRaw,
            toRaw: pp.raw,
            high: Math.max(ss.from.high, pp.high),
            low: Math.min(ss.from.low, pp.low),
            finished: true
          })
          confirmedSis.push(f1.strokeIndex)
          segStart = f1.strokeIndex
          segDir = strokes[segStart].dir
          features = []
          j = segStart + 1
          continue
        } else {
          // 第二种情况：进入待确认状态
          pending = { strokeIndex: f1.strokeIndex, newDir: strokes[f1.strokeIndex].dir }
          pendingFeatures = []
          pendingBuffer = []
          j++
          continue
        }
      }
      j++
    }

    // 尾部未完成的线段
    if (segStart < n) {
      const ss = strokes[segStart]
      const es = strokes[n - 1]
      segments.push({
        dir: segDir,
        from: ss.from,
        to: es.to,
        fromRaw: ss.fromRaw,
        toRaw: es.toRaw,
        high: Math.max(ss.from.high, es.to.high),
        low: Math.min(ss.from.low, es.to.low),
        finished: false
      })
    }
    return { segments, confirmedSis }
  }

  // 全量：找第一个“前三笔有重叠”的起点，再从该起点扫描
  function calcSegments(strokes, cfg) {
    const n = strokes.length
    if (n < 3) return []
    let start = 0
    while (start + 2 < n) {
      if (overlap3(strokes[start], strokes[start + 1], strokes[start + 2])) break
      start++
    }
    if (start + 2 >= n) return []
    return segmentScan(strokes, start).segments
  }

  // 全量（含确认锚点），供 createAnalyzer 初始化使用
  function calcSegmentsFull(strokes, cfg) {
    const n = strokes.length
    if (n < 3) return { segments: [], confirmedSis: [] }
    let start = 0
    while (start + 2 < n) {
      if (overlap3(strokes[start], strokes[start + 1], strokes[start + 2])) break
      start++
    }
    if (start + 2 >= n) return { segments: [], confirmedSis: [] }
    return segmentScan(strokes, start)
  }

  const api = { overlap3, pushFeature, findFeatureFractal, segmentScan, calcSegments, calcSegmentsFull }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    global.Chanlun = global.Chanlun || {}
    global.Chanlun.segment = api
  }
})(typeof window !== 'undefined' ? window : globalThis)
