/*!
 * src/config.js —— 配置模块
 *
 * 全部规则参数化，默认值 = 历史口径（strict），行为与旧版一致。
 *   bi.minGap        ：笔内合并K线的最小间隔（两端分型的 mi 差）
 *   fractal.mode     ：'strict' 顶分型要求 high/low 双高，底分型双低；
 *                      'relaxed' 只比较对应端
 *   segment.method   ：特征序列法（当前仅此一种口径）
 *   center.minElements：中枢最少元素数（笔/线段）
 *   divergence.*     ：笔背驰（MACD 柱面积动量 + 大级别=线段动量确认）
 *
 * 兼容旧参数 biMinGap（顶层数字键）→ 归一为 bi.minGap。
 */
(function (global) {
  'use strict'

  const DEFAULT_CONFIG = {
    bi: {
      minGap: 4 // 笔内合并K线的最小间隔（两端分型的 mi 差）
    },
    fractal: {
      mode: 'strict' // strict：顶分型要求 high/low 双高，底分型双低；relaxed：只比较对应端
    },
    segment: {
      method: 'feature-sequence' // 特征序列法（当前仅此一种口径）
    },
    center: {
      minElements: 3 // 中枢最少元素数（笔/线段）
    },
    divergence: {
      macdFast: 12, // 动量度量 MACD 快线
      macdSlow: 26, // 慢线
      macdSignal: 9, // 信号线
      minMomentumDrop: 0.9, // 后笔动量 < 前同向笔动量 × 该值 → 局部背驰
      requireCenter: true // 两笔间需存在笔中枢（趋势背驰口径）
    }
  }

  function normalizeConfig(config) {
    config = config || {}
    const cfg = {
      bi: Object.assign({}, DEFAULT_CONFIG.bi, config.bi || {}),
      fractal: Object.assign({}, DEFAULT_CONFIG.fractal, config.fractal || {}),
      segment: Object.assign({}, DEFAULT_CONFIG.segment, config.segment || {}),
      center: Object.assign({}, DEFAULT_CONFIG.center, config.center || {}),
      divergence: Object.assign({}, DEFAULT_CONFIG.divergence, config.divergence || {})
    }
    // 兼容旧参数 biMinGap
    if (typeof config.biMinGap === 'number') cfg.bi.minGap = config.biMinGap
    return cfg
  }

  const api = { DEFAULT_CONFIG, normalizeConfig }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    global.Chanlun = global.Chanlun || {}
    global.Chanlun.config = api
  }
})(typeof window !== 'undefined' ? window : globalThis)
