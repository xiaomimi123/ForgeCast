# 候选池低分自动淘汰 设计

## 背景

找项目面板 candidates 表当前 219 条，其中 202 条来自 2026-07-24 那一轮初始扫描。此后每日自动抓取（`scheduler.ts` `runAutoScout` → `scout.ts` `scoutCandidates`）固定搜 `DEFAULT_TOPICS` 14 个通用 SaaS 品类（crm/e-commerce/dashboard 等），`minStars:300` + `pushedAfter` 近 6 个月——这个组合的搜索空间已经接近饱和，符合条件的高星项目基本都被扫过一遍，所以每天真正"没见过的" repo 很少（08-10 新增 10 条、08-13 新增 1 条、08-14 新增 1 条，08-14 当天 found=208 但 added=0）。

用户反馈候选池里堆积了不少低分（评分靠后、大概率无法商业变现）的候选，希望定期自动清理，保持候选池精简。

**范围说明（已与用户对齐）**：本功能只解决"候选池太多低价值项目"，**不解决**"每日新增长期接近 0"——那是固定 topic 列表搜索空间饱和导致的，用户已明确选择暂不改动搜索策略（不扩大 topic、不降门槛、不换 GitHub Trending）。淘汰掉的候选保持 `dismissed` 状态常驻在库里，之后重新扫到同一个 repo 时（按 repo 是否存在于 `candidates` 表判定"新"）会被当作已存在跳过，不会重新计入"新增"——这是用户明确选择的语义（防止同一批低分 repo 反复进出候选池）。

## 现有数据摸底

- candidates 表：219 条，`status` 只有 `candidate`/`picked` 两种取值，无淘汰机制。
- 协议可商用（`license_ok=1`）的 101 条里：真正评过分（`score` 非空）的 39 条——分布 <30 分 1 个、30-49 分 5 个、50-69 分 13 个、70+ 分 20 个；另有 62 条协议 OK 但从未真正评分（`score` 为 NULL，多是历史扫描时超出 `scoutCandidates` 每轮 `limit:30` 评分上限、只登记未评分的）。
- `score` 总分范围 0-100（`rebrandCost` 0-30 + `buyerClarity` 0-40 + `visualAppeal` 0-30，见 `packages/scout/src/score.ts`）。

## 设计

### 淘汰阈值与判定

阈值固定为 **50 分**（硬编码，不做成设置页可调项——YAGNI，未来真要调再加）。淘汰对象：`license_ok=1 AND status='candidate' AND score < 50` → `status` 改为 `dismissed`。

未评分（`score IS NULL`）的候选不能直接判定，需要先补评分再按阈值判定——避免"从未评过所以躲过淘汰"的漏洞，也避免误杀本可能是高分项目。

### 组件

**`packages/scout/src/scout.ts` 新增 `cleanupCandidates`**：

```ts
export async function cleanupCandidates(
  ctx: CoreCtx,
  opts: { threshold?: number } = {},
): Promise<{ rescored: number; dismissed: number }>
```

逻辑：
1. 阈值取 `opts.threshold ?? 50`。
2. 查 `license_ok=1 AND status='candidate' AND score IS NULL` 的候选 id 列表，逐个调用已有的 `rescoreCandidate(ctx, id)` 补评分（复用现有函数，不重复实现评分逻辑）。计数 `rescored`。
3. 补评分完成后，重新查 `license_ok=1 AND status='candidate' AND score < threshold` 的候选 id 列表，逐个执行 `UPDATE candidates SET status='dismissed' WHERE id=?`。计数 `dismissed`。
4. 全程不删除任何行，不动 `score`/`score_detail`/其他字段，只改 `status`。

**`packages/server/src/scheduler.ts` `runAutoScout` 收尾追加清理**：

`runAutoScout` 现有逻辑（`scout(ctx, {onlyNew:true})` → 写 `auto_scout_last_result`）之后，紧接着调用 `cleanupCandidates(ctx, {threshold: 50})`，把返回的 `rescored`/`dismissed` 一并合并进同一份 `auto_scout_last_result` JSON（新增两个字段），这样 Scout 页面顶部的"上次：xxx 新增 N 个"状态行可以顺带带出淘汰信息，不用另起一套状态存储。若 `cleanupCandidates` 抛错，按现有 `runAutoScout` 的 try/catch 整体降级处理（清理失败不影响当天已经抓到的候选入库结果，也不阻断下一天重试）——但**清理阶段的错误需要单独捕获、合并到 `auto_scout_last_result` 里**（而不是让清理失败掩盖掉抓取本身是成功的事实），具体见下方"错误处理"。

