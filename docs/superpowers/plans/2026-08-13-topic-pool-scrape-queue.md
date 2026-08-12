# 选题库抓取请求排队 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给选题库的目标账号加"请求抓取"标记机制——前端按钮把"这个账号想被抓一次"的意图记下来，CLI 能一眼看到完整待处理清单，`import-notes` 成功导入后自动清掉标记。抓取本身依然不自动化，永远靠对话触发。

**Architecture:** `topic_sources` 表加 `scrape_requested_at`/`last_scraped_at` 两列 → `requestScrape` 写入前者 → `importNotes` 成功后清空前者、写入后者 → CLI 新增 `topics list-sources` 读状态 → server 新增一个 POST 路由 → 前端目标账号清单每行加按钮+状态列。

**Tech Stack:** TypeScript, pnpm monorepo, better-sqlite3, Hono, vitest, React + @tanstack/react-query。

## Global Constraints

- Node 22：跑任何 pnpm 命令前 `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`（better-sqlite3 ABI）。
- 这轮**不做任何真实抓取/浏览器自动化代码**——`requestScrape` 只写一个时间戳，不触发任何网络请求或子进程。
- 新列用 `ensureColumn`（`packages/core/src/db.ts` 现有迁移模式）而不是改 `CREATE TABLE`——`topic_sources` 是已经上线的表，线上库需要兼容迁移，不能假设是新库。
- 每个后端任务 TDD：先写失败测试再实现；web 无单测惯例（`tsc --noEmit` + `vite build` 验证）。
- 中文注释/UI 文案；commit message 末尾带 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`。

---

## Task 1: DB 迁移 + `requestScrape` + `importNotes` 自动清标记

**Files:**
- Modify: `packages/core/src/db.ts`
- Modify: `packages/topics/src/sources.ts`
- Modify: `packages/topics/src/notes.ts`
- Modify: `packages/topics/test/sources.test.ts`
- Modify: `packages/topics/test/notes.test.ts`

**Interfaces:**
- Produces：
  - `TopicSource` 接口新增 `scrape_requested_at: string | null` `last_scraped_at: string | null`。
  - `export function requestScrape(ctx: CoreCtx, id: number): void`（不存在抛错，存在则把 `scrape_requested_at` 设为当前时间；可重复调用不抛错）。
  - `importNotes` 行为变化：函数执行到末尾（不论 `notes` 是否为空）时，把该账号 `scrape_requested_at` 清 NULL、`last_scraped_at` 设为当前时间；返回值 `{imported, updated}` 不变。

- [ ] **Step 1: 加迁移列** — `packages/core/src/db.ts`，在现有 `ensureColumn(db, 'candidates', 'favorite', 'INTEGER DEFAULT 0')`（文件末尾，`return db` 之前的最后一条 `ensureColumn` 调用）之后加：

```ts
  // 迁移：选题库抓取请求排队（新库已含，此为兼容旧库）
  ensureColumn(db, 'topic_sources', 'scrape_requested_at', 'TEXT')
  ensureColumn(db, 'topic_sources', 'last_scraped_at', 'TEXT')
```

- [ ] **Step 2: 写失败测试** — `packages/topics/test/sources.test.ts`，顶部 import 行（第 6 行 `import { addSource, deleteSource, listSources, updateSource } from '../src/sources'`）改成：

```ts
import { addSource, deleteSource, listSources, requestScrape, updateSource } from '../src/sources'
```

在 `describe('topic_sources CRUD', ...)` 块内、`deleteSource 删除后 listSources 不再返回`（最后一条现有用例）之后、describe 收尾 `})` 之前追加：

```ts
  it('requestScrape 设置待抓取时间戳，账号不存在抛错，可重复调用不报错', () => {
    const { id } = addSource(ctx, { platform: 'douyin', handle: 'e' })
    expect(listSources(ctx)[0].scrape_requested_at).toBeNull()
    requestScrape(ctx, id)
    expect(listSources(ctx)[0].scrape_requested_at).not.toBeNull()
    expect(() => requestScrape(ctx, 999)).toThrow(/不存在/)
    expect(() => requestScrape(ctx, id)).not.toThrow()
  })
