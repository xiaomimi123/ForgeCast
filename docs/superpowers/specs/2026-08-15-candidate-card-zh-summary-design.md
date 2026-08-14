# 候选卡片中文简介 设计

## 背景

找项目面板候选卡片中间目前直接渲染 `c.description`——GitHub 仓库的原始英文 description（如 `ant-design-pro` 显示 "Use Ant Design like a Pro!"）。用户看卡片时光凭仓库名 + 英文一句话，经常猜不出这个项目具体是做什么的，需要一个中文简介。

## 设计

### 数据来源

`packages/scout/src/types.ts` 的 `ScoreDetail` 新增一个字段：

```ts
summaryZh: string // 这个项目是做什么的，一句话中文说明；mock 下为空串（不编造）
```

`packages/scout/src/score.ts` 的 `scoreCandidate`（live 分支）prompt 的 JSON 输出契约里加一项：

```
"summaryZh":"这个项目是做什么的，一句话，中文"
```

不新增 LLM 调用——复用现有评分调用（已经读 README），零额外成本。`heuristicScore`（mock 分支）不生成翻译（没有 LLM 可用），留空串，与现有 `targetBuyer`/`painPoint` 在 mock 下留空串的约定一致（"mock 不编造比编造假数据更好"）。

`parseScoreJson` 解析结果时按现有 `targetBuyer`/`painPoint` 同样的模式加一行 `summaryZh: typeof o.summaryZh === 'string' ? o.summaryZh : ''`。

### 展示

`apps/web/src/pages/board/CandidateCard.tsx`：
- `Detail` 接口加 `summaryZh: string`，`parseDetail` 里用 `str(o.summaryZh)` 解析（复用文件里已有的 `str()` 兜底函数）。
- 原来的 `<div className="line-clamp-2 ...">{c.description ?? ''}</div>` 改成 `{d?.summaryZh || c.description || ''}`——有中文简介优先显示中文，没有（mock 下 / 候选还没被评过分）时回落英文原文，和卡片里"谁掏钱"/"为何掏"字段的回落风格一致。

### 影响范围

现有已评过分的候选（39 个）不会自动获得中文简介，要等下次重新评分（"全部重新评分"按钮，或候选池低分淘汰功能里如果做了自动补评分那一步）才会补上——不做批量回填，复用现有工具链即可。

## 测试

`packages/scout/test/score.test.ts`：`heuristicScore` 返回 `summaryZh: ''`；live 分支解析 JSON 时 `summaryZh` 缺失/非字符串都按空串兜底（仿现有 `targetBuyer`/`painPoint` 用例）。

前端不加自动化测试（`CandidateCard` 无组件测试先例），走 `pnpm --filter web exec tsc --noEmit` + 浏览器人工确认卡片显示中文简介、mock/未评分候选正确回落英文。

## 不做的事

- 不批量回填已有候选的中文简介。
- 不新增独立的翻译 LLM 调用，复用评分调用。
- 不改候选详情抽屉（`CandidateDrawer.tsx`）的展示逻辑（本次只动卡片列表）。
