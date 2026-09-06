/*!
 * tests/segment-edge.test.js —— 线段判定逻辑边界测试
 *
 * 重点覆盖 calcSegments() / segmentScan() 状态机的边界行情：
 *   - 第一种情况（无缺口）立即终结
 *   - 第二种情况（缺口）：确认（新线段特征序列分型）/ 否定（更极端笔）
 *   - 否定时“待确认期间被跳过的新线段方向笔”必须重放回旧线段特征序列
 *     （旧版实现 concat(pendingFeatures) 会污染特征序列 → 线段终点漂移，
 *       差分探针在 4000 组随机笔序列中发现 202 组分歧；以下三个种子为回归用例）
 *   - 从已确认锚点恢复扫描 == 全量扫描尾部
 */
'use strict'
const { randStrokes } = require('./helpers')
const c = require('../chanlun.js')
const segment = require('../src/segment.js')
const assert = require('assert')
const t = (name, fn) => global.__registerTest('segment-edge: ' + name, fn)

// 构造笔对象（直接喂给 segmentScan，绕开 merge/fractal/stroke 流水线）
function mk(si, dir, from, to) {
  const high = Math.max(from, to)
  const low = Math.min(from, to)
  return {
    si, dir,
    from: { high, low },
    to: { high, low },
    fromRaw: si * 5, toRaw: si * 5 + 5,
    high, low
  }
}

const sig = (r) => JSON.stringify({
  sis: r.confirmedSis,
  segs: r.segments.map((s) => s.dir + ':' + s.fromRaw + '-' + s.toRaw + (s.finished ? 'F' : 'O'))
})

// ---------------------------------------------------------------------------
// 回归：旧版否定逻辑（concat pendingFeatures）导致线段终点漂移的用例
// 预期值 = 教科书正确行为（否定时从触发笔之后完整重放）。
// 注：seed 145 的预期值在 2026-08 修正过一次——旧断言把“重放丢交错笔”
// bug 的输出（up:0-75）锁成了预期；正确行为是在 si=9 处识别真顶
// （特征序列重放出无缺口顶分型），线段应终结于 raw=45。
// ---------------------------------------------------------------------------
const REGRESSION = [
  { seed: 52, n: 92, sis: [3, 6, 11, 40, 79], segs: ['up:0-15F', 'down:15-30F', 'up:30-55F', 'down:55-200F', 'up:200-395F', 'down:395-460O'] },
  { seed: 145, n: 65, sis: [9, 14, 17, 40, 43, 46, 53, 56, 59, 62], segs: ['up:0-45F', 'down:45-70F', 'up:70-85F', 'down:85-200F', 'up:200-215F', 'down:215-230F', 'up:230-265F', 'down:265-280F', 'up:280-295F', 'down:295-310F', 'up:310-325O'] },
  { seed: 209, n: 69, sis: [11, 16, 21, 24, 27, 32, 53, 56, 63, 66], segs: ['down:0-55F', 'up:55-80F', 'down:80-105F', 'up:105-120F', 'down:120-135F', 'up:135-160F', 'down:160-265F', 'up:265-280F', 'down:280-315F', 'up:315-330F', 'down:330-345O'] }
]

t('回归：缺口分型被否定时线段终点不漂移（旧版 bug）', () => {
  for (const rc of REGRESSION) {
    const strokes = randStrokes(rc.n, rc.seed)
    const r = c.segmentScan(strokes, 0)
    assert.strictEqual(sig(r), sig({ confirmedSis: rc.sis, segments: rc.segs.map(parseSeg) }),
      'seed ' + rc.seed + ' 期望正确线段结构')
  }
})

function parseSeg(s) {
  const m = s.match(/^(up|down):(\d+)-(\d+)([FO])$/)
  const dir = m[1]
  const fromRaw = +m[2]
  const toRaw = +m[3]
  const finished = m[4] === 'F'
  return { dir, fromRaw, toRaw, finished }
}