```

- [ ] **Step 3: 写 `importNotes` 失败测试** — `packages/topics/test/notes.test.ts`，顶部 import 行（第 6 行 `import { addSource } from '../src/sources'`）改成：

```ts
import { addSource, listSources, requestScrape } from '../src/sources'
```

在 `describe('importNotes', ...)` 块内、`listNotes 按 source_id 过滤`（最后一条现有用例）之后、describe 收尾 `})` 之前追加：

```ts
  it('导入成功后清空 scrape_requested_at、更新 last_scraped_at', () => {
    const { id } = addSource(ctx, { platform: 'douyin', handle: 'f', followerCount: 100 })
    requestScrape(ctx, id)
    expect(listSources(ctx).find((s) => s.id === id)?.scrape_requested_at).not.toBeNull()
    importNotes(ctx, { sourceHandle: 'f', platform: 'douyin', notes: [{ noteId: 'n6', title: 't', playCount: 1, likeCount: 1 }] })
    const row = listSources(ctx).find((s) => s.id === id)
    expect(row?.scrape_requested_at).toBeNull()
    expect(row?.last_scraped_at).not.toBeNull()
  })
```

- [ ] **Step 4: 跑测试确认失败**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/topics test`
Expected: FAIL（`requestScrape` 未导出 / `scrape_requested_at`/`last_scraped_at` 不存在）

- [ ] **Step 5: 实现 `sources.ts`**

`TopicSource` 接口（现有）：

```ts
export interface TopicSource {
  id: number
  platform: Platform
  handle: string
  display_name: string | null
  follower_count: number | null
  note: string | null
  created_at: string
}
```

改成（补两个字段）：

```ts
export interface TopicSource {
  id: number
  platform: Platform
  handle: string
  display_name: string | null
  follower_count: number | null
  note: string | null
  created_at: string
  scrape_requested_at: string | null
  last_scraped_at: string | null
}
```

文件末尾（`deleteSource` 函数之后）追加：

```ts
/** 标记该账号"想被抓一次"（不触发任何真实抓取，只写时间戳）。不存在抛错；可重复调用（幂等，只是刷新时间）。 */
export function requestScrape(ctx: CoreCtx, id: number): void {
  if (!ctx.db.prepare('SELECT id FROM topic_sources WHERE id = ?').get(id)) throw new Error(`目标账号不存在: ${id}`)
  ctx.db.prepare("UPDATE topic_sources SET scrape_requested_at = datetime('now') WHERE id = ?").run(id)
}
```

- [ ] **Step 6: 实现 `notes.ts`**

`importNotes` 函数体现有末尾：

```ts
    if (exists) updated++; else imported++
  }
  return { imported, updated }
}
```

改成（返回前加一行清标记）：

```ts
    if (exists) updated++; else imported++
  }
  // 导入即视为对之前"请求抓取"标记的响应：清掉待处理、记下这次抓取时间
  ctx.db.prepare("UPDATE topic_sources SET scrape_requested_at = NULL, last_scraped_at = datetime('now') WHERE id = ?").run(source.id)
  return { imported, updated }
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/topics test`
Expected: PASS（全绿，含新增 2 个用例）

- [ ] **Step 8: 跑 core 全量确认迁移不破坏其它表**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/core test`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add packages/core/src/db.ts packages/topics/src/sources.ts packages/topics/src/notes.ts packages/topics/test/sources.test.ts packages/topics/test/notes.test.ts
git commit -m "feat(topics): 抓取请求排队——scrape_requested_at/last_scraped_at + requestScrape"
```

---

## Task 2: CLI `topics list-sources`

**Files:**
- Modify: `cli.ts`

**Interfaces:**
- Consumes：Task 1 的 `TopicSource.scrape_requested_at`/`last_scraped_at`；`@forgecast/topics` 已导出的 `listSources`。

- [ ] **Step 1: 加 import** — `cli.ts` 现有：

```ts
import { addSource, extractPatterns, importNotes, listPatterns } from '@forgecast/topics'
```

改成（补 `listSources`）：

```ts
import { addSource, extractPatterns, importNotes, listPatterns, listSources } from '@forgecast/topics'
```

- [ ] **Step 2: 加子命令分支** — `cli.ts` 的 `case 'topics':` 块内，现有：

```ts
      } else if (sub === 'list-patterns') {
        const hook = arg('hook')
        const patterns = listPatterns(ctx, hook as any)
        console.log(`选题库共 ${patterns.length} 条:`)
        for (const p of patterns) console.log(`  [${p.hook_type}] ${(JSON.parse(p.title_patterns)[0] ?? '')}`)
      } else {
```

改成（在 `list-patterns` 分支之后、`else` 之前插入新分支）：

