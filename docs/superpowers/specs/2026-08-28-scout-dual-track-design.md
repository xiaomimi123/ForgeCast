# 找项目页重做——双轨评分 + 热点雷达（子项目②）设计

> 日期：2026-08-28　状态：设计已确认，待实施
>
> 设计稿：`~/Desktop/ForgeCast-UI设计稿.html`（同子项目①）
>
> 全站重设计拆成 4 个子项目，本 spec 是②：
> ①视觉基础+导航壳（已完成，merged）
> **②找项目页重做（本 spec）**——双轨评分+热点雷达
> ③拆解页重做（四关验收+盖章）—— 未开始
> ④做内容/分发/定制视觉套用 —— 未开始

## 目标

在现有找项目页新增一个"双轨评分" tab，把候选按"利润款"（能换皮成商业产品交付给中小老板）/"引流款"（技术含量普通人看不懂但演示效果强、适合拍内容引流）分成两张榜单，各自用不同维度打分；再加一张"热点雷达"预警卡，提示最近发现的高星新项目。

## 非目标

- 不改现有 `rebrandCost`/`buyerClarity`/`visualAppeal` 三维评分和 `score` 列——继续原样驱动"全部/已收藏/每日新增/自主投喂"四个老 tab，不动它们的展示逻辑。
- 不做子项目③的"四关验收+盖章"。
- 不新增后端聚合接口——热点雷达直接复用页面已经在用的 `candidates` 查询结果做前端筛选，不额外调用 `scoutBreakouts`。
- 不做真正的"需求热度×安装门槛×受众小白度"三元乘法计算器——选型总纲公式卡是静态说明文案，不是实时计算组件。
- 老候选（`score_detail` 里没有 `track` 字段的）不出现在新 tab 里，不强行补分类。

## 1. 数据模型扩展（`packages/scout/src/types.ts`）

`ScoreDetail` 新增字段，全部可选（保证老数据/老代码兼容）：

```ts
export type Track = 'profit' | 'traffic'

export interface ScoreDetail {
  // ——— 以下字段不变 ———
  rebrandCost: number
  buyerClarity: number
  visualAppeal: number
  techStack: string[]
  rationale: string
  targetBuyer: string
  painPoint: string
  summaryZh: string
  category: string
  // ——— 新增，可选（缺失=老候选未分轨，不进新 tab）———
  track?: Track
  gapScore?: number      // profit 专属：差价分 0-100
  threshold?: number     // profit 专属：安装/使用门槛 0-100（越高越离不开现成产品）
  exitRoutes?: string[]  // profit 专属：交付方式，取自 ['托管','定制','一键包']，可多选
  emotionScore?: number  // traffic 专属：情绪值 0-100
  wowScore?: number      // traffic 专属：爽感 0-100（3秒内能不能看懂效果）
}
```

## 2. LLM 打分（`packages/scout/src/score.ts`）

### live 模式：一次调用扩展 prompt

在现有 `scoreCandidate` 的 prompt 里，三维打分要求后面追加：

```
再判断这个项目更适合两条路线中的哪一条，输出 track 字段：
- "profit"（利润款/交付线）：能改造成商业产品直接卖给中小老板，走"立项→换皮→交付"流程
- "traffic"（引流款/仅内容线）：技术含量普通老板看不懂用不上，但演示效果强，适合拍视频引流吸粉，不适合真的卖给客户

如果 track 是 "profit"，额外输出：
- gapScore 差价分(0-100)：普通人搞不定、但换皮后低成本能搞定的差价空间有多大
- threshold 门槛(0-100)：这东西对非技术人员的安装/使用门槛
- exitRoutes：从 ["托管","定制","一键包"] 里选出适合的交付方式，可多选，输出数组

如果 track 是 "traffic"，额外输出：
- emotionScore 情绪值(0-100)：内容传播情绪强度（惊讶/爽感/焦虑等能带来转发的情绪）
- wowScore 爽感(0-100)：3秒内能不能看懂效果、够不够炫
```

`parseScoreJson` 相应扩展：`track` 只接受 `'profit'|'traffic'`，其余值按 `undefined` 处理（不强行归类）；`gapScore`/`threshold`/`emotionScore`/`wowScore` 用现有 `clamp(v, 100)` 模式（上限固定 100，不像三维评分那样走可配置 `weights`——这两条新轨道不接入现有"评分权重"设置页那三个滑块，避免用户以为能调新轨道权重）；`exitRoutes` 校验是 `['托管','定制','一键包']` 子集数组，非法值丢弃（不新增到白名单外的自由文本，避免脏数据）。

### mock 模式：确定性启发式（不新增网络/LLM 调用）

复用 `heuristicScore` 已经在算的关键词命中结果：

```ts
// 复用 buyerClarity 已经算过的关键词命中（有明确垂直场景关键词 → profit，否则 → traffic）
const hasVertical = has(/crm|invoice|chat|booking|shop|commerce|pos|survey|form/)
const track: Track = hasVertical ? 'profit' : 'traffic'
if (track === 'profit') {
  return {
    ...现有字段,
    track,
    gapScore: Math.round((buyerClarity / weights.buyerClarity) * 100),
    threshold: Math.round((rebrandCost / weights.rebrandCost) * 100),
    exitRoutes: ['托管'],   // mock 不编造多选组合，固定给一个保守值
  }
}
return {
  ...现有字段,
  track,
  emotionScore: Math.round((visualAppeal / weights.visualAppeal) * 100),
  wowScore: Math.round((visualAppeal / weights.visualAppeal) * 100),
}
```

