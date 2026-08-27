/*!
 * src/fractal.js —— 分型识别模块
 *
 *   calcFractals = 全量（先找全部分型，再顶底交替过滤）；
 *   resumeFractals = 对 merged 尾部区间重判并汇入过滤；
 *   rebuildFilteredFractals = 对完整分型表做全局交替过滤（增量时保证与全量口径一致）
 *
 * 交替过滤：相邻同类型分型只保留更极端的那个（顶保留更高、底保留更低）。
 */
(function (global) {
  'use strict'

  function fractalAt(merged, i, cfg) {
    const m = merged[i]
    const p = merged[i - 1]
    const n = merged[i + 1]
    if (cfg.fractal.mode === 'relaxed') {
      if (m.high > p.high && m.high > n.high) {
        return { type: 'top', mi: i, high: m.high, low: m.low, rawMiddle: m.rawMiddle }
      }
      if (m.low < p.low && m.low < n.low) {
        return { type: 'bottom', mi: i, high: m.high, low: m.low, rawMiddle: m.rawMiddle }
      }
      return null
    }
    // strict（默认）：顶分型要求高点更高且低点也更高，底分型反之
    if (m.high > p.high && m.high > n.high && m.low > p.low && m.low > n.low) {
      return { type: 'top', mi: i, high: m.high, low: m.low, rawMiddle: m.rawMiddle }
    }
    if (m.low < p.low && m.low < n.low && m.high < p.high && m.high < n.high) {
      return { type: 'bottom', mi: i, high: m.high, low: m.low, rawMiddle: m.rawMiddle }
    }
    return null
  }

  // 分型顶底交替过滤：相邻同类型分型只保留更极端的那个（增量追加时等价于全量过滤）
  function pushFractalFiltered(list, f) {
    const last = list[list.length - 1]
    if (!last) {
      list.push(f)
      return
    }
    if (f.type === last.type) {
      if (f.type === 'top' && f.high > last.high) {
        list[list.length - 1] = f
      } else if (f.type === 'bottom' && f.low < last.low) {
        list[list.length - 1] = f
      }
    } else {
      list.push(f)
    }
  }

  // 分型顶底交替过滤：相邻同类型分型只保留更极端的那个（全量路径）
  function calcFractals(merged, cfg) {
    const fxAll = []
    for (let i = 1; i < merged.length - 1; i++) {
      const f = fractalAt(merged, i, cfg)
      if (f) fxAll.push(f)
    }
    const result = []
    for (const f of fxAll) pushFractalFiltered(result, f)
    return result
  }

  // 在原分型表 fxAll 中整段替换窗口 [start, end] 内的分型。
  // 注意：交替过滤是全局顺序依赖的，不能逐窗追加（否则窗口起点切穿分型串会
  // 漏掉交替结构）。因此这里只做“原始分型”的更新维护；真正的交替过滤
  // 由 rebuildFilteredFractals 在全局上重建，保证与全量口径一致。
  // fromMi 之前的普通分型不被触碰。此外：
  //  - 末尾未定型的元素（右邻居可能还会变）必须归入本轮重判，起点再收紧到
  //    merged.length - 3；
  //  - 窗口内必须“以 merged 现状为准”重判：若某 mi 的旧分型不再成立则删除，
  //    否则重建后 merged 截断会让已过期的分型残留（例如 updateLast 后某元素
  //    从“中间”变成“末位”，不再成顶/底）。
  // fxAll 按约定始终为「mi 升序且无重复」：每个 merged 下标至多产生一个分型，
  // 且每次调用只重判 [start, end] 窗口并整段替换。因此用二分定位窗口起点后
  // 直接截断追加即可，无需 Map 重建 + 全量排序（旧实现每次增量 O(n log n)）。
  // 注意：有效分型的 mi ≤ merged.length - 2 = end，mi > end 的都是 merged 收缩
  // （updateLast 回退末元素）留下的过期残留，随截断一并清除。
  function resumeFractals(fxAll, merged, fromMi, cfg) {
    const start = Math.min(Math.max(1, fromMi), Math.max(1, merged.length - 3))
    const end = merged.length - 2
    if (end < start) return
    let lo = 0
    let hi = fxAll.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (fxAll[mid].mi < start) lo = mid + 1
      else hi = mid
    }
    const fresh = []
    for (let i = start; i <= end; i++) {
      const f = fractalAt(merged, i, cfg)
      if (f) fresh.push(f)
    }
    fxAll.length = lo
    for (let i = 0; i < fresh.length; i++) fxAll.push(fresh[i])
  }

  // 对完整分型表做全局交替过滤（不修改原表，返回新数组）
  function rebuildFilteredFractals(fxAll) {
    const result = []
    for (const f of fxAll) pushFractalFiltered(result, f)
    return result
  }

  const api = { fractalAt, pushFractalFiltered, calcFractals, resumeFractals, rebuildFilteredFractals }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    global.Chanlun = global.Chanlun || {}
    global.Chanlun.fractal = api
  }
})(typeof window !== 'undefined' ? window : globalThis)
