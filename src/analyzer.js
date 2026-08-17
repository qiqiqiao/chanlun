/*!
 * src/analyzer.js —— 增量计算模块
 *
 * 首次全量，之后 update() 精确增量 / updateLast() 回退重放。
 *   分层锚点：
 *     - merge/fractals/strokes 精确增量（O(新K线数)）
 *     - segments 全量重扫（锚点重扫无法覆盖“新K线推翻旧 pending/待确认段”的
 *       连锁聚合，而线段/中枢数量少，全量重扫开销可接受，且彻底避免锚漂移）
 *     - centers 全量重扫
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

    function createAnalyzer(config) {
      const cfg = normalizeConfig(config)
      let raw = [] // 完整原始K线（updateLast 回退重放需要）
      let merged = []
      let dirs = []
      let fxAll = [] // 过滤后的分型流（喂给笔状态机）
      let machine = null
      let anchors = [] // 线段确认锚点：已确认线段的终点笔索引（递增）
      let segments = []
      let strokeCenters = []
      let segmentCenters = []
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
          dataLen
        }
      }

      function reset() {
        raw = []
        merged = []
        dirs = []
        fxAll = []
        machine = null
        anchors = []
        segments = []
        strokeCenters = []
        segmentCenters = []
        dataLen = 0
        centerStrokeLastStart = -1
        centerSegmentLastStart = -1
        prevFilteredFxs = []
      }

      function fullInit(bars) {
        raw = bars.slice()
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
        raw.push(...newBars)
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

      // 替换最后一根K线（收盘定型）：整链重建
      // 增量的 merged 截断回放无法在窗口内覆盖“被截断重建元素的分型残留”，
      // 且线段/中枢本就全量重扫；定型的发生频率很低（每根 K 线一次），
      // 直接用全量重建最稳妥、绝不错位。
      function updateLast(newLastBar) {
        if (!machine) {
          update([newLastBar])
          return computeResult()
        }
        if (raw.length) raw[raw.length - 1] = newLastBar
        fullInit(raw.slice())
        return computeResult()
      }

      return {
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
