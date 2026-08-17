/*!
 * realtime.js —— 实时行情 → Analyzer 的更新策略
 *
 * 核心问题：klinecharts 在实时行情下可能【复用同一个 K 线对象】并原地修改
 * OHLC（bar.close = x; bar.high = y），此时用对象引用判断
 * （dataList[n-1] !== lastLastBar）会漏判 —— 引用没变但内容已变，
 * Analyzer 不会重算，缠论结构（尤其当前 K 线参与的包含/分型/待确认线段）
 * 就停留在旧价格上。
 *
 * 解决：改用【内容签名】barSignature() ——
 *   timestamp|open|high|low|close|volume|isBarClosed
 * 只要 OHLC/量/收盘标志任一变化，签名即变化，必然触发 updateLast() 回退重放。
 *
 * 更新策略（与旧版行为一致，仅把对象引用替换为内容签名）：
 *   - 首次 / 首根时间戳变化 / 长度收缩  → init（整体重建）
 *   - 长度增加                          → append（增量 update）
 *   - 长度不变但末根签名变化（跳动/定型）→ replaceLast（updateLast 回退重放）
 *   - 完全相同                          → skip
 *   - 任一步异常                        → error（自愈：下次调用整体重建）
 *
 * 浏览器：script 加载注册到 global.realtime；Node：module.exports。
 * main.js 通过 createRealtimeUpdater 使用；本模块可在 Node 中直接单测。
 */
(function (global) {
  'use strict'

  // K 线内容签名：对象原地改值也会让签名变化
  function barSignature(bar) {
    if (!bar) return ''
    return [
      bar.timestamp,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.volume,
      bar.isBarClosed ? 1 : 0
    ].join('|')
  }

  function createRealtimeUpdater(opts) {
    opts = opts || {}
    const createAnalyzer = opts.createAnalyzer || (() => { throw new Error('createRealtimeUpdater: 缺少 createAnalyzer') })
    const config = opts.config || {}

    let analyzer = null
    let chanState = null
    let lastFirstTs = null
    let lastFirstSignature = null
    let lastDataLen = 0
    let lastLastTs = null
    let lastLastSignature = null

    function update(dataList) {
      const n = dataList.length
      if (!n) return { action: 'noop', state: chanState }
      const firstTs = dataList[0].timestamp
      const firstSignature = barSignature(dataList[0])
      const lastTs = dataList[n - 1].timestamp
      const signature = barSignature(dataList[n - 1])

      // 首次 / 首根时间戳变化 / 首根内容变化（切换周期时不同序列可能碰巧同首根
      // 时间戳，但内容不同 → 必须整体重建）/ 长度收缩 → 整体重建
      if (!analyzer || lastFirstTs !== firstTs || lastFirstSignature !== firstSignature || n < lastDataLen) {
        try {
          analyzer = createAnalyzer(config)
          analyzer.update(dataList.slice())
          chanState = analyzer.state
        } catch (e) {
          analyzer = null
          chanState = null
          console.error('缠论计算失败', e)
          // 记账仍推进：下次调用因 !analyzer 触发整体重建（自愈重试）
          lastDataLen = n
          lastFirstTs = firstTs
          lastFirstSignature = firstSignature
          lastLastTs = lastTs
          lastLastSignature = signature
          return { action: 'error', state: null, error: e }
        }
        lastDataLen = n
        lastFirstTs = firstTs
        lastFirstSignature = firstSignature
        lastLastTs = lastTs
        lastLastSignature = signature
        return { action: 'init', state: chanState }
      }

      // 尾部追加新K线 → 增量
      if (n > lastDataLen) {
        try {
          analyzer.update(dataList.slice(lastDataLen))
          chanState = analyzer.state
        } catch (e) {
          console.error('缠论增量计算失败', e)
          chanState = null
          analyzer = null // 使下次整体重建，避免内部 dataLen 与 lastDataLen 错位
          return { action: 'error', state: null, error: e }
        }
        lastDataLen = n
        lastLastTs = lastTs
        lastLastSignature = signature
        return { action: 'append', state: chanState }
      }

      // 长度不变：末根内容签名变化（实时 OHLC 跳动 / K 线收盘定型）→ 回退重放。
      // 必须用内容签名而非对象引用：klinecharts 可能复用同一 bar 对象原地改值，
      // 引用不变但 OHLC 已变，旧实现会漏判导致缠论不刷新。
      if (lastTs !== lastLastTs || signature !== lastLastSignature) {
        try {
          analyzer.updateLast(dataList[n - 1])
          chanState = analyzer.state
        } catch (e) {
          console.error('缠论末根更新失败', e)
          chanState = null
          analyzer = null // 使下次整体重建
          return { action: 'error', state: null, error: e }
        }
        lastLastTs = lastTs
        lastLastSignature = signature
        return { action: 'replaceLast', state: chanState }
      }

      // 完全相同的批次（未收盘 K 线 OHLC 跳动、原始索引未变）→ 结构不依赖它，跳过重算
      return { action: 'skip', state: chanState }
    }

    function reset() {
      analyzer = null
      chanState = null
      lastFirstTs = null
      lastDataLen = 0
      lastLastTs = null
      lastLastSignature = null
    }

    return {
      update,
      reset,
      barSignature,
      get state() { return chanState },
      get debug() {
        return {
          hasAnalyzer: !!analyzer,
          lastFirstTs,
          lastFirstSignature,
          lastDataLen,
          lastLastTs,
          lastLastSignature
        }
      }
    }
  }

  const api = { barSignature, createRealtimeUpdater }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    global.realtime = api
  }
})(typeof window !== 'undefined' ? window : globalThis)