// ---------------------------------------------------------------------------
// 第一种情况：特征序列分型无缺口 → 线段立即在该分型处终结
// ---------------------------------------------------------------------------
t('第一种情况（无缺口）：立即终结于分型中间元素', () => {
  // 向上线段特征序列 = 向下笔 [s1, s3, s5]：s3 为顶（115>110、>113；111>100、>110）
  // 无缺口：s3.low 111 <= s1.high 110？不成立 —— 改为 s3 低点 109 → 无缺口
  const strokes = [
    mk(0, 'up', 100, 110),
    mk(1, 'down', 110, 100),   // f0: 110-100
    mk(2, 'up', 100, 115),
    mk(3, 'down', 115, 109),   // f1: 115-109（顶；无缺口：109 <= 110）
    mk(4, 'up', 109, 113),
    mk(5, 'down', 113, 106)    // f2: 113-106
  ]
  const r = c.segmentScan(strokes, 0)
  assert.strictEqual(r.segments.length, 2, '一条已终结 + 一条未完成')
  assert.strictEqual(r.segments[0].finished, true)
  assert.strictEqual(r.segments[0].dir, 'up')
  assert.strictEqual(r.segments[0].fromRaw, 0)
  assert.strictEqual(r.segments[0].toRaw, 15, '终结于 s3.from（115 高点）')
  assert.deepStrictEqual(r.confirmedSis, [3])
  assert.strictEqual(r.segments[1].finished, false)
  assert.strictEqual(r.segments[1].dir, 'down')
})

// ---------------------------------------------------------------------------
// 第二种情况：缺口分型 → 待确认 → 新线段特征序列出现分型 → 确认
// ---------------------------------------------------------------------------
t('第二种情况（缺口）：新线段特征序列分型确认', () => {
  // 向上线段特征序列 [s1, s3, s5]：s3 顶（115>110、>112.5；111>100、>110.5）
  //   s3.low 111 > s1.high 110 → 缺口 → 待确认（第二种情况）
  // 待确认期间：s6/s8/s10（向上笔）构成新(下)线段的特征序列：
  //   s8 底（109.5<110.5、<110；110.5<111.5、<112）→ 确认
  const strokes = [
    mk(0, 'up', 100, 110),
    mk(1, 'down', 110, 100),    // f0: 110-100
    mk(2, 'up', 100, 115),
    mk(3, 'down', 115, 111),    // f1: 115-111（缺口 111 > 110 → 待确认点）
    mk(4, 'up', 111, 112.5),    // 正常分支跳过
    mk(5, 'down', 112.5, 110.5),// f2: 112.5-110.5（触发待确认）
    mk(6, 'up', 110.5, 111.5),  // 新线段特征元素 1
    mk(7, 'down', 111.5, 109.5),// 被跳过（旧线段特征序列延续）
    mk(8, 'up', 109.5, 110.5),  // 新线段特征元素 2（底分型中间）
    mk(9, 'down', 110.5, 110),  // 被跳过
    mk(10, 'up', 110, 112)      // 新线段特征元素 3 → 确认
  ]
  const r = c.segmentScan(strokes, 0)
  assert.strictEqual(r.segments.length, 3, '旧线段 + 新线段 + 尾部')
  assert.strictEqual(r.segments[0].finished, true)
  assert.strictEqual(r.segments[0].dir, 'up')
  assert.strictEqual(r.segments[0].toRaw, 15, '旧线段终结于待确认点 s3.from=115')
  assert.strictEqual(r.segments[1].finished, true)
  assert.strictEqual(r.segments[1].dir, 'down')
  assert.strictEqual(r.segments[1].toRaw, 40, '新线段终结于确认分型 s8.from=109.5')
  assert.deepStrictEqual(r.confirmedSis, [3, 8])
  assert.strictEqual(r.segments[2].finished, false)
})