```ts
      } else if (sub === 'list-patterns') {
        const hook = arg('hook')
        const patterns = listPatterns(ctx, hook as any)
        console.log(`选题库共 ${patterns.length} 条:`)
        for (const p of patterns) console.log(`  [${p.hook_type}] ${(JSON.parse(p.title_patterns)[0] ?? '')}`)
      } else if (sub === 'list-sources') {
        const sources = listSources(ctx)
        console.log(`目标账号共 ${sources.length} 个:`)
        for (const s of sources) {
          const status = s.scrape_requested_at
            ? `待抓取（请求于 ${s.scrape_requested_at}）`
            : s.last_scraped_at
              ? `上次抓取：${s.last_scraped_at}`
              : '从未抓取'
          console.log(`  #${s.id} [${s.platform}] ${s.handle} — ${status}`)
        }
      } else {
```

- [ ] **Step 3: 补帮助文本** — `cli.ts` 的 `default:` 分支（help 输出）里，找到 `forgecast topics list-patterns ...` 那一行，在它之后加：

```
forgecast topics list-sources                                # 列出目标账号清单及抓取状态（待抓取/上次抓取时间）
```

- [ ] **Step 4: 手工冒烟测试**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm exec tsx cli.ts topics add-source --platform=douyin --handle=smoketest2
pnpm exec tsx cli.ts topics list-sources
```

Expected: 第二条命令打印出该账号，状态显示"从未抓取"。**测试完成后手动清理**（这条命令会写进真实的 `db/forgecast.db`）：

```bash
sqlite3 db/forgecast.db "DELETE FROM topic_sources WHERE handle='smoketest2'"
```

- [ ] **Step 5: 提交**

```bash
git add cli.ts
git commit -m "feat(cli): topics list-sources——列出目标账号清单及抓取状态"
```

---

## Task 3: server 路由

**Files:**
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/test/topics.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `requestScrape(ctx, id)`。
- Produces：`POST /api/topics/sources/:id/request-scrape` → `{ ok: true }` 或 404（账号不存在）。

- [ ] **Step 1: 写失败测试** — `packages/server/test/topics.test.ts`，在 `describe('/api/topics/sources', ...)` 块内、`PUT 不存在的账号 → 404`（最后一条现有用例）之后、describe 收尾 `})`（现第 66-67 行）之前追加：

```ts
  it('POST .../:id/request-scrape 设置待抓取标记；不存在账号 → 404', async () => {
    const created = await (await app.request('/api/topics/sources', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'douyin', handle: 'g' }),
    })).json() as any
    const res = await app.request(`/api/topics/sources/${created.id}/request-scrape`, { method: 'POST' })
    expect(res.status).toBe(200)
    const list = await (await app.request('/api/topics/sources')).json() as any[]
    expect(list[0].scrape_requested_at).not.toBeNull()

    const res404 = await app.request('/api/topics/sources/999/request-scrape', { method: 'POST' })
    expect(res404.status).toBe(404)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/server test topics`
Expected: FAIL（路由不存在，返回 404 HTML/JSON "not found"，不是预期的 200/带标记的行为）

- [ ] **Step 3: 实现** — `packages/server/src/app.ts`

`@forgecast/topics` import 行（现有）：

```ts
import { addSource, deleteSource, extractPatterns, listPatterns, listSources, updateSource } from '@forgecast/topics'
```

改成（补 `requestScrape`）：

```ts
import { addSource, deleteSource, extractPatterns, listPatterns, listSources, requestScrape, updateSource } from '@forgecast/topics'
```

在 `app.delete('/api/topics/sources/:id', ...)` 路由（现有）之后、`app.get('/api/topics/patterns', ...)` 之前插入：

```ts
  app.post('/api/topics/sources/:id/request-scrape', (c) => {
    const id = Number(c.req.param('id'))
    try {
      requestScrape(ctx, id)
      return c.json({ ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, msg.includes('不存在') ? 404 : 400)
    }
  })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/server test topics`
Expected: PASS

- [ ] **Step 5: 跑 server 全量确认路由顺序等无回归**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && pnpm --filter @forgecast/server test`
Expected: PASS（全绿）

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/app.ts packages/server/test/topics.test.ts
git commit -m "feat(server): POST /api/topics/sources/:id/request-scrape"
```

---

## Task 4: 前端「请求抓取」按钮 + 状态列

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/pages/TopicsPage.tsx`

**Interfaces:**
- Consumes：Task 3 的 `POST /api/topics/sources/:id/request-scrape`。

> 前端无单测惯例，本 Task 验证 = `tsc --noEmit` + `vite build` 通过 + 浏览器走查。

- [ ] **Step 1: `api.ts` 补字段** — 现有 `TopicSource` 接口：

```ts
export interface TopicSource {
  id: number; platform: 'douyin' | 'xiaohongshu'; handle: string
  display_name: string | null; follower_count: number | null; note: string | null; created_at: string
}
```

改成（补两个字段）：

```ts
export interface TopicSource {
  id: number; platform: 'douyin' | 'xiaohongshu'; handle: string
  display_name: string | null; follower_count: number | null; note: string | null; created_at: string
  scrape_requested_at: string | null; last_scraped_at: string | null
}
```

- [ ] **Step 2: `TopicsPage.tsx` 加请求抓取逻辑** — 在现有 `removeSource` 函数（`async function removeSource(id: number) { ... }`）之后加：

```tsx
  const requestScrapeMut = useMutation({
    mutationFn: (id: number) => api(`/api/topics/sources/${id}/request-scrape`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['topics', 'sources'] }),
    onError: (e) => alert(e instanceof Error ? e.message : String(e)),
  })
  function sourceStatus(s: TopicSource): string {
    if (s.scrape_requested_at) return `待抓取（请求于 ${s.scrape_requested_at}）`
    if (s.last_scraped_at) return `上次抓取：${s.last_scraped_at}`
    return '从未抓取'
  }
