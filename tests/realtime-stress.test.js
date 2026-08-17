/*!
 * tests/realtime-stress.test.js —— 实时行情链路压力测试（确定性，无网络）
 *
 * 模拟 klinecharts 的真实行为：
 *   - 同一个 dataList 数组、同一个末根 bar 对象被【原地修改】（引用不变内容变）
 *   - K 线收盘（isBarClosed 翻转）→ 新 K 线追加 → 再原地跳动 → 再收盘 …
 * 每个 tick 后断言 Analyzer 状态与「全量 analyze(当前数组)」逐字段一致，
 * 即实时链路永不落后于完整重算（P0 修复的可靠性证明）。
 */
'use strict'
const { randomWalk, makeRng } = require('./helpers')
const c = require('../chanlun.js')
const realtime = require('../realtime.js')
const assert = require('assert')
const t = (name, fn) => global.__registerTest('realtime-stress: ' + name, fn)

const CONFIG = { biMinGap: 4 }

function barInvariants(state, dataLen) {
  assert.strictEqual(state.dataLen, dataLen, 'dataLen')
  for (let i = 1; i < state.strokes.length; i++) {
    assert.notStrictEqual(state.strokes[i].dir, state.strokes[i - 1].dir, 'strokes alternate ' + i)
    assert.strictEqual(state.strokes[i].fromRaw, state.strokes[i - 1].toRaw, 'strokes chained ' + i)
  }
  for (let i = 1; i < state.segments.length; i++) {
    assert.strictEqual(state.segments[i].fromRaw, state.segments[i - 1].toRaw, 'segments chained ' + i)
  }
}

t('5000 K：原地跳动 / 收盘 / 新K 连续更新，始终与全量一致', () => {
  const bars = randomWalk(5000, 2024)
  const updater = realtime.createRealtimeUpdater({
    createAnalyzer: (cfg) => c.createAnalyzer(cfg),
    config: CONFIG
  })

  let r = updater.update(bars)
  assert.strictEqual(r.action, 'init')
  assert.deepStrictEqual(r.state, c.analyze(bars, CONFIG))
  barInvariants(r.state, bars.length)

  const rnd = makeRng(77)
  let closed = false
  const TICKS = 150
  for (let k = 0; k < TICKS; k++) {
    const roll = rnd()
    const last = bars[bars.length - 1]

    if (roll < 0.55) {
      // 场景 A：当前 K 线原地跳动（复用同一对象、同一数组）
      const move = (rnd() - 0.5) * 4
      last.close = last.close + move
      last.high = Math.max(last.high, last.close)
      last.low = Math.min(last.low, last.close)
      r = updater.update(bars)
      assert.strictEqual(r.action, 'replaceLast', 'tick ' + k + ' 原地跳动')
    } else if (roll < 0.8) {
      // 场景 B：当前 K 线收盘标志翻转（收盘 ⇄ 未收盘）
      last.isBarClosed = !last.isBarClosed
      closed = !!last.isBarClosed
      r = updater.update(bars)
      assert.strictEqual(r.action, 'replaceLast', 'tick ' + k + ' 收盘标志翻转')
    } else {
      // 场景 C：新 K 线出现（追加），末根重置为未收盘
      const next = {
        timestamp: last.timestamp + 60000,
        open: last.close,
        high: last.close + 1,
        low: last.close - 1,
        close: last.close,
        volume: 100,
        isBarClosed: false
      }
      bars.push(next)
      closed = false
      r = updater.update(bars)
      assert.strictEqual(r.action, 'append', 'tick ' + k + ' 新K追加')
    }

    // 每个 tick 后：增量状态 == 全量重算（逐字段）
    const ref = c.analyze(bars, CONFIG)
    assert.deepStrictEqual(r.state, ref, 'tick ' + k + ' 与全量不一致')
    barInvariants(r.state, bars.length)
  }

  // 同一数据重复 update → skip（幂等）
  assert.strictEqual(updater.update(bars).action, 'skip')
  assert.deepStrictEqual(updater.state, c.analyze(bars, CONFIG))
})

t('收盘→新K→跳动循环（小数据可读场景）', () => {
  // 用可控的小数据验证闭环：跳动、收盘、新K、再跳动
  const bars = randomWalk(60, 5)
  const updater = realtime.createRealtimeUpdater({
    createAnalyzer: (cfg) => c.createAnalyzer(cfg),
    config: CONFIG
  })
  updater.update(bars)

  const last1 = bars[bars.length - 1]
  last1.close += 2
  last1.high = last1.close + 1
  assert.strictEqual(updater.update(bars).action, 'replaceLast')

  const last2 = bars[bars.length - 1]
  last2.isBarClosed = true
  assert.strictEqual(updater.update(bars).action, 'replaceLast', '收盘翻转触发')

  bars.push({ timestamp: last2.timestamp + 60000, open: last2.close, high: last2.close + 1, low: last2.close - 1, close: last2.close, volume: 100, isBarClosed: false })
  assert.strictEqual(updater.update(bars).action, 'append', '新K追加')

  const last3 = bars[bars.length - 1]
  last3.close -= 3
  last3.low = last3.close - 1
  assert.strictEqual(updater.update(bars).action, 'replaceLast', '新K继续原地跳动')

  assert.deepStrictEqual(updater.state, c.analyze(bars, CONFIG))
})