// ---------------------------------------------------------------------------
// 第二种情况：缺口分型被否定 → 旧线段继续（待确认期间笔重放）
// ---------------------------------------------------------------------------
t('第二种情况：否定后旧线段继续并正确终结于后续顶分型', () => {
  // s3 顶分型有缺口（111 > 110）→ 待确认
  // s6(113)、s7 待确认期间：s6 进 pendingFeatures、s7 被跳过
  // s8(118 > 115) → 否定；重放 s7 → 特征序列 [s1,s3,s5,s7,s9,s11]
  //   s9 顶（118>113、>116；113>109、>112）→ 无缺口 → 第一种情况终结于 s9
  const strokes = [
    mk(0, 'up', 100, 110),
    mk(1, 'down', 110, 100),    // f0: 110-100
    mk(2, 'up', 100, 115),
    mk(3, 'down', 115, 111),    // f1: 115-111（缺口 111>110）
    mk(4, 'up', 111, 114),      // 正常分支跳过
    mk(5, 'down', 114, 110),    // f2: 114-110（触发待确认）
    mk(6, 'up', 110, 113),      // pendingFeatures（113 <= 115 未否定）
    mk(7, 'down', 113, 109),    // 被跳过（旧线段特征序列延续）
    mk(8, 'up', 109, 118),      // 118 > 115 → 否定 → 重放 s7
    mk(9, 'down', 118, 113),    // 重放后的特征元素
    mk(10, 'up', 113, 116),     // 跳过
    mk(11, 'down', 116, 112)    // 特征元素 → 顶分型在 s9
  ]
  const r = c.segmentScan(strokes, 0)
  assert.strictEqual(r.segments.length, 2, '已终结 + 尾部')
  assert.strictEqual(r.segments[0].finished, true)
  assert.strictEqual(r.segments[0].dir, 'up')
  assert.strictEqual(r.segments[0].toRaw, 45, '否定后线段继续，终结于 s9.from=118')
  assert.deepStrictEqual(r.confirmedSis, [9])
  assert.strictEqual(r.segments[1].dir, 'down')
  assert.strictEqual(r.segments[1].finished, false)
})