```

- [ ] **Step 3: 表格加状态列与按钮** — 现有表格：

```tsx
        <table className="w-full text-sm">
          <thead><tr className="text-left text-faint"><th>平台</th><th>账号</th><th>粉丝数</th><th>备注</th><th /></tr></thead>
          <tbody>
            {sources.data?.map((s) => (
              <tr key={s.id} className="border-t border-hairline">
                <td>{s.platform === 'douyin' ? '抖音' : '小红书'}</td>
                <td>{s.display_name ? `${s.display_name}（${s.handle}）` : s.handle}</td>
                <td>{s.follower_count ?? '—'}</td>
                <td className="text-faint">{s.note ?? ''}</td>
                <td><button className="text-xs text-red-600" onClick={() => removeSource(s.id)}>删除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
```

改成（加"状态"列头、状态单元格、「请求抓取」按钮）：

```tsx
        <table className="w-full text-sm">
          <thead><tr className="text-left text-faint"><th>平台</th><th>账号</th><th>粉丝数</th><th>备注</th><th>抓取状态</th><th /></tr></thead>
          <tbody>
            {sources.data?.map((s) => (
              <tr key={s.id} className="border-t border-hairline">
                <td>{s.platform === 'douyin' ? '抖音' : '小红书'}</td>
                <td>{s.display_name ? `${s.display_name}（${s.handle}）` : s.handle}</td>
                <td>{s.follower_count ?? '—'}</td>
                <td className="text-faint">{s.note ?? ''}</td>
                <td className="text-faint">{sourceStatus(s)}</td>
                <td className="space-x-2">
                  <button className="text-xs text-ink underline disabled:opacity-50" disabled={requestScrapeMut.isPending}
                    onClick={() => requestScrapeMut.mutate(s.id)}>请求抓取</button>
                  <button className="text-xs text-red-600" onClick={() => removeSource(s.id)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
```

- [ ] **Step 4: 构建确认**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm --filter web exec tsc --noEmit
pnpm --filter web build
```
Expected: 均通过，无 TS 报错。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/api.ts apps/web/src/pages/TopicsPage.tsx
git commit -m "feat(web): 选题库目标账号加「请求抓取」按钮 + 抓取状态列"
```

---

## Task 5: 全仓验证 + 浏览器走查

**Files:** 无新增/修改文件，仅验证。

- [ ] **Step 1: 全仓测试 + 类型检查 + 构建**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
pnpm test
pnpm --filter web exec tsc --noEmit
pnpm --filter web build
```
Expected: 全部通过。

- [ ] **Step 2: 重启 dev server**

```bash
pkill -9 -f "cli.ts dev" 2>&1
lsof -ti tcp:4321 2>/dev/null | xargs -r kill -9
lsof -ti tcp:5173 2>/dev/null | xargs -r kill -9
sleep 1
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
(nohup pnpm dev > /tmp/forgecast-dev.log 2>&1 & echo $! > /tmp/forgecast-dev.pid)
sleep 5
tail -15 /tmp/forgecast-dev.log
```
Expected: 看到 `已启动 http://127.0.0.1:4321` 和 `VITE ... ready`。

- [ ] **Step 3: 浏览器端到端走查**

打开 `/topics`：
1. 添加一个测试账号，确认"抓取状态"列显示"从未抓取"。
2. 点「请求抓取」，确认状态变成"待抓取（请求于 ...）"。
3. 用 CLI `pnpm exec tsx cli.ts topics list-sources` 确认能看到同一个待处理状态。
4. 用 CLI `topics import-notes` 给这个测试账号导入一条笔记数据，刷新页面确认状态变回"上次抓取：..."。
5. **清理测试数据**：删掉刚才建的测试账号（页面点删除，或 `sqlite3 db/forgecast.db "DELETE FROM topic_sources WHERE handle='<测试用的handle>'"`），并清理对应的 `viral_notes` 记录。

- [ ] **Step 4: 提交**（若走查中发现问题并修复，才需要这步；纯验证无代码改动则跳过）

如果走查全部通过、无需修复，本 Task 无需提交——直接标记完成。
