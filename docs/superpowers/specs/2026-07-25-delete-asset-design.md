# 删除视频素材 设计

> 日期：2026-07-25　状态：设计已确认，待写实施计划

## 目标

素材工坊里视频素材越攒越多（测试渲染），需要能删。给视频卡片加"删除"按钮，删除时同时删 DB 记录 + 磁盘视频文件。硬删（前端二次确认），有关联询单的素材拦下不删（保护归因数据）。

**范围**：删除逻辑做成通用 `deleteAsset`（任意素材类型），但 UI 只在视频卡片露出删除按钮。

## 架构

沿用现有分层：`packages/ops`（素材生命周期：approve/publish/perf/lead 已有）加删除函数 → `packages/server` 加 DELETE 路由 → `apps/web` 视频卡片加按钮。

## 组件与接口

### ① ops 逻辑：`packages/ops/src/lifecycle.ts`
`deleteAsset(ctx: CoreCtx, assetId: number): void`：
1. 查 `assets` 行，不存在 → `throw new Error('素材不存在')`。
2. **护栏**：`SELECT COUNT(*) FROM leads WHERE asset_id = ?` > 0 → `throw new Error('该素材有关联询单，不能删除')`。
3. 删磁盘文件：`path.join(ctx.config.paths.workspace, row.file_path)`——**仅当解析后的绝对路径落在 workspace 内**（`path.resolve` + `startsWith(workspace + sep)`，防 `../` 穿越）**且文件存在**才删；文件已不在则跳过（不报错）。
4. `DELETE FROM assets WHERE id = ?`。

### ② API：`packages/server/src/app.ts`
`DELETE /api/assets/:id`：
- 素材不存在（`assetExists` 为假）→ 404。
- 调 `deleteAsset`；`try/catch`：错误 message 含 `'询单'` → 409 + `{ error: message }`（护栏）；其它错 → 500 + `{ error: message }`。
- 成功 → 200 `{ ok: true }`。

（`assetExists(id)` helper 已存在，可复用做 404 判断。）

### ③ 前端：`apps/web/src/components/AssetCard.tsx`
视频分支（`asset.type === 'video'`）加"删除"按钮：
- `onClick` → `window.confirm('删除这个视频？文件和记录都会删掉，不可恢复')`，确认才发 `DELETE /api/assets/${asset.id}`。
- 成功后 `qc.invalidateQueries` 刷新素材列表（沿用卡片里 approve mutation 同款 useMutation + queryClient 模式）。
- 删除失败（如 409 有询单）→ `alert` 提示后端 error 文案。

## Fail-soft / 边界
- 磁盘文件已不在（手动删过）→ 仍删 DB 行，不报错。
- 有关联询单 → 拦下（409），不删。
- 路径穿越防护：`file_path` 来自 DB（我们写入的相对路径），仍做 `startsWith(workspace)` 边界检查（与仓库 `/files/*` 一致）。
- 删除的是单条素材；不连带删封面/文案（各自独立素材）。

## 测试
| 层 | 用例 |
|---|---|
| `ops.deleteAsset` | 删行 + 删文件（临时文件真删掉验证）；文件缺失仍删行不崩；有 leads → 抛"询单"错、行/文件都不动；不存在 id → 抛错 |
| server `DELETE /api/assets/:id` | 存在→200 且行没了；不存在→404；有 leads→409 |
| 前端 | 手动走查：视频卡点删除→confirm→列表刷新消失；有询单的删除弹后端提示 |

## 不做
- 批量删除、删视频连带删封面/文案、回收站/撤销（直接硬删 + 前端 confirm）。
- 软删除（status 标记）——本设计是硬删（删行 + 删文件）。