// ---------------------------------------------------------------------------
// 回归：否定重放必须回到“触发笔之后”（待确认期两方向笔交错时旧版丢笔）
// 旧版用 j - pendingBuffer.length 估算回退点：当缓冲笔在前、线段方向笔
// （未创新极值的候选元素）在后时，回退点越过部分缓冲笔 → 这些笔被永久
// 跳过、特征序列缺元素 → 线段终点漂移（seed 2/20/62 可复现，62 最明显：
// 多条线段被合并成一条）。正确语义 = 否定时从触发笔之后完整重放，
// 等价于“该缺口分型从未发生”。
// ---------------------------------------------------------------------------
t('回归：否定重放不丢交错笔（完整重放语义）', () => {
  // 锁定种子：与参考实现（进入 pending 时记录触发笔之后的位置）逐位一致
  for (const { seed, n } of [{ seed: 2, n: 80 }, { seed: 7, n: 80 }, { seed: 20, n: 40 }, { seed: 62, n: 80 }, { seed: 70, n: 80 }]) {
    const strokes = randStrokes(n, seed)
    const r = c.segmentScan(strokes, 0)
    // 参考实现：与 segmentScan 相同，仅否定分支的回退点固定为“触发笔之后”
    const refScan = (strokes2, segStart) => {
      const segments = []
      const nn = strokes2.length
      let segDir = strokes2[segStart].dir
      let features = []
      let pending = null
      let pendingFeatures = []
      const ep = (si) => strokes2[si].fromRaw
      let j = segStart + 1
      while (j < nn) {
        const s = strokes2[j]
        // 镜像主实现的线段破坏（含 ≥3 笔 guard），保持重放等价性断言覆盖新规则
        if (j - segStart >= 3) {
          const ss0 = strokes2[segStart]
          const breached = segDir === 'up' ? s.low < ss0.from.low : s.high > ss0.from.high
          if (breached) {
            segments.push({ dir: segDir, fromRaw: strokes2[segStart].fromRaw, toRaw: s.fromRaw, finished: true })
            segStart = j
            segDir = s.dir
            features = []; pending = null; pendingFeatures = []
            j = segStart + 1
            continue
          }
        }
        if (pending) {
          if (s.dir === pending.newDir) { j++; continue }
          const negExtreme = segDir === 'up'
            ? s.high > strokes2[pending.strokeIndex].from.high
            : s.low < strokes2[pending.strokeIndex].from.low
          if (negExtreme) {
            const back = pending.replayFrom
            pending = null; pendingFeatures = []
            j = back
            continue
          }
          segment.pushFeature(pendingFeatures, s, pending.newDir)
          const pF = segment.findFeatureFractal(pendingFeatures, pending.newDir)
          if (pF) {
            segments.push({ dir: segDir, fromRaw: strokes2[segStart].fromRaw, toRaw: ep(pending.strokeIndex), finished: true })
            segments.push({ dir: pending.newDir, fromRaw: ep(pending.strokeIndex), toRaw: ep(pF.strokeIndex), finished: true })
            segStart = pF.strokeIndex
            segDir = strokes2[segStart].dir
            features = []; pending = null; pendingFeatures = []
            j = segStart + 1
            continue
          }
          j++; continue
        }
        if (s.dir === segDir) { j++; continue }
        segment.pushFeature(features, s, segDir)
        const f1 = segment.findFeatureFractal(features, segDir)
        if (f1) {
          const f0 = features[features.length - 3]
          const gap = f1.low > f0.high || f1.high < f0.low
          if (!gap) {
            segments.push({ dir: segDir, fromRaw: strokes2[segStart].fromRaw, toRaw: ep(f1.strokeIndex), finished: true })
            segStart = f1.strokeIndex
            segDir = strokes2[segStart].dir
            features = []
            j = segStart + 1
            continue
          }
          pending = { strokeIndex: f1.strokeIndex, newDir: strokes2[f1.strokeIndex].dir, replayFrom: j + 1 }
          pendingFeatures = []
          j++
          continue
        }
        j++
      }
      if (segStart < nn) {
        segments.push({ dir: segDir, fromRaw: strokes2[segStart].fromRaw, toRaw: strokes2[nn - 1].toRaw, finished: false })
      }
      return segments
    }
    const ref = refScan(strokes, 0)
    assert.strictEqual(
      JSON.stringify(r.segments.map((s) => [s.dir, s.fromRaw, s.toRaw, s.finished])),
      JSON.stringify(ref.map((s) => [s.dir, s.fromRaw, s.toRaw, s.finished])),
      'seed ' + seed + ' 否定重放应等价于完整重放'
    )
  }
})

// ---------------------------------------------------------------------------
// 从已确认锚点恢复扫描 == 全量扫描的尾部（增量锚点维护的根基）
// ---------------------------------------------------------------------------
t('从最后确认锚点恢复扫描与全量一致', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const strokes = randStrokes(40 + (seed % 50), seed + 77777)
    const full = c.segmentScan(strokes, 0)
    if (!full.confirmedSis.length) continue
    const anchor = full.confirmedSis[full.confirmedSis.length - 1]
    const tail = c.segmentScan(strokes, anchor)
    const anchorRaw = strokes[anchor].fromRaw
    const fullTail = full.segments.filter((s) => s.fromRaw >= anchorRaw)
    assert.strictEqual(
      JSON.stringify(tail.segments.map((s) => s.dir + ':' + s.fromRaw + '-' + s.toRaw + (s.finished ? 'F' : 'O'))),
      JSON.stringify(fullTail.map((s) => s.dir + ':' + s.fromRaw + '-' + s.toRaw + (s.finished ? 'F' : 'O'))),
      'seed ' + seed
    )
  }
})

