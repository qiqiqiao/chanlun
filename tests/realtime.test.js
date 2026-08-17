/*!
 * tests/realtime.test.js —— 实时行情更新策略（P0：对象引用 → 内容签名）
 *
 * 核心回归：klinecharts 复用同一 K 线对象并原地修改 OHLC（引用不变、内容已变）
 * 时，必须触发 updateLast 回退重放 —— 旧实现用 dataList[n-1] !== lastLastBar
 * 判断会漏判，导致缠论不刷新。
 */
'use strict'
const { randomWalk, barsFrom } = require('./helpers')
const c = require('../chanlun.js')
const realtime = require('../realtime.js')
const assert = require('assert')
const t = (name, fn) => global.__registerTest('realtime: ' + name, fn)

const CONFIG = { biMinGap: 4 }

function makeUpdater(spy) {
  return realtime.createRealtimeUpdater({
    createAnalyzer: (cfg) => {
      const a = c.createAnalyzer(cfg)
      if (spy) spy.calls = (spy.calls || 0) + 1
      return a
    },
    config: CONFIG
  })
}

t('P0 回归：同一对象原地改 OHLC → 必须触发 updateLast', () => {
  const bars = randomWalk(120, 42)
  const updater = makeUpdater()
  let r = updater.update(bars)
  assert.strictEqual(r.action, 'init')

  // klinecharts 复用同一个数组、同一个末根对象，原地改值
  const last = bars[bars.length - 1]
  last.close = last.close + 5
  last.high = Math.max(last.high, last.close)
  r = updater.update(bars)
  assert.strictEqual(r.action, 'replaceLast', '引用未变但内容已变 → 必须 replaceLast')

  // 重算结果 == 对改后数组的全量 analyze（结构一致性）
  const ref = c.analyze(bars, CONFIG)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.state)), JSON.parse(JSON.stringify(ref)))
})

t('P0：同一对象原地改 close / high / low / open / volume / closed 各自触发', () => {
  const bars = randomWalk(100, 7)
  const updater = makeUpdater()
  updater.update(bars)
  const last = bars[bars.length - 1]
  const fields = [
    ['close', last.close + 1],
    ['high', last.high + 1],
    ['low', last.low - 1],
    ['open', last.open + 1],
    ['volume', last.volume + 10],
    ['isBarClosed', !last.isBarClosed]
  ]
  for (const [k, v] of fields) {
    const before = updater.debug.lastLastSignature
    last[k] = v
    const r = updater.update(bars)
    assert.strictEqual(r.action, 'replaceLast', k + ' 变化必须触发 replaceLast')
    assert.notStrictEqual(updater.debug.lastLastSignature, before, k + ' 签名必须变化')
    // 复位，避免影响后续字段
    const sig = realtime.barSignature(last)
    updater.update(bars) // 同签名 → skip
    assert.strictEqual(updater.update(bars).action, 'skip', k + ' 复位后同签名 skip')
    last[k] = undefined // 清掉该字段，测试下一个字段
  }
})

t('更新策略：init / append / skip / noop / 收缩重建', () => {
  const bars = randomWalk(150, 3)
  const updater = makeUpdater()
  assert.strictEqual(updater.update([]).action, 'noop')
  let r = updater.update(bars.slice(0, 50))
  assert.strictEqual(r.action, 'init')
  // 同批次（同一数组对象、内容未变）→ skip
  assert.strictEqual(updater.update(bars.slice(0, 50)).action, 'skip')
  // 追加 → append
  r = updater.update(bars.slice(0, 51))
  assert.strictEqual(r.action, 'append')
  // 长度收缩 → init（整体重建）
  r = updater.update(bars.slice(0, 40))
  assert.strictEqual(r.action, 'init')
  // 首根时间戳变化 → init
  const shifted = barsFrom([101, 103, 102, 105, 104, 107, 106]) // 不同首根时间戳
  r = updater.update(shifted)
  assert.strictEqual(r.action, 'init')
  // 不同序列但首根时间戳碰巧相同（切换周期场景）→ 首根内容签名不同 → init
  const sameFirstTs = bars.slice(0, 45).map((b, i) => ({ ...b, close: b.close + (i % 3) }))
  r = updater.update(sameFirstTs)
  assert.strictEqual(r.action, 'init')
})

t('末根时间戳变化（即使内容相同）→ replaceLast', () => {
  const bars = barsFrom([100, 102, 101, 104, 103, 106])
  const updater = makeUpdater()
  updater.update(bars)
  const last = { ...bars[bars.length - 1], timestamp: bars[bars.length - 1].timestamp + 1 }
  const arr = bars.slice(0, -1).concat(last)
  assert.strictEqual(updater.update(arr).action, 'replaceLast')
})

t('错误自愈：analyzer 抛错 → error，下次调用整体重建', () => {
  const bars = randomWalk(80, 11)
  let fail = false
  const updater = realtime.createRealtimeUpdater({
    createAnalyzer: (cfg) => {
      const a = c.createAnalyzer(cfg)
      const origUpdateLast = a.updateLast.bind(a)
      a.updateLast = (bar) => { if (fail) throw new Error('boom'); return origUpdateLast(bar) }
      return a
    },
    config: CONFIG
  })
  updater.update(bars)
  // 原地改末根并让 updateLast 抛错
  const last = bars[bars.length - 1]
  last.close += 3
  fail = true
  let r = updater.update(bars)
  assert.strictEqual(r.action, 'error')
  assert.strictEqual(r.state, null)
  fail = false
  // 下次调用（同一数据）自愈：整体重建 → init
  r = updater.update(bars)
  assert.strictEqual(r.action, 'init')
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.state)), JSON.parse(JSON.stringify(c.analyze(bars, CONFIG))))
})

t('barSignature：null → 空串；字段齐全', () => {
  assert.strictEqual(realtime.barSignature(null), '')
  const bar = { timestamp: 1, open: 2, high: 3, low: 1, close: 2.5, volume: 9, isBarClosed: true }
  assert.strictEqual(realtime.barSignature(bar), '1|2|3|1|2.5|9|1')
  assert.strictEqual(realtime.barSignature({ ...bar, isBarClosed: false }), '1|2|3|1|2.5|9|0')
})

t('reset 后从零开始', () => {
  const bars = randomWalk(70, 5)
  const updater = makeUpdater()
  updater.update(bars)
  updater.reset()
  assert.strictEqual(updater.state, null)
  assert.strictEqual(updater.update(bars).action, 'init')
})
