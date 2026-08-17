# 缠论图表 · Chanlun Chart

分型 · 笔 · 线段 · 中枢 的确定性实现 + 加密货币实时图表（KLineChart v10）。

## 架构

```
index.html     脚本按依赖顺序加载（无构建步骤）
│
├─ src/                缠论算法核心（独立模块，UMD 风格，浏览器/Node 双端可用）
│  ├─ config.js        配置：全部规则参数化（bi.minGap / fractal.mode / center.minElements…）
│  ├─ merge.js         包含关系处理（mergeBars 全量 / resumeMerge 增量续接）
│  ├─ fractal.js       分型识别（calcFractals 全量 / resumeFractals 尾部重判 / 全局交替过滤）
│  ├─ stroke.js        笔（可回放状态机 createStrokeMachine）
│  ├─ segment.js       线段（特征序列法，segmentScan 可恢复扫描）
│  ├─ center.js        中枢（区间重叠 + 延伸）
│  └─ analyzer.js      增量计算（createAnalyzer：update / updateLast）
├─ chanlun.js          模块装配层 → window.chanlun / module.exports（API 与旧版单文件一致）
├─ data-layer.js       可靠数据层：K线缓存、指数退避重试、WS 自动重连、图表加载器
├─ realtime.js         实时行情更新策略（内容签名判末根变化，P0 修复）
├─ main.js             图表集成（klinecharts v10 + 交易所适配 + 缠论绘制）
└─ tests/              零依赖测试（node tests/run.js）
   ├─ merge / fractal / stroke / segment / center / analyzer .test.js   各层单元 + 增量一致性
   ├─ segment-edge.test.js   线段判定边界（第二种情况/否定/确认/锚点恢复）+ 回归
   ├─ fixtures.js + fixtures.test.js   可复用测试数据 + 锁定结构
   ├─ data-layer.test.js    数据层单元测试（假 fetch/WS/定时器）
   ├─ realtime.test.js    实时更新策略（P0：对象复用场景回归）
   ├─ realtime-stress.test.js   5000 K 实时链路压测（原地跳动/收盘/新K，逐 tick 与全量一致）
   ├─ exchange-adapters.test.js   Binance/OKX 适配器契约 + 分页集成（vm 加载真实 main.js）
   ├─ live-network.test.js  真实网络压测（LIVE_NETWORK=1 启用，默认跳过）
   └─ browser-smoke.test.js 浏览器装配冒烟（vm 模拟，验证 index.html 脚本路径）
```

流水线：`原始K线 → 包含关系合并 → 分型 → 笔 → 线段 → 中枢`

## 实时行情更新策略（realtime.js）

klinecharts 在实时行情下会【复用同一个 K 线对象】并原地修改 OHLC（`bar.close = x`），
此时对象引用判断（`dataList[n-1] !== lastLastBar`）会漏判 —— 引用没变但内容已变，
缠论不刷新。`realtime.js` 改用**内容签名**判断：

```
barSignature(bar) = timestamp|open|high|low|close|volume|isBarClosed
```

更新策略（`createRealtimeUpdater`）：
- 首次 / 首根时间戳变化 / 首根内容变化 / 长度收缩 → `init`（整体重建）
- 长度增加 → `append`（增量 update）
- 长度不变但末根签名变化（原地跳动 / 收盘定型）→ `replaceLast`（updateLast 回退重放）
- 完全相同 → `skip`；任一步异常 → `error`（下次调用自愈重建）

## 运行测试

```bash
node tests/run.js            # 全部测试（87 项，不含真实网络）
LIVE_NETWORK=1 node tests/run.js tests/live-network.test.js   # 真实 Binance/OKX 链路压测
node tests/run.js tests/segment-edge.test.js   # 单文件
```

## 增量计算

`createAnalyzer` 首次全量，之后：
- `update(newBars)`：追加新K线，merge/fractal/stroke 三层精确增量
  （O(新K线数)），线段/中枢基于已增量更新的笔全量重扫（数量少、开销可接受、
  彻底避免锚漂移）；
- `updateLast(bar)`：替换末根（收盘定型），整链重建；
- 一致性由测试保证：增量结果与 `analyze(全部数据)` 逐字段一致。

## 线段判定（重点）

线段采用《教你炒股票》67/71 课特征序列法，状态机含 `pending`（第二种情况/缺口）
`pendingFeatures`（新线段特征序列）与否定判断（`negExtreme`）。

> ⚠️ 已修复（2024-08）：旧版在“缺口分型被否定”时 `features.concat(pendingFeatures)`，
> 把新线段方向（旧线段的非特征元素）混入旧线段特征序列、同时丢失待确认期间被
> 跳过的旧方向笔，导致线段终点漂移。差分探针在 4000 组随机笔序列中发现 202 组分歧。
> 现改为否定时把待确认期间被跳过的笔按正常分支重放（与“该缺口分型从未发生”等价）。
> 回归用例见 `tests/segment-edge.test.js`（seed 52 / 145 / 209）。

## 输出格式

`analyze()` / `createAnalyzer().state` 输出：

```
{
  merged,          // 合并后K线（含 rawIndices / rawMiddle / rawStart / rawEnd）
  fractals,        // 有效分型（笔端点）
  strokes,         // 笔（si/dir/from/to/fromRaw/toRaw/fromValue/toValue/high/low）
  segments,        // 线段（dir/from/to/fromRaw/toRaw/finished）
  strokeCenters,   // 笔中枢（startIndex/endIndex/startRaw/endRaw/zsLow/zsHigh）
  segmentCenters,  // 线段中枢
  dataLen
}
```

## 参数化

```js
chanlun.analyze(bars, {
  biMinGap: 4,                    // 笔内合并K线最小间隔（兼容旧参数）
  fractal: { mode: 'strict' },    // strict | relaxed
  segment: { method: 'feature-sequence' },
  center: { minElements: 3 }
})
```