## 3. 存储

`score_detail` 已经是整块 JSON 存字符串（`candidates.score_detail TEXT`），新字段随整个 `ScoreDetail` 对象一起序列化，**不需要新增 SQL 列、不需要 DB 迁移**。`score` 列、`ingest()`/`UPSERT` 逻辑完全不动。

## 4. 前端：新增"双轨评分" tab（`apps/web/src/pages/ScoutPage.tsx`）

`TABS` 数组追加 `{ key: 'dual', label: '双轨评分' }`，与现有 `all`/`fav`/`daily`/`manual` 四个平级。

新 tab 内容拆三块，建议新建 `apps/web/src/pages/board/DualTrackView.tsx` 承载（保持 `ScoutPage.tsx` 不过度膨胀）：

### 4.1 选型总纲卡片（静态说明，不接数据）

```tsx
<section className="card">
  <span className="eyebrow">选型总纲</span>
  <div className="mt-2 flex items-center gap-2.5 flex-wrap">
    <span className="text-lg font-black text-fire">差价</span>
    <span className="text-sub">=</span>
    <span className="border border-hairline-strong bg-paper px-3.5 py-1.5 rounded font-bold">需求热度</span>
    <span className="text-sub">×</span>
    <span className="border border-hairline-strong bg-paper px-3.5 py-1.5 rounded font-bold">安装门槛</span>
    <span className="text-sub">×</span>
    <span className="border border-hairline-strong bg-paper px-3.5 py-1.5 rounded font-bold">受众小白度</span>
  </div>
  <p className="mt-2.5 text-sm text-sub">官方已出一键安装包的项目自动降权——差价被官方吃掉了。GPL / AGPL 一票否决。</p>
</section>
```

### 4.2 热点雷达（读现有 `candidates` 数据筛选，不新增请求）

规则：`source === 'scout'` 且 `created_at` 在最近 48 小时内且 `stars >= 2000`（复用 `scoutBreakouts` 默认的 `minStars` 常量语义，但这里只是前端展示筛选，不触发抓取）。取命中里 `stars` 最高的一条展示：

```tsx
const hot = candidates
  .filter((c) => c.source === 'scout' && withinHours(c.created_at, 48) && c.stars >= 2000)
  .sort((a, b) => b.stars - a.stars)[0]

{hot && (
  <section className="card border-l-[3px] border-fire bg-fire-soft">
    <span className="eyebrow text-fire">热点雷达 · 快反窗口开启</span>
    <div className="mt-1.5 flex items-baseline gap-2.5 flex-wrap">
      <b>{hot.repo}</b>
      <time className="text-xs text-sub">发现于 {hoursAgo(hot.created_at)} 小时前 · ⭐{hot.stars}</time>
    </div>
    <div className="mt-2 flex items-center gap-2">
      <span className="text-xs font-semibold text-fire">建议 48h 内评估</span>
      <button className="btn ml-auto" onClick={() => setDetailId(hot.id)}>评估开跑</button>
      <button className="btn ghost" onClick={() => setDismissedHotId(hot.id)}>忽略</button>
    </div>
  </section>
)}
```

`withinHours`/`hoursAgo` 是两个小工具函数（复用 `ScoutPage.tsx` 已有的 `localDay` 同款 UTC 字符串解析方式）。"忽略"只是组件内 `useState` 记住 dismiss 的 id（不持久化到后端/localStorage——刷新页面后重新出现，是可接受的简单实现，避免为这么小的交互新增持久化机制）。

### 4.3 双轨表格

```tsx
const trackOf = (c: Candidate): Track | null => parseDetail(c.score_detail)?.track ?? null
const profitList = candidates.filter((c) => trackOf(c) === 'profit').sort(byGapScoreDesc)
const trafficList = candidates.filter((c) => trackOf(c) === 'traffic').sort(byEmotionDesc)
```

- 利润款榜：列 项目/差价分/门槛(bar)/出口(chips)/操作；`license_ok !== 1` 的行整行置灰、差价分显示"—"、出口列显示 `chip veto`"已淘汰"，操作列不显示"立项"按钮（复用现有协议门槛判定，不重复造轮子）。
- 引流款榜：列 项目/情绪值/爽感(bar)/操作（"出内容角度"按钮——先只做占位跳转到"做内容"板块，不新增专属跳转参数，避免子项目②牵连子项目④的做内容页改动）。
- 两张表都用现有 `CandidateCard`/表格早已有的样式类（`.chip`/`.bar`），复用子项目①已经加好的 `.chip`/`.eyebrow` CSS，不新增组件类。

## 5. 验收标准

- `pnpm --filter @forgecast/scout test` 全绿，新增 mock 分轨测试（GPL/传统关键词 fixture 各验一次 track 归类）。
- `pnpm --filter web exec tsc --noEmit` 通过。
- 浏览器手动过一遍："双轨评分" tab 能看到选型总纲卡+（如果近48h有高星候选）热点雷达卡+两张表；老四个 tab 行为/数据不受影响；老候选（没 track）不出现在双轨表里但仍在"全部" tab 正常显示。
