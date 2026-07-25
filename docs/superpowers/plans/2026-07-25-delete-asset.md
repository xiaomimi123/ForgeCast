# 删除视频素材 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 素材工坊视频卡片加"删除"——硬删（删 DB 行 + 磁盘文件），有关联询单的拦下，前端二次确认。

**Architecture:** ops 层 `deleteAsset`（行+文件+询单护栏，路径限 workspace）→ server `DELETE /api/assets/:id`（404/409/200）→ web AssetCard 视频分支加按钮（confirm + mutation + 刷新列表）。

**Tech Stack:** TypeScript + pnpm monorepo + vitest + Hono(server) + React/react-query(web)。

## Global Constraints

- 硬删：删 `assets` 行 + `path.join(workspace, file_path)` 文件；文件已不在则跳过不报错。
- 护栏：`leads.asset_id` 指向该素材（COUNT>0）→ 抛错含 `'询单'` → server 映射 409。
- 路径安全：删文件前 `path.resolve` 后必须 `startsWith(path.resolve(workspace) + path.sep)`（防 `../` 穿越）。
- 通用 `deleteAsset`（任意类型），UI 只在 `asset.type==='video'` 卡片露按钮。
- 前端删除前 `window.confirm`；成功后 `qc.invalidateQueries({ queryKey: ['assets'] })`。
- 中文注释、中文提交、严格 TDD、Node22（`nvm use 22.23.1`，pnpm 用 `corepack pnpm`）。

---

### Task 1: ops.deleteAsset（行 + 文件 + 询单护栏）

