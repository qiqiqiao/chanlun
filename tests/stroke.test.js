/*!
 * tests/stroke.test.js —— 笔（minGap 间隔、回放状态机）
 */
'use strict'
const { makeRng } = require('./helpers')
const c = require('../chanlun.js')
const t = (name, fn) => global.__registerTest('stroke: ' + name, fn)

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}
function deepEqual(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || 'not deep equal') + '\n  got: ' + JSON.stringify(a) + '\n  want: ' + JSON.stringify(b))
  }
}

// 构造分型序列（直接喂给笔状态机，绕开合并）
function fx(type, mi) {
  const high = type === 'top' ? 100 + mi : 90 + mi * 0.5
  const low = type === 'bottom' ? 80 + mi * 0.5 : 85 + mi
  return { type, mi, high, low, rawMiddle: mi * 2 }
}

t('minGap 决定是否成笔', () => {
  const seq = [fx('top', 0), fx('bottom', 2), fx('top', 6), fx('bottom', 9)]
  // minGap=4：bottom(2) 与 top(6)：6-4=2<4 不成；top(6) 与 bottom(9)：9-6=3<4 不成
  const r3 = c.calcStrokes(seq, { bi: { minGap: 4 } })
  deepEqual(r3.strokes.length, 0)
  // minGap=2：成笔
  const r2 = c.calcStrokes(seq, { bi: { minGap: 2 } })
  assert(r2.strokes.length >= 1, 'minGap2 forms stroke')
})

t('首笔方向由先出现的分型决定', () => {
  // 先顶后底 → down 笔
  const seq = [fx('top', 0), fx('bottom', 5)]
  const r = c.calcStrokes(seq, { bi: { minGap: 2 } })
  deepEqual(r.strokes.length, 1)
  assert(r.strokes[0].dir === 'down', 'down first')
  // 先底后顶 → up 笔
  const seq2 = [fx('bottom', 0), fx('top', 5)]
  const r2 = c.calcStrokes(seq2, { bi: { minGap: 2 } })
  assert(r2.strokes[0].dir === 'up', 'up first')
})

t('同类型更极端分型回退延伸', () => {
  // 顶0 → 底5(成down笔) → 顶9(成up笔) → 顶13 更高(回退up，用顶13 重建)
  const seq = [
    { type: 'top', mi: 0, high: 100, low: 90, rawMiddle: 0 },
    fx('bottom', 5),     // down: top0→bottom5
    fx('top', 9)         // up: bottom5→top9
  ]
  // 顶13 更高（200）→ 回退 up
  seq.push({ type: 'top', mi: 13, high: 200, low: 190, rawMiddle: 26 })
  const r = c.calcStrokes(seq, { bi: { minGap: 2 } })
  deepEqual(r.strokes.length, 2, 'down0 + up1(rolled back)')
  assert(r.strokes[0].dir === 'down', 'first down')
  deepEqual(r.strokes[1].to.high, 200, 'up rewritten to higher top')
  deepEqual(r.endpoints.length, 3, 'endpoints top0 bottom5 top13')
})

t('createStrokeMachine 回放与全量一致', () => {
  const rng = makeRng(3)
  const seq = []
  for (let i = 0; i < 80; i++) {
    const type = i % 2 === 0 ? 'top' : 'bottom'
    seq.push({ type, mi: i * 3, high: 100 + (type === 'top' ? 10 + rng() * 5 : 0), low: (type === 'bottom' ? 80 - rng() * 5 : 90), rawMiddle: i * 3 })
  }
  const cfg = { bi: { minGap: 4 } }
  const full = c.calcStrokes(seq, cfg).strokes
  // 逐 feed 全量 → strokes 与 calcStrokes 一致
  const m1 = c.createStrokeMachine(4)
  for (let i = 0; i < seq.length; i++) m1.feed(seq[i])
  deepEqual(m1.state.strokes.map(s => s.dir + s.si), full.map(s => s.dir + s.si))
  // 部分回放（从中间）结果 = 全量回放结果
  const mid = 30
  const m2 = c.createStrokeMachine(4)
  m2.replay(seq, 0)
  const m3 = c.createStrokeMachine(4)
  for (let i = 0; i < mid; i++) m3.feed(seq[i])
  m3.replay(seq, mid)
  deepEqual(m3.state.strokes, m2.state.strokes, 'replay from mid equals full replay')
})
