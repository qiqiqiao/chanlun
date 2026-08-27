/*!
 * src/analyzer.js —— 增量计算模块
 *
 * 首次全量，之后 update() 精确增量 / updateLast() 回退重放。
 *   分层锚点：
 *     - merge/fractals/strokes 精确增量（O(新K线数)）
 *     - updateLast：unmerge 回退末根对 merged 的贡献后续接新值（merge 层
 *       增量），分型窗口重判、笔公共前缀重放
 *     - segments 全量重扫（锚点重扫无法覆盖“新K线推翻旧 pending/待确认段”的
 *       连锁聚合，而线段/中枢数量少，全量重扫开销可接受，且彻底避免锚漂移）
 *     - centers 全量重扫
 *     - divergences 依赖笔+线段+笔中枢，随之上游重算后全量重算（O(n) 纯函数）
 *   一致性：增量结果与 analyze(全部数据) 逐字段一致（tests 覆盖）
 *
 * 依赖注入：本模块以 core（Chanlun 命名空间）为工厂参数，
 * 浏览器中由 src/analyzer.js 加载时用全局 Chanlun 实例化，
 * Node 中由 chanlun.js 装配后调用工厂。
 */
(function (global) {
  'use strict'

  function createAnalyzerModule(core) {
    const { normalizeConfig } = core.config
    const { resumeMerge, mergeBars } = core.merge
    const { resumeFractals, rebuildFilteredFractals } = core.fractal
    const { createStrokeMachine } = core.stroke
    const { calcSegmentsFull } = core.segment
    const { calcCenters } = core.center
    const { calcDivergences } = core.divergence

    function createAnalyzer(config) {
      const cfg = normalizeConfig(config)
      let raw = [] // 完整原始K线（updateLast 回退重放需要）
      let closes = [] // 与 raw 对齐的收盘价缓存（背驰 MACD 用，避免每次重算时 map 分配）
      let merged = []
      let dirs = []
      let fxAll = [] // 过滤后的分型流（喂给笔状态机）
      let machine = null
      let anchors = [] // 线段确认锚点：已确认线段的终点笔索引（递增）
      let segments = []
      let strokeCenters = []
      let segmentCenters = []
      let divergences = []
      let dataLen = 0
      let centerStrokeLastStart = -1 // 最后一个笔中枢的 startIndex（-1 = 无）
      let centerSegmentLastStart = -1
      let prevFilteredFxs = [] // 上轮重建后的过滤分型流（计算公共前缀）
      const fxFracEq = (a, b) => a.mi === b.mi && a.type === b.type

      const strokes = () => (machine ? machine.state.strokes : [])

      function computeResult() {
        return {
          merged,
          fractals: machine ? machine.state.endpoints : [],
          strokes: machine ? machine.state.strokes : [],
          segments,
          strokeCenters,
          segmentCenters,
          divergences,
          dataLen
        }
      }

      function reset() {
        raw = []
        closes = []
        merged = []
        dirs = []
        fxAll = []
        machine = null
        anchors = []
        segments = []
        strokeCenters = []
        segmentCenters = []
        divergences = []
        dataLen = 0
        centerStrokeLastStart = -1
        centerSegmentLastStart = -1
        prevFilteredFxs = []
      }

      function fullInit(bars) {
        const n = bars.length
        // 一趟拷贝同时构建 raw 与 closes（旧实现 slice + map 两趟两次分配）
        const newRaw = new Array(n)
        const newCloses = new Array(n)
        for (let i = 0; i < n; i++) {
          newRaw[i] = bars[i]
          newCloses[i] = bars[i].close
        }
        raw = newRaw
        closes = newCloses
        const m = mergeBars(raw)
        merged = m.merged
        dirs = m.dirs
        fxAll = []
        resumeFractals(fxAll, merged, 1, cfg) // 原始分型流（不含交替过滤）
        const initFiltered = rebuildFilteredFractals(fxAll)
        prevFilteredFxs = initFiltered
        machine = createStrokeMachine(cfg.bi.minGap)
        machine.replay(initFiltered, 0)
        const r = calcSegmentsFull(strokes(), cfg)
        segments = r.segments
        anchors = r.confirmedSis
        strokeCenters = calcCenters(strokes(), cfg)
        segmentCenters = calcCenters(segments, cfg)
        centerStrokeLastStart = strokeCenters.length ? strokeCenters[strokeCenters.length - 1].startIndex : -1
        centerSegmentLastStart = segmentCenters.length ? segmentCenters[segmentCenters.length - 1].startIndex : -1
        recalcDivergences()
        dataLen = bars.length
      }

      // 找到两个数组第一个不同元素的下标（公共前缀长度即“变化起点”）
      function firstDiffIndex(prev, next, eq) {
        const m = Math.min(prev.length, next.length)
        for (let i = 0; i < m; i++) {
          if (!eq(prev[i], next[i])) return i
        }
        return m
      }

      const segEq = (a, b) =>
        a.dir === b.dir && a.fromRaw === b.fromRaw && a.toRaw === b.toRaw && a.finished === b.finished

      // 笔背驰依赖笔+线段+笔中枢+原始收盘价，随上游全量重算（纯函数 O(n)）
      function recalcDivergences() {
        divergences = calcDivergences(
          strokes(),
          segments,
          strokeCenters,
          merged,
          closes,
          cfg
        )
      }

      // 分型重判 → 交替过滤重建 → 笔重放 → 线段/中枢重扫（增量核心）
      // merge/fractal/stroke 三层精确增量；线段与两种中枢基于已增量更新的 strokes
      // 全量重扫：增量锚点重扫无法覆盖“新K线推翻旧 pending/待确认段”的连锁聚合，
      // 而线段/中枢数量少，全量重扫开销可接受，且彻底避免锚漂移。
      function recomputeTail(fromMi) {
        // fxAll 维护的是原始分型流；交替过滤整体重建，保证与全量口径一致
        resumeFractals(fxAll, merged, fromMi, cfg)
        const filteredFxs = rebuildFilteredFractals(fxAll)
        // 笔状态机公共前缀重放：仅从分型流仍一致处恢复，规避交替过滤前缀变化
        const prefixLen = prevFilteredFxs.length
          ? firstDiffIndex(prevFilteredFxs, filteredFxs, fxFracEq)
          : 0
        prevFilteredFxs = filteredFxs
        const anchor = Math.min(prefixLen, machine.snapCount() - 1, filteredFxs.length - 1)
        machine.replay(filteredFxs, anchor)
        const fullSeg = calcSegmentsFull(strokes(), cfg)
        anchors = fullSeg.confirmedSis
        segments = fullSeg.segments
        strokeCenters = calcCenters(strokes(), cfg)
        segmentCenters = calcCenters(segments, cfg)
        centerStrokeLastStart = strokeCenters.length ? strokeCenters[strokeCenters.length - 1].startIndex : -1
        centerSegmentLastStart = segmentCenters.length ? segmentCenters[segmentCenters.length - 1].startIndex : -1
        recalcDivergences()
      }

      // 追加新K线（实时行情增量主路径）
      function update(newBars) {
        if (!newBars || !newBars.length) return computeResult()
        if (!machine) {
          fullInit(newBars)
          return computeResult()
        }
        const r = resumeMerge(merged, dirs, newBars, dataLen)
        dataLen += newBars.length
        // 逐根追加（spread push 在大批量追加时可能触发参数上限）
        for (let i = 0; i < newBars.length; i++) {
          raw.push(newBars[i])
          closes.push(newBars[i].close)
        }
        let fromMi
        if (r.pushedCount > 0) {
          fromMi = r.lastUpdated ? r.baseLen - 2 : r.baseLen - 1
        } else if (r.lastUpdated) {
          fromMi = r.baseLen - 2
        } else {
          return computeResult()
        }
        recomputeTail(fromMi)
        return computeResult()
      }

      // 回退末根原始K线对 merged 的贡献（updateLast 增量用）：
      //   - 末根独占末元素 → 弹出该元素（dirs 同步弹出）；
      //   - 末根并入末元素 → 用其余 rawIndices 以当时的合并方向 dirs[末元素]
      //     重放包含合并，得到“末根出现之前”的末元素状态。
      // 之后由调用方 resumeMerge 续接新末根，结果与“末根从未取过旧值”的
      // 全量流式合并逐字段一致。
      // 返回 false 表示内部状态与预期不符（防御），调用方应整体重建。
      function unmergeLastRaw() {
        const n = raw.length
        if (!n || !merged.length) return false
        const lastIdx = merged.length - 1
        const el = merged[lastIdx]
        const ris = el.rawIndices
        if (ris[ris.length - 1] !== n - 1) return false
        if (ris.length === 1) {
          merged.pop()
          dirs.pop()
          return true
        }
        const d = dirs[lastIdx]
        const keep = ris.length - 1
        let high = raw[ris[0]].high
        let low = raw[ris[0]].low
        for (let t = 1; t < keep; t++) {
          const k = raw[ris[t]]
          if (d === 1) {
            // 向上：高高
            high = Math.max(high, k.high)
            low = Math.max(low, k.low)
          } else if (d === -1) {
            // 向下：低低
            high = Math.min(high, k.high)
            low = Math.min(low, k.low)
          } else {
            // 方向未知：更大区间
            high = Math.max(high, k.high)
            low = Math.min(low, k.low)
          }
        }
        el.high = high
        el.low = low
        ris.length = keep
        return true
      }

      // 替换最后一根K线（实时行情末根跳动 / 收盘定型）。
      // 实时链路下末根每个 tick 都可能原地变化（不只收盘一次），因此这里是
      // 热路径：先 unmergeLastRaw 回退末根贡献，再 resumeMerge 续接新值
      // （merge 层增量），随后只重算尾部（分型窗口重判 → 笔重放 →
      // 线段/中枢/背驰重扫）。回退的前提是 resumeFractals 能清除 merged
      // 收缩产生的过期分型（mi > merged.length-2 随窗口截断删除），
      // 否则必须整体重建——异常时回退 fullInit 保证绝不错位。
      function updateLast(newLastBar) {
        if (!machine) {
          update([newLastBar])
          return computeResult()
        }
        const n = raw.length
        if (!n) {
          fullInit([newLastBar])
          return computeResult()
        }
        raw[n - 1] = newLastBar
        if (closes.length === n) closes[n - 1] = newLastBar.close
        if (unmergeLastRaw()) {
          resumeMerge(merged, dirs, [newLastBar], n - 1)
          recomputeTail(merged.length - 2)
        } else {
          fullInit(raw)
        }
        return computeResult()
      }

      return {
        __probe: () => ({ fxAll: fxAll.slice(), filtered: prevFilteredFxs.slice() }),
        update,
        updateLast,
        reset,
        get state() {
          return computeResult()
        }
      }
    }

    return { createAnalyzer }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = createAnalyzerModule
  } else {
    global.Chanlun = global.Chanlun || {}
    global.Chanlun.analyzer = createAnalyzerModule(global.Chanlun)
  }
})(typeof window !== 'undefined' ? window : globalThis)
