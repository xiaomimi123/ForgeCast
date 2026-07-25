# 候选详情 / 产品说明书 设计（看板改进 B）

> 日期：2026-07-25　状态：设计已确认，待写实施计划
>
> 看板改进三件套之 B（A 全部重新评分 ✅、C 分类筛选 ✅ 均已合入 main，B 最后做）。

## 目标

看板卡片信息太少（只有一句 description + 三维分 + 目标群体/痛点）。给每个可商用候选加「详情 / 产品说明书」：点卡片「详情」按钮 → 弹窗 → LLM 读 README 生成结构化深度介绍（一段话简介 / 核心功能讲解 / 目标用户 / 行业痛点 / 换皮卖点），**按需生成、DB 缓存复用**，方便判断产品是否值得立项。

## 内容形态（intro_detail schema）

候选表 `candidates` 加一列 `intro_detail TEXT`（JSON，和 `score_detail` 同款；`db.ts` 里 `ensureColumn(db, 'candidates', 'intro_detail', 'TEXT')` 迁移，兼容旧库）。

B **只生成 README 才能给出的深度内容**，不重复评分（score_detail）已产出的字段：

```ts
interface IntroDetail {
  summary: string      // 一段话产品介绍（2-4 句，说清是什么、解决什么）
  features: string[]   // 核心功能讲解，每条「功能名 + 一句作用」，3-8 条
  targetUser: string   // 目标用户画像（比 score_detail.targetBuyer 更展开）
  painPoint: string    // 行业痛点（展开）
  rebrandIdea: string  // 换皮改造 / 变现卖点建议
  generatedAt: string  // ISO 时间字符串，弹窗显示「生成于…」
}
```

弹窗展示 = 上面 5 段 **+ 复用已有评分区**（三维色条 + 评分说明 `score_detail.rationale`，直接读候选已有的 `score_detail`，**不重新生成**）。说明书讲产品、评分归评分，DRY、互不覆盖。

## 生成能力（scout 包，镜像 rescoreCandidate）

`packages/scout/src/intro.ts` 新增：
`generateCandidateIntro(ctx: CoreCtx, id: number, opts?: { onProgress?: (m: string) => void }): Promise<IntroDetail>`