不修改手动"抓取候选"按钮对应的 `POST /api/scout` 路径——那条路径直接调 `scoutCandidates`，不经过 `runAutoScout`，本次不动它（用户明确只要求接入"每日自动抓取流程"）。

### 错误处理

`runAutoScout` 现有结构是整个 try 块只有一个 catch，抓取成功但清理失败时不应该把 `auto_scout_last_result` 整体标记为 `error`（那样会掩盖"抓取其实成功了"的事实，且会让下次调度误判整体失败）。改法：

```ts
export async function runAutoScout(ctx: CoreCtx, scout: ScoutFn = scoutCandidates): Promise<void> {
  const started = new Date()
  try {
    const r = await scout(ctx, { onlyNew: true })
    let cleanup: { rescored: number; dismissed: number } | { cleanupError: string }
    try {
      cleanup = await cleanupCandidates(ctx, { threshold: 50 })
    } catch (err) {
      cleanup = { cleanupError: err instanceof Error ? err.message : String(err) }
    }
    setSettings(ctx.db, {
      auto_scout_last_run: localDate(started),
      auto_scout_last_result: JSON.stringify({ at: started.toISOString(), ...r, ...cleanup }),
    })
    console.log(`[forgecast] 每日自动抓取完成：发现 ${r.found}，新增 ${r.added}`)
  } catch (err) {
    // 抓取本身失败：维持现有整体降级逻辑不变
    ...
  }
}
```

`cleanupCandidates` 内部：`rescoreCandidate` 单个候选失败（网络/LLM 报错）不应该让整批清理中断——用 `for` 循环 + 单个 `try/catch` 吞掉单项失败（跳过该候选，不计入 `rescored`，留到下次自动清理再补），逻辑上与现有 `scoutCandidates` 里"单个 topic 失败不影响其他"的容错风格一致。

### 前端

`GET /api/candidates` 不改，仍返回全部候选（含 `dismissed` 状态的行）。

`apps/web/src/pages/ScoutPage.tsx`：
- `ok` 的定义从 `rows.filter((c) => c.license_ok === 1)` 改为 `rows.filter((c) => c.license_ok === 1 && c.status !== 'dismissed')`，这样"全部"「已收藏」「每日新增」三个 tab 都自动排除已淘汰候选（三者都基于 `ok` 派生）。
- 新增 `dismissed = rows.filter((c) => c.license_ok === 1 && c.status === 'dismissed')`。
- 在现有"另有 N 个协议不可商用"折叠区旁边（同一处，"全部" tab 内），新增一个同样的 `<details>` 折叠区："另有 N 个已淘汰（低分）"，列表项显示 `repo` + `score` 分数 + 外链，view-only，不带任何操作按钮（不做恢复功能，YAGNI）。

## 测试

- `packages/scout/test/scout.test.ts`：`cleanupCandidates` 新增用例——
  - 未评分候选先被补评分，再按补评后的分数判定阈值（构造一个补评分后低于阈值的候选，断言最终 `status==='dismissed'`）。
  - 已评分且低于阈值 → `dismissed`；已评分且达到阈值 → 保持 `candidate` 不变。
  - `license_ok=0` 或 `status='picked'` 的候选不受影响（不进入判定范围）。
  - 单个候选 `rescoreCandidate` 抛错时，其余候选的清理仍正常完成（不中断整批）。
- `packages/server/test/scheduler.test.ts`（若无则新建，仿现有 `runAutoScout` 测试模式）：`runAutoScout` 调用后 `auto_scout_last_result` 里包含 `rescored`/`dismissed` 字段；清理阶段抛错时 `auto_scout_last_result` 仍保留抓取本身的 `found`/`added` 等字段（不被清理错误整体覆盖）。
- 前端不额外加自动化测试（现有 ScoutPage 无组件测试先例），改动后走 `pnpm --filter web exec tsc --noEmit` 确认类型过，人工浏览器走查折叠区展示。

## 不做的事

- 不改 `DEFAULT_TOPICS`／`minStars`／`pushedAfter`／不接入 GitHub Trending——不解决"每日新增长期接近 0"，范围已与用户对齐。
- 不新增淘汰阈值的设置页配置项，硬编码 50。
- 不做"取消淘汰/恢复"按钮，已淘汰列表纯展示。
- 不修改手动"抓取候选"按钮（`POST /api/scout`）的行为，只接入每日自动抓取流程。
- 不删除任何候选行，只改 `status` 字段。