**Files:**
- Modify: `packages/ops/src/lifecycle.ts`
- Test: `packages/ops/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `deleteAsset(ctx: CoreCtx, assetId: number): void`——查素材(无→抛错)；有 leads→抛 `'该素材有关联询单，不能删除'`；删文件(workspace 内且存在)；删行。

- [ ] **Step 1: 写失败测试**

追加到 `packages/ops/test/lifecycle.test.ts`（导入处补 `deleteAsset`；文件顶部已 import fs/os/path）：

```typescript
describe('deleteAsset', () => {
  it('删 DB 行 + 磁盘文件', () => {
    // 建一个 video 素材 + 真文件
    const rel = 'demo/videos/x.mp4'
    const abs = path.join(ctx.config.paths.workspace, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'fake')
    const info = ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1,'video','pain',?, 'draft')").run(rel)
    const id = Number(info.lastInsertRowid)
    deleteAsset(ctx, id)
    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id)).toBeUndefined() // 行没了
    expect(fs.existsSync(abs)).toBe(false)                                                // 文件没了
  })
  it('文件已不在仍删行不崩', () => {
    const info = ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1,'video','pain','demo/videos/gone.mp4','draft')").run()
    const id = Number(info.lastInsertRowid)
    expect(() => deleteAsset(ctx, id)).not.toThrow()
    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id)).toBeUndefined()
  })
  it('有关联询单 → 抛错，行与文件都不动', () => {
    const rel = 'demo/videos/y.mp4'; const abs = path.join(ctx.config.paths.workspace, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'fake')
    const info = ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1,'video','pain',?, 'draft')").run(rel)
    const id = Number(info.lastInsertRowid)
    ctx.db.prepare('INSERT INTO leads (asset_id, wechat) VALUES (?, ?)').run(id, 'wx1')
    expect(() => deleteAsset(ctx, id)).toThrow(/询单/)
    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id)).toBeDefined() // 行还在
    expect(fs.existsSync(abs)).toBe(true)                                              // 文件还在
  })
  it('不存在的 id → 抛错', () => {
    expect(() => deleteAsset(ctx, 99999)).toThrow(/不存在/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm --filter @forgecast/ops test lifecycle`
Expected: FAIL —— `deleteAsset` 未导出。

- [ ] **Step 3: 实现**

`packages/ops/src/lifecycle.ts`：顶部 import 补 `import fs from 'node:fs'` 和 `import path from 'node:path'`（现在只 import type CoreCtx）。加函数（放在 `approveAsset` 附近）：

```typescript
/** 硬删素材：删 DB 行 + 磁盘文件。有关联询单则拦下（保护归因数据）。文件缺失不报错。 */
export function deleteAsset(ctx: CoreCtx, assetId: number): void {
  const row = ctx.db.prepare('SELECT id, file_path FROM assets WHERE id = ?').get(assetId) as { id: number; file_path: string } | undefined
  if (!row) throw new Error(`素材不存在: ${assetId}`)
  const lead = ctx.db.prepare('SELECT COUNT(*) AS n FROM leads WHERE asset_id = ?').get(assetId) as { n: number }
  if (lead.n > 0) throw new Error('该素材有关联询单，不能删除')
  // 删文件：解析后必须落在 workspace 内（防 file_path 里的 ../ 穿越），且文件存在才删
  const ws = path.resolve(ctx.config.paths.workspace)
  const abs = path.resolve(ws, row.file_path)
  if (abs.startsWith(ws + path.sep) && fs.existsSync(abs)) fs.rmSync(abs)
  ctx.db.prepare('DELETE FROM assets WHERE id = ?').run(assetId)
}
```

- [ ] **Step 4: 跑测试 + tsc**

Run: `corepack pnpm --filter @forgecast/ops test lifecycle`、`npx tsc -p packages/ops/tsconfig.json --noEmit`
Expected: 全绿、tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/ops
git commit -m "feat(ops): deleteAsset 硬删素材（行+文件+询单护栏+路径安全）"
```

---

### Task 2: 后端 DELETE /api/assets/:id

**Files:**
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/delete-asset.test.ts`（新建）

**Interfaces:**
- Consumes: `deleteAsset`（`@forgecast/ops`，Task1）
- Produces: REST `DELETE /api/assets/:id`

- [ ] **Step 1: 写失败测试**

新建 `packages/server/test/delete-asset.test.ts`：

```typescript
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>, root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-del-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  app = createApp(ctx, createTaskQueue())
})
function addVideo(rel = 'demo/videos/x.mp4'): number {
  const abs = path.join(root, 'workspace', rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, 'fake')
  return Number(ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path, status) VALUES (1,'video','pain',?, 'draft')").run(rel).lastInsertRowid)
}

describe('DELETE /api/assets/:id', () => {
  it('存在 → 200 且行没了', async () => {
    const id = addVideo()
    expect((await app.request(`/api/assets/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id)).toBeUndefined()
  })
  it('不存在 → 404', async () => {
    expect((await app.request('/api/assets/99999', { method: 'DELETE' })).status).toBe(404)
  })
  it('有关联询单 → 409', async () => {
    const id = addVideo('demo/videos/y.mp4')
    ctx.db.prepare('INSERT INTO leads (asset_id, wechat) VALUES (?, ?)').run(id, 'wx1')
    expect((await app.request(`/api/assets/${id}`, { method: 'DELETE' })).status).toBe(409)
    expect(ctx.db.prepare('SELECT id FROM assets WHERE id = ?').get(id)).toBeDefined() // 没删
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm --filter @forgecast/server test delete-asset`
Expected: FAIL —— 路由不存在（404/405）。

- [ ] **Step 3: 实现路由**

`packages/server/src/app.ts`：line 7 的 `import { ... } from '@forgecast/ops'` 追加 `deleteAsset`。在 `assetExists` 定义之后（约 line 376 附近）、`app.post('/api/assets/:id/publish'` 之前加：

```typescript
  app.delete('/api/assets/:id', (c) => {
    const id = c.req.param('id')
    if (!assetExists(id)) return c.json({ error: '素材不存在' }, 404)
    try {
      deleteAsset(ctx, Number(id))
      return c.json({ ok: true })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return c.json({ error: m }, m.includes('询单') ? 409 : 500) // 询单护栏→409，其它→500
    }
  })
```

- [ ] **Step 4: 跑测试 + tsc + 全量 server 不回归**

Run: `corepack pnpm --filter @forgecast/server test delete-asset`、`corepack pnpm --filter @forgecast/server test`（全量）、`npx tsc -p packages/server/tsconfig.json --noEmit`
Expected: 全绿、tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add packages/server
git commit -m "feat(server): DELETE /api/assets/:id 删素材（404/409/200）"
```

---

### Task 3: Web 视频卡片删除按钮

**Files:**
- Modify: `apps/web/src/components/AssetCard.tsx`
- 手动浏览器走查（无单测，纯前端消费 API）

**Interfaces:**
- Consumes: REST `DELETE /api/assets/:id`（Task2）
- Produces: 无

- [ ] **Step 1: 加删除 mutation + 视频分支按钮**

`apps/web/src/components/AssetCard.tsx`：
1. 在 `approve` mutation 之后加删除 mutation（`qc` 已在组件内）：

```typescript
  const del = useMutation({
    mutationFn: () => api(`/api/assets/${asset.id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets'] }),
    onError: (e) => {
      const m = e instanceof Error ? e.message : String(e)
      const i = m.indexOf('{'); let text = m
      if (i >= 0) { try { const j = JSON.parse(m.slice(i)); if (j?.error) text = j.error } catch { /* 非 JSON */ } }
      alert('删除失败：' + text)
    },
  })
```

2. 视频分支（`if (asset.type === 'video')`）整段替换为（顶部行加删除按钮）：

```tsx
  if (asset.type === 'video') {
    return (
      <div className="rounded-lg border bg-white p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm text-neutral-500">视频 · {asset.hook} · {asset.status}</div>
          <button className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-600 disabled:opacity-50"
            disabled={del.isPending}
            onClick={() => { if (window.confirm('删除这个视频？文件和记录都会删掉，不可恢复')) del.mutate() }}>删除</button>
        </div>
        <video src={`/files/${asset.file_path}`} controls className="w-full max-h-96 rounded border bg-black" />
      </div>
    )
  }
```

- [ ] **Step 2: 构建校验**

Run: `corepack pnpm --filter web build`
Expected: 构建成功、无 TS 报错。

- [ ] **Step 3: 提交**

```bash
git add apps/web
git commit -m "feat(web): 视频卡片加删除按钮（confirm + DELETE + 刷新列表）"
```

- [ ] **Step 4: 手动浏览器走查（主控）**

主控起 dev（Node22），素材工坊选有视频的项目：点某视频"删除"→confirm→列表里该视频消失、磁盘文件没了；取消 confirm 不删。

---

## 完成标准
- ops.deleteAsset + server DELETE 有测试全绿；tsc 干净。
- web 构建过；视频卡片删除按钮 confirm 后删除并刷新。
- 有询单的素材删不掉（409/护栏）。
- 既有测试不回归。

## 已知非纯代码成本
- Task3 手动浏览器走查（主控）。
