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
│  ├─ center.js        中枢（区间重叠 + 延伸）
│  ├─ divergence.js    笔背驰（MACD 动量强度 + 大级别=线段动量确认）
│  └─ analyzer.js      增量计算（createAnalyzer：update / updateLast）
├─ chanlun.js          模块装配层 → window.chanlun / module.exports（API 与旧版单文件一致）
├─ data-layer.js       可靠数据层：K线缓存、指数退避重试、WS 自动重连、图表加载器
├─ realtime.js         实时行情更新策略（内容签名判末根变化，P0 修复）
├─ main.js             图表集成（klinecharts v10 + 交易所适配 + 缠论绘制）
└─ tests/              零依赖测试（node tests/run.js）
   ├─ merge / fractal / stroke / segment / center / divergence / analyzer .test.js   各层单元 + 增量一致性
   ├─ segment-edge.test.js   线段判定边界（第二种情况/否定/确认/锚点恢复）+ 回归
   ├─ fixtures.js + fixtures.test.js   可复用测试数据 + 锁定结构
   ├─ data-layer.test.js    数据层单元测试（假 fetch/WS/定时器）
   ├─ realtime.test.js    实时更新策略（P0：对象复用场景回归）
   ├─ realtime-stress.test.js   5000 K 实时链路压测（原地跳动/收盘/新K，逐 tick 与全量一致）
   ├─ draw.test.js    绘制可见窗口过滤回归（线段中枢横跨左边界漏画修复）
   ├─ exchange-adapters.test.js   Binance/OKX 适配器契约 + 分页集成（vm 加载真实 main.js）
   ├─ live-network.test.js  真实网络压测（LIVE_NETWORK=1 启用，默认跳过）
   └─ browser-smoke.test.js 浏览器装配冒烟（vm 模拟，验证 index.html 脚本路径）
```

流水线：`原始K线 → 包含关系合并 → 分型 → 笔 → 线段 → 中枢 → 笔背驰`

## 笔背驰（结合大级别走势动量）

`src/divergence.js`，判据分两层：

1. **局部（笔级别）**：向前找最近一根「可超越」的同向笔（遇到未创新高/新低的
   同向笔即停止回溯），两笔之间需存在笔中枢（中枢起于两笔之间，或单一延伸
   大中枢覆盖两笔——盘整背驰）。后笔创出极值但**动量强度**弱于前笔
   （强度比 < `divergence.minMomentumDrop`）→ 笔背驰。
2. **大级别（线段级别）确认**：后笔所在线段 vs 其前一条已完结同向线段比较动量：
   - 大级别动量同步衰减 + 线段方向与笔同向 → **强背驰**（confirmed）；
   - 大级别动量仍在扩张或无比价 → **弱背驰**（更可能是中枢震荡/回调）。

动量度量 = **单位K线 MACD 柱净面积**：`hist = 2*(DIF-DEA)`（12/26/9），
区间 Σhist 按移动方向定向后取绝对值再除以窗口K线数——归一化时长使不同长度
的两笔/两线段可公度，取绝对值兼容 0 轴上下穿越。

事件字段：

```
{
  si, kind: 'top'|'bottom', dir, prevSi,   // 背驰笔与被比较笔
  rawIndex, value, provisional,            // 位置；尾笔未定型标记
  momentum: { current, previous, ratio },  // 动量强度与比值
  bigLevel: { segmentSi, aligned, momentumRatio, fading },
  strength: 'strong'|'weak', confirmed
}
```

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
node tests/run.js            # 全部测试（108 项，不含真实网络）
LIVE_NETWORK=1 node tests/run.js tests/live-network.test.js   # 真实 Binance/OKX 链路压测
node tests/run.js tests/segment-edge.test.js   # 单文件
```

## 增量计算

`createAnalyzer` 首次全量，之后：
- `update(newBars)`：追加新K线，merge/fractal/stroke 三层精确增量
  （O(新K线数)），线段/中枢基于已增量更新的笔全量重扫（数量少、开销可接受、
  彻底避免锚漂移）；
- `updateLast(bar)`：替换末根（收盘定型/实时跳动），unmerge 回退末根贡献 → merge 层
  增量续接 → 分型窗口重判 → 笔公共前缀重放，仅尾部重扫；
- 一致性由测试保证：增量结果与 `analyze(全部数据)` 逐字段一致。

## 线段判定（重点）

线段采用《教你炒股票》67/71 课特征序列法，状态机含 `pending`（第二种情况/缺口）
`pendingFeatures`（新线段特征序列）与否定判断（`negExtreme`）。