// ---------------------------------------------------------------------------
// 线段破坏（扩展规则）：超越段起点极值即终结，新段反向
// ---------------------------------------------------------------------------
t('破坏：向下段被反弹超越起点 → 旧段终结于破坏笔起点，新上段开始', () => {
  // 下段 s0(30→5)，随后反弹笔 s3 高 32 超起点 30 → 破坏
  const strokes = [
    mk(0, 'down', 30, 5),
    mk(1, 'up', 5, 20),
    mk(2, 'down', 20, 12),
    mk(3, 'up', 12, 32), // high 32 > 起点 30 → 破坏
    mk(4, 'down', 32, 25),
    mk(5, 'up', 25, 28)
  ]
  const r = c.segmentScan(strokes, 0)
  assert.strictEqual(r.segments.length, 2)
  const d0 = r.segments[0]
  assert.strictEqual(d0.dir, 'down')
  assert.strictEqual(d0.finished, true)
  assert.strictEqual(d0.destroyed, true, '标记破坏终结')
  assert.deepStrictEqual([d0.fromRaw, d0.toRaw], [0, 15], '终结于破坏笔起点 s3.from')
  const n1 = r.segments[1]
  assert.strictEqual(n1.dir, 'up', '新段反向')
  assert.strictEqual(n1.fromRaw, 15, '新段从破坏笔开始，首尾相接')
  assert.strictEqual(n1.finished, false)
  // 恢复扫描协议：最后锚点 = 新段起点
  assert.strictEqual(r.confirmedSis[r.confirmedSis.length - 1], 3)
})

t('破坏：向上段被下跌超越起点 → 对称处理', () => {
  const strokes = [
    mk(0, 'up', 100, 110),
    mk(1, 'down', 110, 105),
    mk(2, 'up', 105, 108),
    mk(3, 'down', 108, 95), // low 95 < 起点 100 → 破坏
    mk(4, 'up', 95, 99)
  ]
  const r = c.segmentScan(strokes, 0)
  assert.strictEqual(r.segments.length, 2)
  assert.strictEqual(r.segments[0].destroyed, true)
  assert.deepStrictEqual([r.segments[0].fromRaw, r.segments[0].toRaw], [0, 15])
  assert.strictEqual(r.segments[1].dir, 'down')
  assert.strictEqual(r.segments[1].fromRaw, 15)
})

t('破坏 guard：段不足 3 笔时不触发（避免 1-2 笔退化段）', () => {
  const strokes = [
    mk(0, 'down', 30, 5),
    mk(1, 'up', 5, 32) // 高 32 超起点 30，但段仅 1 笔 → 忽略
  ]
  const r = c.segmentScan(strokes, 0)
  assert.strictEqual(r.segments.length, 1, '单条开口段')
  assert.strictEqual(r.segments[0].finished, false)
  assert.strictEqual(r.segments[0].destroyed, undefined)
})

t('破坏开关：destroyOnBreach=false 回到纯字面规则（段吞反弹）', () => {
  const strokes = [
    mk(0, 'down', 30, 5),
    mk(1, 'up', 5, 20),
    mk(2, 'down', 20, 12),
    mk(3, 'up', 12, 32),
    mk(4, 'down', 32, 25),
    mk(5, 'up', 25, 28)
  ]
  const off = c.normalizeConfig({ segment: { destroyOnBreach: false } })
  const r = c.segmentScan(strokes, 0, off)
  assert.strictEqual(r.segments.length, 1, '无破坏：单条开口段')
  assert.strictEqual(r.segments[0].destroyed, undefined)
})

// ---------------------------------------------------------------------------
// 边界：笔数不足、无重叠起点、单笔起点
// ---------------------------------------------------------------------------
t('笔数不足 3 → 无线段', () => {
  const strokes = [mk(0, 'up', 100, 110), mk(1, 'down', 110, 100)]
  assert.strictEqual(c.segmentScan(strokes, 0).segments.length, 1)
  assert.strictEqual(c.calcSegments(strokes, c.normalizeConfig()).length, 0)
})

t('全量增量一致性不受线段修复影响（逐根 update）', () => {
  const bars = require('./helpers').randomWalk(200, 2024)
  const cfg = { biMinGap: 4 }
  const a = c.createAnalyzer(cfg)
  a.update(bars.slice(0, 40))
  for (let i = 40; i < bars.length; i++) {
    a.update(bars.slice(i, i + 1))
    assert.deepStrictEqual(a.state, c.analyze(bars.slice(0, i + 1), cfg), 'bar ' + i)
  }
})