- 按 `id` 取候选元数据（repo/description/tech_stack）；候选不存在 → throw。
- 按 `ctx.config.llm.mode` 分支：
  - **mock → `heuristicIntro(meta, readme)`**：README/description 关键词确定性拼出各字段（features 至少 3 条、字段非空），**离线可跑、供单测，绝不走 `ctx.llm`**（遵循「每个 LLM 能力自带 mock」规则）。
  - **live → 抓 README** `gh.fetchReadme(repo)` + 模板 prompt `templates/prompts/candidate-intro.md` + `ctx.llm.complete({ model: ctx.config.llm.models.analysis, system, prompt })`（复用 analysis 模型名，不新增配置）→ 解析 JSON（`parseIntroJson`，剥 ```json 围栏后 JSON.parse）。
- **校验** `validateIntro(d)`：`summary/targetUser/painPoint/rebrandIdea` 均非空串、`Array.isArray(features) && features.length >= 3 && 每条非空`；不合格 → throw（弹窗报错、不缓存脏数据）。
- `generatedAt`：在 `generateCandidateIntro` 内用 `new Date().toISOString()` 填入返回对象（mock/live 两支都填）。server 运行时 `Date` 正常可用（仅 Workflow 脚本禁用 Date，这里不是）。

prompt 模板 `templates/prompts/candidate-intro.md`：要求严格输出上表 JSON（字段名、features 为字符串数组、3-8 条），system = 「你是开源项目产品分析专家，只输出给定 JSON 结构，不要多余文字」。README 截断 `slice(0, 8000)`。

## 后端路由

`packages/server/src/app.ts` 新增 `POST /api/candidates/:id/intro`，body `{ force?: boolean }`：

1. `id` 无对应候选 → 404。
2. **mock 模式**（`ctx.config.llm.mode === 'mock'`）→ 直接返 `{ mode: 'mock' }`，**不生成不缓存**（同 rescore-all mock 早返回，对齐「mock 不空跑」）。
3. 候选已有 `intro_detail` 且 `!force` → 返 `{ mode: 'live', cached: true, intro }`（解析缓存，秒开）。
4. 否则 `const intro = await generateCandidateIntro(ctx, id)` → `UPDATE candidates SET intro_detail = ? WHERE id = ?` → 返 `{ mode: 'live', cached: false, intro }`。
5. 生成抛错（README 抓取失败 / LLM / 校验失败）→ 500 + 错误消息（前端弹窗提示）。

**候选列表接口 `GET /api/candidates` 不带 `intro_detail`**：把现有 `SELECT *` 改成显式列清单（不含 `intro_detail`），避免 200+ 条 × 每条几 KB 拖垮列表 payload。详情只经上面的专用接口取。

## 前端

### `apps/web/src/api.ts`
新增类型 `IntroDetail`（同上）与 `IntroResponse = { mode: 'mock' } | { mode: 'live'; cached: boolean; intro: IntroDetail }`。`Candidate` 类型**不加** `intro_detail`（列表不返）。

### `apps/web/src/pages/board/CandidateCard.tsx`
- 底部按钮行加「详情」按钮（挨着 立项 / 重新评分，**不劫持** repo 链接与现有按钮）。
- 仅对可商用候选渲染（BoardPage 只把 `ok` 卡片给 CandidateCard，天然满足）。
- 点击 → 通过回调 `onOpenDetail(c)` 让 BoardPage 打开弹窗（弹窗状态提在 BoardPage，避免每卡各建）。

### `apps/web/src/pages/board/CandidateDetailModal.tsx`（新）
- props：`candidate`（含 repo/score_detail 等）、`onClose`。
- 打开时 `POST /api/candidates/:id/intro`（用 mutation 或 `useQuery` keyed `['intro', id]`，enabled 当有 candidate）→ loading 转圈。
- 渲染：标题（repo + license + category 徽章）→ 5 段结构化内容（summary 段落 / features 列表 / targetUser / painPoint / rebrandIdea）→ 评分区（复用三维色条组件 + rationale，从 `candidate.score_detail` 解析）→ 底部「生成于 generatedAt」+「重新生成」按钮（`force:true` 重取、覆盖缓存）。
- `mode === 'mock'` → 不渲染 5 段，显示提示「详细介绍需 live 大模型，请先在『设置』切 live 并填 key」。
- 生成失败 → 弹窗内显示错误 + 重试按钮。
- 遮罩点击 / ✕ / Esc 关闭。

### `apps/web/src/pages/BoardPage.tsx`
- 新增 `const [detailOf, setDetailOf] = useState<Candidate | null>(null)`；传 `onOpenDetail={setDetailOf}` 给 CandidateCard；`detailOf && <CandidateDetailModal candidate={detailOf} onClose={() => setDetailOf(null)} />`。

## Fail-soft / 边界

- README 抓取失败 / LLM 超时 / JSON 解析失败 / 校验不过 → 生成抛错 → 500 → 弹窗提示可重试；**不写入脏缓存**。
- mock 模式 → 提示切 live，不空跑、不缓存。
- 缓存命中非 force → 不调 LLM、不抓 README，秒开。
- 「重新生成」force → 覆盖旧缓存（用户主动，消耗额度，可接受）。
- 协议不可商用候选（blocked）→ 无卡片、无详情入口。

## 测试

| 层 | 用例 |
|---|---|
| `heuristicIntro`（scout，纯） | 给定 README/meta → 返回结构合法（features≥3、5 文本字段非空）；确定性（同输入同输出） |
| `generateCandidateIntro`（scout） | mock 模式 → 走 heuristicIntro 出合法结构；live（mock ctx.llm 返合法 JSON）→ 解析并通过校验；ctx.llm 返 malformed / 缺字段 → throw（不返脏数据）；候选不存在 → throw |
| `validateIntro` / `parseIntroJson`（scout，纯） | 缺字段 / features<3 / 空串 → 判失败；带 ```json 围栏的合法 JSON → 解析成功 |
| server intro 路由 | mock 模式 → `{mode:'mock'}` 且候选 intro_detail 仍为 NULL（不写库，用 mock ctx）；有缓存非 force → 返 `cached:true` 不生成；force → 重生成写库；未知 id → 404 |
| server 列表 | `GET /api/candidates` 返回不含 `intro_detail` 字段 |
| 前端 | 主控里程碑真跑：live 下点「详情」→ 生成 5 段 + 评分区 → 「重新生成」覆盖 → mock 模式点则提示切 live |

（真 LLM 生成质量由主控里程碑 live 验证；单测用 mock ctx.llm 覆盖分支/校验/缓存决策，不打网络。）

## 不做

- 批量预生成（浪费额度，绝大多数候选不会被看）。
- 评分时顺带生成（耦合、对全部候选重算、慢）。
- markdown 自由长文说明书（已选结构化分节）。
- 协议不过候选的详情。
- 详情内容参与看板筛选 / 搜索（本轮只「看」）。
