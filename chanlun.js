/*!
 * chanlun.js —— 缠论核心算法入口（模块装配层）
 *
 * 流水线：原始K线 → 包含关系合并 → 分型 → 笔 → 线段 → 中枢
 *
 * 算法已拆分为独立模块（src/），本文件只负责装配并导出统一 API：
 *   src/config.js    配置（全部规则参数化）
 *   src/merge.js     包含关系处理（全量 / 增量续接）
 *   src/fractal.js   分型识别（全量 / 尾部重判 / 全局交替过滤）
 *   src/stroke.js    笔（可回放状态机）
 *   src/segment.js   线段（特征序列法，可恢复扫描；缺口第二种情况重放修复）
 *   src/center.js    中枢（区间重叠 + 延伸）
 *   src/analyzer.js  增量计算（update / updateLast）
 *
 * 浏览器：先按依赖顺序加载 src/*.js（各自注册到 global.Chanlun），
 *         再加载本文件 → global.chanlun。
 * Node：  require('./chanlun.js') 自动按序加载 src/*.js。
 *
 * 输出格式与旧版单文件实现完全一致（tests 覆盖）。
 */
(function (global) {
  'use strict'

  function buildApi(core) {
    const { DEFAULT_CONFIG, normalizeConfig } = core.config
    const { resumeMerge, mergeBars } = core.merge
    const { calcFractals, resumeFractals, rebuildFilteredFractals } = core.fractal
    const { calcStrokes, createStrokeMachine } = core.stroke
    const { segmentScan, calcSegments, calcSegmentsFull } = core.segment
    const { centerScan, calcCenters } = core.center
    const { createAnalyzer } = core.analyzer

    // 全量入口：输出格式与旧版保持一致
    function analyze(klineDataList, config) {
      const cfg = normalizeConfig(config)
      const { merged } = mergeBars(klineDataList)
      const fxAll = calcFractals(merged, cfg)
      const machine = createStrokeMachine(cfg.bi.minGap)
      machine.replay(fxAll, 0)
      const strokes = machine.state.strokes
      const segments = calcSegments(strokes, cfg)
      const strokeCenters = calcCenters(strokes, cfg)
      const segmentCenters = calcCenters(segments, cfg)
      return {
        merged,
        // 只保留有效分型（笔的端点），避免密集噪点分型
        fractals: machine.state.endpoints,
        strokes,
        segments,
        strokeCenters,
        segmentCenters,
        dataLen: klineDataList.length
      }
    }

    return {
      analyze,
      createAnalyzer,
      DEFAULT_CONFIG,
      normalizeConfig,
      mergeBars,
      resumeMerge,
      calcFractals,
      resumeFractals,
      rebuildFilteredFractals,
      calcStrokes,
      createStrokeMachine,
      segmentScan,
      calcSegments,
      calcSegmentsFull,
      centerScan,
      calcCenters
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    // Node：按依赖顺序 require src 模块，装配 core 后导出
    const core = {
      config: require('./src/config.js'),
      merge: require('./src/merge.js'),
      fractal: require('./src/fractal.js'),
      stroke: require('./src/stroke.js'),
      segment: require('./src/segment.js'),
      center: require('./src/center.js')
    }
    core.analyzer = require('./src/analyzer.js')(core)
    module.exports = buildApi(core)
  } else {
    // 浏览器：src/*.js 已按顺序注册到 global.Chanlun
    const core = global.Chanlun || {}
    const MISSING = ['config', 'merge', 'fractal', 'stroke', 'segment', 'center', 'analyzer'].filter((k) => !core[k])
    if (MISSING.length) {
      throw new Error('chanlun.js：缺少算法模块 src/' + MISSING.join(', ') + '.js（请按 index.html 的依赖顺序加载）')
    }
    global.chanlun = buildApi(core)
  }
})(typeof window !== 'undefined' ? window : globalThis)
