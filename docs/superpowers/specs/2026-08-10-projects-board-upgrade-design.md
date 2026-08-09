# 「拆解需求」板块升级设计（泳道真实联动 + 立项信息继承 + 卡点编辑器归位）

> 日期：2026-08-10　状态：已实施合入 main

## 背景

`/projects`「拆解需求」板块按开发文档 §8 应是流水线决策中枢：把已立项的开源项目拆解成 `analysis.md`（商业化拆解）+ `rebrand-plan.md`（改造拆解），下游「做内容」读的就是这里的产出。审计发现三个实现缺口：五条泳道是纯装饰（`stage` 无枚举约束、无自动推进，拖动只写一个字符串）；立项时候选卡片已生成的产品说明书/评分明细全部丢失；`CutPlanEditor`（依赖 `shots/`，视频剪辑用）放在了项目详情页而非「做内容」。本次修复这三项；rebrand 的 Web 入口（后端已就绪、页面无按钮）本轮不做。

## 1. stage 单一真源 + 自动推进

`packages/core/src/stage.ts` 新增：

```ts
export const STAGES = ['analysis', 'rebranding', 'producing', 'publishing', 'selling'] as const
export type Stage = (typeof STAGES)[number]
export function isStage(v: unknown): v is Stage
export function advanceStage(db, projectId, target: Stage): void  // 只前进不后退，按数组下标比较
```

前端 `apps/web/src/pages/board/StageLanes.tsx` 保留一份带中文标签的平行声明（web 不依赖 core），改动需两边同步。

**自动推进映射**（四段全自动，规则：只向前不回退；手拖 PATCH 路径不受此约束，用户仍可任意移动）：

| 触发 | 落点 | 目标 stage |
|---|---|---|
| `analysis.md` 写盘成功 | `packages/analyst/src/analyze.ts` | `rebranding` |
| 首条文案 asset 落库 | `packages/copywriter/src/generate.ts` | `producing` |
| 首条视频 asset 落库 | `packages/studio/src/generate.ts`（`renderAndRegister`） | `producing` |
| 素材回填发布 | `packages/ops/src/lifecycle.ts`（`publishAsset`） | `publishing` |
| 登记一条询单 | `packages/ops/src/lifecycle.ts`（`addLead`） | `selling` |

后端 `PATCH /api/projects/:slug` 新增校验：`body.stage` 存在但 `!isStage(...)` → `400 { error: '非法 stage' }`，防止手误写脏值把卡片顶出所有泳道。

## 2. 泳道真实产物计数

`GET /api/projects` 附 `counts: { copies, videos, published, leads }`，两条聚合 SQL（非 N+1）：

```sql
SELECT project_id, SUM(type='copy') copies, SUM(type='video') videos, SUM(status='published') published
  FROM assets GROUP BY project_id
SELECT a.project_id, COUNT(*) leads FROM leads l JOIN assets a ON a.id = l.asset_id GROUP BY a.project_id
```

卡片底部按非零项拼一行 `文案 N · 视频 N · 已发 N · 询单 N`，全 0 不渲染。`GET /api/projects/:slug` 详情接口不带 counts（看板专用）。

## 3. 立项信息继承

`pickCandidate` 原来只写 `slug + candidate_id`，候选卡片已生成的 `intro_detail`（产品说明书）/`score_detail`（评分明细，含 targetBuyer/painPoint）一个字段都没带过去。改为**读取侧 JOIN**（零迁移、老项目也立即生效）：

```sql
SELECT p.*, c.intro_detail, c.score_detail
FROM projects p LEFT JOIN candidates c ON c.id = p.candidate_id
```

- **泳道卡片**：买家/痛点三级回退 —— `analysis_summary`（analysis.md 摘要）→ `score_detail` 解析（`parseDetail`，复用 `CandidateCard.tsx`）→ `intro_detail.targetUser/painPoint`。三者皆空才显示「未分析 · 点开生成分析」。
- **项目详情页**：`analysisMd` 为空时，渲染 `intro_detail` 五节（产品简介/核心功能/目标用户/行业痛点/换皮卖点）+ 提示「以下来自候选期说明书，点上方生成正式分析」。五节渲染抽成共享组件 `apps/web/src/pages/board/IntroSections.tsx`，`CandidateDrawer.tsx`（候选期）与 `ProjectDetailPage.tsx`（立项后回退）两处共用，避免第三份平行 JSX。

两字段必须容忍 NULL：`intro_detail` 只在 live 模式且用户开过候选抽屉时才有；mock 模式下 `score_detail.targetBuyer/painPoint` 是空串。

## 4. CutPlanEditor 归位

`CutPlanEditor`（卡点方案：读 `workspace/<slug>/shots/`，服务视频剪辑节奏）职责属于「做内容」而非「拆解需求」。从 `ProjectDetailPage.tsx` 摘除，移到 `WorkshopPage.tsx` 下方全宽（320px 侧栏放不下卡点列表，沿用原来的做法）。

```tsx
{selected && <CutPlanEditor key={selected} slug={selected} />}
```

`key={selected}` 是必须的：`selected` 初始可能是空串（避免打 `/api/projects//cutplan`），且组件内部 `plan` state 切项目时不会自动清空（`.catch(()=>{})` 静默失败），用 `key` 强制重挂载防止残留上一个项目的卡点方案。

## 验证

- `pnpm test` 全仓回归：新增 `core/stage.test.ts`、`ops/lifecycle.test.ts` 补的推进/不回退用例、`server/projects.test.ts` 补的 stage 校验/counts/继承用例，均通过。
- 浏览器实测：`ant-design-pro` 重新生成 analysis.md 后自动从「分析」跳到「换皮」（live LLM 耗时约 60-90s，非阻塞验证时需相应等待）；`demo-project` 已有文案时看板显示「文案 1」。
- `pnpm --filter web exec tsc --noEmit` + `pnpm --filter web build` 通过。