每个线段附带 `features`（特征序列可视化数据）：扫描过程中实际用到的特征方向笔，
按原始顺序记录（不做包含合并），含确认分型的第三个元素；第二种情况确认时，
`pendingRaw` 作为新线段特征序列挂载。图表「特征序列」开关默认开启。

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
  segments,        // 线段（dir/from/to/fromRaw/toRaw/finished/features）
  strokeCenters,   // 笔中枢（startIndex/endIndex/startRaw/endRaw/zsLow/zsHigh）
  segmentCenters,  // 线段中枢
  divergences,     // 笔背驰事件（见「笔背驰」一节）
  dataLen
}
```

`segments[].features` 是**特征序列可视化数据**：该线段特征方向的原始笔（未做包含
合并），按扫描顺序记录，含确认分型的第三个元素；每项为
`{ si, dir, high, low, fromRaw, toRaw, fromValue, toValue }`。图表「特征序列」
开关默认开启，绘制为特征方向的虚拟K线（影线 + 开盘/收盘小横线）。

`segments[].mergedFeatures` 是**包含合并后的标准特征K线**（判定即基于它）：把包含
关系的特征元素就地合并（向上取高、向下取低，方向看前两个元素），每根合并K线的
`fromRaw/toRaw` 覆盖参与合并的全部原始笔、`fromValue/toValue` 为最左开盘到最右收盘。
图表「特征序列·合并」开关默认开启，以实体K线（实体+影线，沿用青/粉）叠加绘制。

## 图表可视化

- **K线配色**：默认西式（阳=绿 / 阴=红）；勾选「红涨绿跌」一键切换为中国习惯
  （阳=红 / 阴=绿），VOL / MACD 柱颜色同步切换。
- **中枢级别标注**：线段中枢（高级别）= 粗实线框 + 框内「线段中枢」标签 + 上下轨
  价格标签；笔中枢（低级别）= 细虚线框 + 框内「笔中枢」标签。二者均按方向着色
  （向上红 / 向下绿，方向 = 价格进入中枢前的最后一条线段方向），开关独立。
- **特征序列包含高亮**：「特征序列」图层中，被包含合并“吃掉”的原始特征笔以黄色
  高亮并加圆点标记，直观展示算法如何处理包含关系（青色/粉色为未被合并的独立笔）。
- **背驰标注**：
  - 强背驰 = **趋背**（线段动量同向衰减），实心圆点；弱背驰 = **盘背**，空心圆环；
  - 顶背驰 ▼ / 底背驰 ▲ 方向箭头 + 标签；
  - 当前笔与被比较笔之间用虚线连接，中点标注强度比（当前/前笔动量 %）；
  - 标签下方标注**面积数值** `A x · B y`（面积 = 单位强度 × 窗口K线数）。
- **MACD 副图面积高亮**（需开启 MACD）：背驰的两段走势在 MACD 副图上以半透明色
  高亮对应的柱状线区域（顶背驰红 / 底背驰绿），虚线连接两段，并在各自末端标注
  `A:`（背驰段）/ `B:`（基准段）面积数值。由 `CHAN_DIV` 指标附加到 MACD pane 实现。
  > ⚠️ 实现要点：`createIndicator({ name: 'CHAN_DIV', paneId }, true)` 必须传
  > `isStack=true`——klinecharts v10 `addIndicator` 在 `!isStack` 时会先
  > `removeIndicator({paneId})` 清空该 pane 内全部指标，漏传会把 MACD 一并删掉
  > （曾出现的真实故障：副图只剩孤立的「背驰面积」文字，MACD 消失）。回归用例见
  > `tests/browser-smoke.test.js`。
- **成交量均量线**：VOL 附带 MA5 / MA10 / MA20 均量线。

## 参数化

```js
chanlun.analyze(bars, {
  biMinGap: 4,                    // 笔内合并K线最小间隔（兼容旧参数）
  fractal: { mode: 'strict' },    // strict | relaxed
  segment: { method: 'feature-sequence' },
  center: { minElements: 3 },
  divergence: {
    macdFast: 12,                 // 动量度量 MACD 快线
    macdSlow: 26,                 // 慢线
    macdSignal: 9,                // 信号线
    minMomentumDrop: 0.9,         // 后笔动量 < 前同向笔 × 该值 → 局部背驰
    requireCenter: true           // 两笔间需存在笔中枢（趋势背驰口径）
  }
})
```
