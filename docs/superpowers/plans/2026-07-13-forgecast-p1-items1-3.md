# ForgeCast P1（第 1-3 项）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 forgecast monorepo 第一个可运行垂直切片：core+server 骨架、M4 copywriter、Web 素材工坊+项目详情，mock LLM 模式下无 key 跑通「生成→行内编辑→审核」全流程。

**Architecture:** 引擎与界面严格分离——所有能力为 `packages/*` 中的 core 函数，Hono server（:4321）与 CLI 是同一套函数的两个入口，Web（:5173）只经 API 调用。LLM client 双模式（mock/live），mock 与 live 共用同一产物解析器。

**Tech Stack:** Node 20 + TypeScript + pnpm 9 monorepo；better-sqlite3（WAL）；Hono + @hono/node-server；Vite + React + Tailwind v4 + TanStack Query + react-markdown；Playwright（封面截图）；vitest；tsx（TS 直跑，无构建步骤）。

## Global Constraints

- Node 20，pnpm 9（`corepack use pnpm@9`；不用 pnpm 10，避免 postinstall 审批干扰 better-sqlite3）
- monorepo 根 = 本仓库根（`/Users/lizhishaoniange/Documents/开源变现内容工厂`）
- 无任何 API key：`FORGECAST_LLM_MODE` 默认 `mock`；live 模式走 `https://aitoken.homes/v1`（OpenAI 兼容）
- 服务只绑 `127.0.0.1`，无登录无多租户
- 所有产物是文件，落 `workspace/<slug>/` 下；assets 表 `file_path` 一律存**相对 workspace 目录**的路径
- 文档与代码注释用中文
- Docker 构建必须 `DOCKER_BUILDKIT=0`（本机路径含中文，buildx 会挂）
- 包名：`@forgecast/core`、`@forgecast/copywriter`、`@forgecast/server`；各包 `main` 直指 `src/index.ts`（tsx/vitest/vite 均按 bundler 解析，无需 build）
- TDD：每个功能先写失败测试；提交频繁、信息用 conventional commits，结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## 产物 markdown 契约（多任务共享，务必一致）

LLM（mock 与 live）输出、`_format.md` 模板、parser、fixtures 全部遵守：

```markdown
## 标题
1. <标题一>
2. <标题二>
3. <标题三>

## 小红书正文
<300-500字正文>

## 抖音口播脚本
<45-60秒脚本>

## 封面文案
主标题：<xx>
副标题：<xx>

## 评论区运营
### 预埋提问
1. <xx>
2. <xx>
### 回复话术
1. <xx>
2. <xx>
3. <xx>
```

---

### Task 1: Monorepo 脚手架

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`
- Create: `packages/core/package.json`, `packages/copywriter/package.json`, `packages/server/package.json`, `apps/web/package.json`（占位，Task 13 补全）

**Interfaces:**
- Produces: 可 `pnpm install` 的 workspace；`pnpm -r test` 可运行

- [ ] **Step 1: 写 workspace 与根配置**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`package.json`:
```json
{
  "name": "forgecast",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "dev": "tsx cli.ts dev",
    "test": "pnpm -r test"
  },
  "dependencies": {
    "@forgecast/copywriter": "workspace:*",
    "@forgecast/core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["node"]
  }
}
```

`.gitignore`:
```
node_modules/
dist/
db/
.env
*.log
```

`.env.example`:
```bash
# LLM 模式：mock（默认，无 key 可跑）| live（走中转站，必须填 key）
FORGECAST_LLM_MODE=mock
FORGECAST_LLM_BASE_URL=https://aitoken.homes/v1
FORGECAST_LLM_KEY=
# 模型名（中转站里的实际模型 id）
FORGECAST_MODEL_ANALYSIS=
FORGECAST_MODEL_COPY=
FORGECAST_MODEL_SCORING=
```

- [ ] **Step 2: 写四个子包占位 package.json**

`packages/core/package.json`:
```json
{
  "name": "@forgecast/core",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run" },
  "dependencies": { "better-sqlite3": "^11.7.0" },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.11.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/copywriter/package.json`:
```json
{
  "name": "@forgecast/copywriter",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run" },
  "dependencies": {
    "@forgecast/core": "workspace:*",
    "playwright": "^1.49.0"
  },
  "devDependencies": { "@types/node": "^20.11.0", "vitest": "^2.1.0" }
}
```

`packages/server/package.json`:
```json
{
  "name": "@forgecast/server",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "dev": "tsx src/index.ts", "test": "vitest run" },
  "dependencies": {
    "@forgecast/copywriter": "workspace:*",
    "@forgecast/core": "workspace:*",
    "@hono/node-server": "^1.13.0",
    "hono": "^4.6.0"
  },
  "devDependencies": { "@types/node": "^20.11.0", "tsx": "^4.19.0", "vitest": "^2.1.0" }
}
```

`apps/web/package.json`（占位）:
```json
{
  "name": "web",
  "private": true,
  "type": "module",
  "scripts": { "test": "echo 'web: 人工验收，无单测'" }
}
```

各包放同款 `tsconfig.json`（core/copywriter/server 三处）:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

- [ ] **Step 3: 安装并验证**

```bash
corepack enable && corepack use pnpm@9.15.0
pnpm install
pnpm -r test
```
Expected: install 成功（better-sqlite3 编译通过）；`pnpm -r test` 中 web 打印占位信息，其余包 vitest 报 "No test files found" 属正常（下个任务起有测试）。若 vitest 因无测试文件报错退出非 0，在三个包的 test script 加 `--passWithNoTests`。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: pnpm monorepo 脚手架（core/copywriter/server/web 四包骨架）"
```

---

### Task 2: core — 配置加载

**Files:**
- Create: `packages/core/src/config.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/config.test.ts`

**Interfaces:**
- Produces:
  - `type LlmMode = 'mock' | 'live'`
  - `interface ForgecastConfig { root: string; llm: { mode: LlmMode; baseURL: string; apiKey: string; models: { analysis: string; copy: string; scoring: string } }; paths: { workspace: string; db: string; templates: string } }`
  - `function loadConfig(root?: string, env?: NodeJS.ProcessEnv): ForgecastConfig`

- [ ] **Step 1: 写失败测试**

`packages/core/test/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

describe('loadConfig', () => {
  it('默认 mock 模式，无 key 不报错', () => {
    const cfg = loadConfig('/tmp/x', {})
    expect(cfg.llm.mode).toBe('mock')
    expect(cfg.paths.workspace).toBe('/tmp/x/workspace')
    expect(cfg.paths.db).toBe('/tmp/x/db/forgecast.db')
    expect(cfg.paths.templates).toBe('/tmp/x/templates')
  })
  it('live 模式无 key 抛错', () => {
    expect(() => loadConfig('/tmp/x', { FORGECAST_LLM_MODE: 'live' })).toThrow(/FORGECAST_LLM_KEY/)
  })
  it('live 模式读取 key 与模型名', () => {
    const cfg = loadConfig('/tmp/x', {
      FORGECAST_LLM_MODE: 'live', FORGECAST_LLM_KEY: 'sk-1', FORGECAST_MODEL_COPY: 'm-copy',
    })
    expect(cfg.llm.mode).toBe('live')
    expect(cfg.llm.apiKey).toBe('sk-1')
    expect(cfg.llm.models.copy).toBe('m-copy')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/core test`
Expected: FAIL（config.ts 不存在）

- [ ] **Step 3: 实现**

`packages/core/src/config.ts`:
```ts
import path from 'node:path'

export type LlmMode = 'mock' | 'live'

export interface ForgecastConfig {
  root: string
  llm: {
    mode: LlmMode
    baseURL: string
    apiKey: string
    models: { analysis: string; copy: string; scoring: string }
  }
  paths: { workspace: string; db: string; templates: string }
}

export function loadConfig(root: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): ForgecastConfig {
  const mode: LlmMode = env.FORGECAST_LLM_MODE === 'live' ? 'live' : 'mock'
  if (mode === 'live' && !env.FORGECAST_LLM_KEY) {
    throw new Error('FORGECAST_LLM_MODE=live 时必须设置 FORGECAST_LLM_KEY（.env）')
  }
  return {
    root,
    llm: {
      mode,
      baseURL: env.FORGECAST_LLM_BASE_URL ?? 'https://aitoken.homes/v1',
      apiKey: env.FORGECAST_LLM_KEY ?? '',
      models: {
        analysis: env.FORGECAST_MODEL_ANALYSIS ?? 'claude-sonnet-5',
        copy: env.FORGECAST_MODEL_COPY ?? 'claude-sonnet-5',
        scoring: env.FORGECAST_MODEL_SCORING ?? 'claude-haiku-4-5',
      },
    },
    paths: {
      workspace: path.join(root, 'workspace'),
      db: path.join(root, 'db', 'forgecast.db'),
      templates: path.join(root, 'templates'),
    },
  }
}
```

`packages/core/src/index.ts`:
```ts
export * from './config'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/core test`
Expected: PASS ×3

- [ ] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat(core): 配置加载（mock/live 双模式，live 无 key 抛错）"
```

---

### Task 3: core — SQLite 建库与迁移

**Files:**
- Create: `packages/core/src/db.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/db.test.ts`

**Interfaces:**
- Produces:
  - `function openDb(dbPath: string): Database.Database`（WAL 开启、建全部表，幂等）
  - 表：`candidates` / `projects` / `assets`（含 P1 扩展列 `warnings TEXT`）/ `knowledge_atoms` / `atoms_fts`

- [ ] **Step 1: 写失败测试**

`packages/core/test/db.test.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db'

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-')), 'test.db')
}

describe('openDb', () => {
  it('建表齐全且 WAL 开启', () => {
    const db = openDb(tmpDbPath())
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all()
      .map((r: any) => r.name)
    for (const t of ['candidates', 'projects', 'assets', 'knowledge_atoms']) expect(names).toContain(t)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  })
  it('幂等：重复打开不报错', () => {
    const p = tmpDbPath()
    openDb(p).close()
    expect(() => openDb(p)).not.toThrow()
  })
  it('assets 可插入并带 warnings 列', () => {
    const db = openDb(tmpDbPath())
    db.prepare("INSERT INTO projects (slug) VALUES ('t1')").run()
    db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (1, 'copy', 'pain', 't1/copy/a.md', '[]')",
    ).run()
    const row: any = db.prepare('SELECT * FROM assets WHERE id = 1').get()
    expect(row.status).toBe('draft')
    expect(row.warnings).toBe('[]')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/core test`
Expected: FAIL（db.ts 不存在）

- [ ] **Step 3: 实现**

`packages/core/src/db.ts`:
```ts
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/** 打开（必要时创建）数据库：WAL + 全量建表，幂等可重跑 */
export function openDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY,
  repo TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  license TEXT,
  license_ok INTEGER,
  stars INTEGER, last_commit TEXT,
  tech_stack TEXT,
  score REAL,
  score_detail TEXT,
  status TEXT DEFAULT 'candidate',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  candidate_id INTEGER REFERENCES candidates(id),
  brand_name TEXT,
  target_buyer TEXT,
  demo_url TEXT,
  price_deploy INTEGER,
  price_custom INTEGER,
  stage TEXT DEFAULT 'analysis'
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  type TEXT NOT NULL,
  hook TEXT,
  file_path TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  published_at TEXT, platform TEXT,
  perf TEXT,
  warnings TEXT
);
CREATE TABLE IF NOT EXISTS knowledge_atoms (
  id INTEGER PRIMARY KEY,
  source TEXT DEFAULT 'dbskill',
  topic TEXT, content TEXT NOT NULL,
  meta TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts USING fts5(content, topic, content='knowledge_atoms', content_rowid='id');
`)
  return db
}
```

`packages/core/src/index.ts` 追加：
```ts
export * from './db'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/core test`
Expected: PASS（config 3 + db 3）

- [ ] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat(core): SQLite 建库迁移（主文档 §2 五表 + assets.warnings 扩展，WAL）"
```

---

### Task 4: core — LLM client（mock fixtures + live）

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/fixtures/copy-fixtures.ts`, `packages/core/src/llm.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/llm.test.ts`

**Interfaces:**
- Produces:
  - `const HOOKS = ['sideline','infogap','story','pain'] as const; type HookType = typeof HOOKS[number]`
  - `interface CompleteOptions { model: string; system?: string; prompt: string }`
  - `interface LlmClient { complete(opts: CompleteOptions): Promise<string> }`
  - `function createLlmClient(cfg: ForgecastConfig['llm'], fetchImpl?: typeof fetch): LlmClient`
  - `const copyFixtures: Record<HookType, string>`（每条完整符合「产物 markdown 契约」）
- Consumes: Task 2 `ForgecastConfig`

- [ ] **Step 1: 写失败测试**

`packages/core/test/llm.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { copyFixtures } from '../src/fixtures/copy-fixtures'
import { createLlmClient } from '../src/llm'
import { HOOKS } from '../src/types'

const liveCfg = { mode: 'live' as const, baseURL: 'https://x.test/v1', apiKey: 'k', models: { analysis: 'a', copy: 'c', scoring: 's' } }
const mockCfg = { ...liveCfg, mode: 'mock' as const }

describe('mock 模式', () => {
  it('按提示词中的钩子标记返回对应 fixture', async () => {
    const llm = createLlmClient(mockCfg)
    const out = await llm.complete({ model: 'c', prompt: '【钩子类型】pain\n……' })
    expect(out).toBe(copyFixtures.pain)
  })
  it('四个 fixture 都含契约的五个段落', () => {
    for (const hook of HOOKS) {
      const f = copyFixtures[hook]
      for (const sec of ['## 标题', '## 小红书正文', '## 抖音口播脚本', '## 封面文案', '## 评论区运营']) {
        expect(f, `${hook} 缺 ${sec}`).toContain(sec)
      }
    }
  })
})

describe('live 模式', () => {
  it('OpenAI 兼容调用并取回文本', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '生成结果' } }],
    })))
    const llm = createLlmClient(liveCfg, fetchImpl as any)
    const out = await llm.complete({ model: 'c', system: 'sys', prompt: 'hi' })
    expect(out).toBe('生成结果')
    const [url, init] = fetchImpl.mock.calls[0] as any
    expect(url).toBe('https://x.test/v1/chat/completions')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('c')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
  })
  it('失败重试 2 次后抛错', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    const llm = createLlmClient(liveCfg, fetchImpl as any)
    await expect(llm.complete({ model: 'c', prompt: 'hi' })).rejects.toThrow(/500/)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  }, 15000)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/core test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 types 与 fixtures**

`packages/core/src/types.ts`:
```ts
export const HOOKS = ['sideline', 'infogap', 'story', 'pain'] as const
export type HookType = (typeof HOOKS)[number]

export const HOOK_LABELS: Record<HookType, string> = {
  sideline: '副业型', infogap: '信息差型', story: '接单故事型', pain: '行业痛点型',
}
```

`packages/core/src/fixtures/copy-fixtures.ts` — 四条 fixture 全部围绕 demo 项目「快客通」（Chatwoot 换皮的在线客服系统，目标买家：淘宝/抖店中小卖家），内容手写、结构严格符合契约。**注意：fixture 中不得出现违禁词**（第一/最好/保证/稳赚等，见 Task 5 清单）。

```ts
import type { HookType } from '../types'

export const copyFixtures: Record<HookType, string> = {
  pain: `## 标题
1. 做电商的还在用微信回客户？效率差了不止一截
2. 店铺咨询到半夜？这个客服系统帮你自动接住
3. 3个客服的活，一套系统就能扛下来

## 小红书正文
开网店的姐妹肯定懂😩
白天上班，晚上回客户消息回到凌晨
微信、旺旺、抖店后台来回切，漏一条就是差评

我给自己店里装了套客服系统「快客通」👇
✅ 全渠道消息进一个后台，不用来回切App
✅ 常见问题自动回复，睡觉也能接单
✅ 客户资料自动归档，回头客一眼认出

装完之后每天少花2小时在回消息上
省下的时间上新、拍图不香吗🍋

同款系统部署文档我整理好了
需要的评论区扣1，我看到都会回

## 抖音口播脚本
【0-3s 钩子】（大字弹出）开网店的，谁还没为回消息熬过夜？
【3-8s 痛点】微信一堆未读、旺旺提示音响个不停、抖店后台还挂着三个咨询——漏回一条，差评就来了。
【8-45s 演示】看我这套后台：所有渠道的消息进一个列表（指屏幕），点开直接回；这里设置自动回复，发货时间、退换规则，机器人先答；客户买过什么、聊过什么，侧边栏全有。
【45-52s 报价锚点】外面开发一套要几万，我这套部署下来成本一顿火锅钱。
【52-60s CTA】想要同款的，评论区扣1，部署文档发你。

## 封面文案
主标题：网店客服还在手动回？
副标题：一套系统扛住3个人的活

## 评论区运营
### 预埋提问
1. 这个支持抖店吗？
2. 不懂技术能装吗？
### 回复话术
1. 支持的，主流平台渠道都能接，具体看置顶。
2. 可以帮装，部署文档也很详细，评论区扣1发你。
3. 数据都在你自己服务器上，不经过第三方，放心。
`,
  sideline: `## 标题
1. 我花3天装了个客服系统，现在每月多一份收入
2. 下班后搞的小副业：帮网店装客服系统
3. 用开源项目接单，这条路比想象中顺

## 小红书正文
分享一个程序员搞钱思路💡
上个月花3天，基于开源项目搭了套在线客服系统
起名「快客通」，做了个演示站

然后在闲鱼和小红书挂了「帮网店装客服系统」
✅ 装一套收一次钱，边际成本几乎为0
✅ 客户都是中小卖家，需求特别实在
✅ 装完还有定制需求，又是一单

这个月已经交付了几单，晚上和周末就能做
不用囤货不用发货，纯技术服务🛠️

想知道怎么找项目、怎么定价的
评论区扣1，我写一篇详细的

## 抖音口播脚本
【0-3s 钩子】程序员下班后能做什么副业？我用3天给出了答案。
【3-8s 痛点】接外包太卷，做自媒体太慢，很多人卡在不知道卖什么。
【8-45s 演示】我的做法：找一个能商用的开源项目，改名换皮变成自己的产品——看，这是我搭的客服系统后台，功能齐全界面也不丑；然后挂到闲鱼小红书，帮网店老板部署，装一套收一次钱。
【45-52s 报价锚点】老板们对比过外面的报价，几万起步；我按部署收费，他们省钱我赚钱。
【52-60s CTA】具体怎么选项目怎么定价，评论区扣1，整理好发你。

## 封面文案
主标题：3天搭的系统 月月有收入
副标题：程序员副业新思路

## 评论区运营
### 预埋提问
1. 不是程序员能做吗？
2. 项目去哪找？
### 回复话术
1. 有基础更快，零基础跟着文档也能走通，就是慢一点。
2. 我整理了一份可商用的项目清单，扣1发你。
3. 协议要看清楚，GPL的不能这么用，清单里都标了。
`,
  infogap: `## 标题
1. 老板花2万买的客服系统，成本其实不到500
2. 别再花冤枉钱买SaaS了，这套系统自己就能部署
3. 年费上万的客服软件，平替方案了解一下

## 小红书正文
说个电商圈的信息差💰
很多店主每年花上万块订阅客服SaaS
其实同类的开源系统早就很成熟了

我部署的这套「快客通」👇
✅ 功能对标市面主流客服软件
✅ 数据放自己服务器，不怕平台跑路
✅ 一次部署长期用，没有年费

算笔账：SaaS年费上万，自部署成本一顿饭钱
差价就是信息差📊

已经帮好几个店主省下这笔钱了
部署文档整理好了，评论区扣1

## 抖音口播脚本
【0-3s 钩子】你知道老板花2万买的客服系统，成本其实多少吗？
【3-8s 痛点】市面上客服SaaS按坐席按年收费，店越大交得越多，数据还在别人手里。
【8-45s 演示】看这套系统：多渠道接入、自动回复、客户管理（逐个点开演示），功能一样不少；区别是它部署在你自己服务器上，一次装好长期用。
【45-52s 报价锚点】SaaS一年上万，这套的服务器成本一个月几十块。
【52-60s CTA】想省这笔钱的，评论区扣1，把部署方案发你。

## 封面文案
主标题：2万的系统 500块搞定
副标题：电商客服软件平替方案

## 评论区运营
### 预埋提问
1. 和XX客服比差在哪？
2. 后期维护麻烦吗？
### 回复话术
1. 核心功能都有，差的是云端托管，但数据自主可控。
2. 装好基本不用动，有问题我这边也提供支持。
3. 服务器一个月几十块的就够用，教程里有推荐配置。
`,
  story: `## 标题
1. 客户问能不能做个客服系统，我说等我一天
2. 接了个单：给水果店老板装客服系统
3. 从咨询到交付48小时，这单接得值

## 小红书正文
记录一单📝
上周有个做水果批发的老板找我
问：网站上能不能加个在线聊天，客户咨询老是漏

我：可以，等我一天🕐
用「快客通」给他部署了一套
✅ 网页右下角挂了聊天窗口
✅ 微信里也能收到客户消息提醒
✅ 顺手把常见问题配了自动回复

第二天交付，老板当场结款
后面又介绍了两个同行过来😎

这种单子不复杂，但特别实在
想接同类需求的，评论区扣1聊

## 抖音口播脚本
【0-3s 钩子】客户：能做个在线客服吗？我：等我一天。
【3-8s 痛点】老板的原话是——客户咨询老是漏，漏一单少赚几百。
【8-45s 演示】我的交付过程：部署系统（快进录屏）、网站挂上聊天组件、配好自动回复和消息提醒，测试没问题——前后不到48小时（聊天记录截图逐条弹出）。
【45-52s 报价锚点】老板之前问过外包公司，报价小一万；我按部署收费，他觉得捡到了。
【52-60s CTA】手里有同类需求或者想学怎么接这种单，评论区扣1。

## 封面文案
主标题：48小时交付一单
副标题：客服系统部署实录

## 评论区运营
### 预埋提问
1. 这种单子去哪接？
2. 交付后出问题怎么办？
### 回复话术
1. 我主要靠内容引流，客户看到视频来私信的。
2. 我提供一段时间的售后支持，之后有偿维护。
3. 部署过程有录屏，验收标准提前和客户对好。
`,
}
```

- [ ] **Step 4: 实现 llm.ts**

`packages/core/src/llm.ts`:
```ts
import type { ForgecastConfig } from './config'
import { copyFixtures } from './fixtures/copy-fixtures'
import { HOOKS, type HookType } from './types'

export interface CompleteOptions { model: string; system?: string; prompt: string }
export interface LlmClient { complete(opts: CompleteOptions): Promise<string> }

/** mock：从提示词首行【钩子类型】xxx 取 fixture；live：OpenAI 兼容调用，失败重试2次 */
export function createLlmClient(cfg: ForgecastConfig['llm'], fetchImpl: typeof fetch = fetch): LlmClient {
  if (cfg.mode === 'mock') {
    return {
      async complete(opts) {
        const m = opts.prompt.match(/【钩子类型】(\w+)/)
        const hook = (m?.[1] ?? 'pain') as HookType
        return copyFixtures[HOOKS.includes(hook) ? hook : 'pain']
      },
    }
  }
  return {
    async complete(opts) {
      let lastErr: unknown
      for (let attempt = 0; attempt <= 2; attempt++) {
        try {
          const res = await fetchImpl(`${cfg.baseURL}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({
              model: opts.model,
              messages: [
                ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
                { role: 'user', content: opts.prompt },
              ],
            }),
          })
          if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`)
          const data: any = await res.json()
          const text = data.choices?.[0]?.message?.content
          if (typeof text !== 'string' || !text) throw new Error('LLM 返回内容为空')
          return text
        } catch (err) {
          lastErr = err
          if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
        }
      }
      throw lastErr
    },
  }
}
```

`packages/core/src/index.ts` 追加：
```ts
export * from './types'
export * from './llm'
export * from './fixtures/copy-fixtures'
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @forgecast/core test`
Expected: PASS（全部）

- [ ] **Step 6: Commit**

```bash
git add packages/core && git commit -m "feat(core): LLM client mock/live 双模式 + 四钩子 fixture 文案"
```

---

### Task 5: copywriter — 产物解析器 + 敏感词校验

**Files:**
- Create: `packages/copywriter/src/parser.ts`, `packages/copywriter/src/banned-words.ts`, `packages/copywriter/src/index.ts`
- Test: `packages/copywriter/test/parser.test.ts`, `packages/copywriter/test/banned-words.test.ts`

**Interfaces:**
- Produces:
  - `interface CopyDoc { titles: string[]; xhsBody: string; douyinScript: string; cover: { main: string; sub: string }; comments: { questions: string[]; replies: string[] } }`
  - `function parseCopyOutput(md: string): CopyDoc`（缺段落抛 Error，消息列出缺失段）
  - `const BANNED_WORDS: string[]`；`function checkBannedWords(text: string): string[]`
- Consumes: Task 4 `copyFixtures`（作解析测试样本——**mock 与 live 共用此解析器**是设计核心）

- [ ] **Step 1: 写失败测试**

`packages/copywriter/test/parser.test.ts`:
```ts
import { copyFixtures, HOOKS } from '@forgecast/core'
import { describe, expect, it } from 'vitest'
import { parseCopyOutput } from '../src/parser'

describe('parseCopyOutput', () => {
  it('四个 fixture 全部可解析且字段完整', () => {
    for (const hook of HOOKS) {
      const doc = parseCopyOutput(copyFixtures[hook])
      expect(doc.titles, hook).toHaveLength(3)
      expect(doc.xhsBody.length, hook).toBeGreaterThan(50)
      expect(doc.douyinScript, hook).toContain('CTA')
      expect(doc.cover.main, hook).toBeTruthy()
      expect(doc.cover.sub, hook).toBeTruthy()
      expect(doc.comments.questions, hook).toHaveLength(2)
      expect(doc.comments.replies, hook).toHaveLength(3)
    }
  })
  it('缺段落时抛错并指明缺哪段', () => {
    expect(() => parseCopyOutput('## 标题\n1. a\n2. b\n3. c')).toThrow(/小红书正文/)
  })
})
```

`packages/copywriter/test/banned-words.test.ts`:
```ts
import { copyFixtures, HOOKS } from '@forgecast/core'
import { describe, expect, it } from 'vitest'
import { checkBannedWords } from '../src/banned-words'

describe('checkBannedWords', () => {
  it('命中违禁词返回词表', () => {
    expect(checkBannedWords('全网第一，保证赚钱，稳赚不亏')).toEqual(
      expect.arrayContaining(['第一', '保证赚钱', '稳赚']),
    )
  })
  it('干净文本返回空数组', () => {
    expect(checkBannedWords('一套系统扛住3个人的活')).toEqual([])
  })
  it('四个 fixture 不含违禁词（守住 mock 演示质量）', () => {
    for (const hook of HOOKS) expect(checkBannedWords(copyFixtures[hook]), hook).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/copywriter test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`packages/copywriter/src/parser.ts`:
```ts
export interface CopyDoc {
  titles: string[]
  xhsBody: string
  douyinScript: string
  cover: { main: string; sub: string }
  comments: { questions: string[]; replies: string[] }
}

const REQUIRED = ['标题', '小红书正文', '抖音口播脚本', '封面文案', '评论区运营'] as const

function numberedItems(block: string): string[] {
  return block.split('\n')
    .map((l) => l.match(/^\d+[.、]\s*(.+)$/)?.[1]?.trim())
    .filter((s): s is string => !!s)
}

/** 解析 LLM 产物 markdown（mock 与 live 共用）。缺段落抛错，绝不静默出半成品。 */
export function parseCopyOutput(md: string): CopyDoc {
  const sections = new Map<string, string>()
  const parts = md.split(/^## /m).slice(1)
  for (const p of parts) {
    const nl = p.indexOf('\n')
    sections.set(p.slice(0, nl).trim(), p.slice(nl + 1).trim())
  }
  const missing = REQUIRED.filter((k) => !sections.has(k))
  if (missing.length) throw new Error(`产物缺少段落: ${missing.join('、')}`)

  const cover = sections.get('封面文案')!
  const main = cover.match(/主标题[:：]\s*(.+)/)?.[1]?.trim() ?? ''
  const sub = cover.match(/副标题[:：]\s*(.+)/)?.[1]?.trim() ?? ''
  if (!main || !sub) throw new Error('封面文案缺少主标题/副标题')

  const comments = sections.get('评论区运营')!
  const qBlock = comments.split(/### 回复话术/)[0] ?? ''
  const rBlock = comments.split(/### 回复话术/)[1] ?? ''

  return {
    titles: numberedItems(sections.get('标题')!),
    xhsBody: sections.get('小红书正文')!,
    douyinScript: sections.get('抖音口播脚本')!,
    cover: { main, sub },
    comments: { questions: numberedItems(qBlock), replies: numberedItems(rBlock) },
  }
}
```

`packages/copywriter/src/banned-words.ts`:
```ts
/** 广告法 + 平台敏感词（初版清单，随实测迭代）。纯本地字符串匹配。 */
export const BANNED_WORDS = [
  '第一', '最好', '最强', '最佳', '最低价', '全网最',
  '顶级', '国家级', '世界级', '独家', '首选',
  '保证赚钱', '稳赚', '包赚', '躺着不动就赚', '零风险',
  '百分百', '100%有效', '无效退款',
]

export function checkBannedWords(text: string): string[] {
  return BANNED_WORDS.filter((w) => text.includes(w))
}
```

`packages/copywriter/src/index.ts`:
```ts
export * from './parser'
export * from './banned-words'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/copywriter test`
Expected: PASS（若某 fixture 命中违禁词或解析失败——**改 fixture**，不改测试）

- [ ] **Step 5: Commit**

```bash
git add packages/copywriter && git commit -m "feat(copywriter): 产物 markdown 解析器 + 广告法敏感词校验"
```

---

### Task 6: 模板资产 + 提示词组装 + 知识检索

**Files:**
- Create: `templates/prompts/copy-pain.md`, `copy-sideline.md`, `copy-infogap.md`, `copy-story.md`, `templates/prompts/_format.md`, `templates/prompts/funnel.md`
- Create: `templates/knowledge/hooks-basics.md`（示例知识包，P1 占位；真 sync 属后续 item）
- Create: `packages/copywriter/src/assemble.ts`, `packages/copywriter/src/knowledge.ts`
- Modify: `packages/copywriter/src/index.ts`
- Test: `packages/copywriter/test/assemble.test.ts`, `packages/copywriter/test/knowledge.test.ts`

**Interfaces:**
- Produces:
  - `interface Atom { id: number; topic: string | null; content: string }`
  - `function searchAtoms(db: Database.Database, terms: string[], limit?: number): Atom[]`（默认 limit=8）
  - `const HOOK_KEYWORDS: Record<HookType, string[]>`
  - `interface AssembleInput { hook: HookType; hookTemplate: string; formatSpec: string; knowledgeMd: string; atoms: Atom[]; analysis: string; feedback?: string }`
  - `function assemblePrompt(i: AssembleInput): { system: string; prompt: string }`（prompt 首行必须是 `【钩子类型】<hook>`，mock 检测依赖它）
- Consumes: Task 3 `openDb`（knowledge_atoms 表）、Task 4 `HookType`

**说明（对设计文档的一处收敛）**：中文原子在 FTS5 默认分词器下召回极差，P1 的 `searchAtoms` 用 LIKE 扫描（原子量小，性能无虞），`atoms_fts` 表保留、接口不变，后续 item 做真 sync 时内部升级即可。检索词 = 钩子关键词（`HOOK_KEYWORDS`）+ 项目 `target_buyer`。

- [ ] **Step 1: 写模板文件**

`templates/prompts/_format.md`（输出格式规范，与「产物 markdown 契约」一字不差）:
```markdown
【输出格式】严格按以下 markdown 结构输出，段落标题一字不差，不要输出任何额外内容：

## 标题
1. <标题一，≤20字，含数字或对比>
2. <标题二，≤20字>
3. <标题三，≤20字>

## 小红书正文
<300-500字，口语化，分段带 emoji，结尾必须带私域钩子（如「需要的评论区扣1」）>

## 抖音口播脚本
【0-3s 钩子】<前3秒钩子画面描述与台词>
【3-8s 痛点】<现状吐槽>
【8-45s 演示】<演示节奏与台词>
【45-52s 报价锚点】<对比锚点>
【52-60s CTA】<行动号召>

## 封面文案
主标题：<大字报主标题，≤12字>
副标题：<副标题，≤15字>

## 评论区运营
### 预埋提问
1. <问题一>
2. <问题二>
### 回复话术
1. <回复一>
2. <回复二>
3. <回复三>

【违禁词红线】不得出现：第一、最好、最强、最佳、最低价、全网最、顶级、国家级、世界级、独家、首选、保证赚钱、稳赚、包赚、零风险、百分百、100%有效、无效退款。不出现微信号、二维码、具体价格数字承诺。
```

`templates/prompts/copy-pain.md`:
```markdown
你要写一组「行业痛点型」引流内容。

【公式】XX行业还在用原始方式干活 → 展示工具降维打击 → 引到私域。
【示例骨架】「做XX的还在手动XX？这个工具直接把效率翻X倍」
【要求】
- 痛点必须来自下方分析报告的痛点清单，写"现状成本"（时间/钱/差评）
- 语气是同行分享，不是广告；不吹参数，只讲场景
- 目标买家、行业称呼以分析报告为准
```

`templates/prompts/copy-sideline.md`:
```markdown
你要写一组「副业型」引流内容。

【公式】我做了个X，持续有收入 → 展示做的过程与结果 → 引到私域教/带。
【示例骨架】「我花X天做了个XX工具，现在每月多一份收入」
【要求】
- 主角是"我"（开发者人设），叙述真实可信，不承诺收益金额
- 强调低边际成本、时间自由，不出现"躺赚""稳赚"类词
- 结尾钩子引向"怎么选项目/怎么定价"的干货分享
```

`templates/prompts/copy-infogap.md`:
```markdown
你要写一组「信息差型」引流内容。

【公式】老板花X万买的，成本其实只要X → 揭信息差 → 给平替方案。
【示例骨架】「别再花X万找外包了，这套XX系统成本不到XXX」
【要求】
- 对比对象是"市面 SaaS 年费/外包报价"，数字用区间不用精确承诺
- 强调数据自主可控、一次部署长期用
- 不贬低具体竞品名称，只说"市面上""同类"
```

`templates/prompts/copy-story.md`:
```markdown
你要写一组「接单故事型」引流内容。

【公式】接了个单，客户要XX，我X天搞定 → 过程叙事 → 引到私域接同类单。
【示例骨架】「客户：能做个XX吗？我：等我一天（附聊天记录）」
【要求】
- 有具体客户画像（行业/诉求）、时间线（咨询→交付）、交付物
- 提到客户复购/转介绍等信任信号，不出现具体收款金额承诺
- 口播脚本里标注"聊天记录截图逐条弹出"等画面提示
```

`templates/prompts/funnel.md`:
```markdown
# 私域动线话术库（v1）

## 文案结尾钩子（轮换使用）
1. 部署文档整理好了，需要的评论区扣1
2. 同行交流群在简介，进群聊

## 评论区回复模板
- 问价格 → 「每家需求不一样，私我聊具体的」
- 问技术细节 → 「文档里写得很全，扣1发你」
- 同行套话 → 「欢迎交流，简介进群」

## 红线
- 文案中不出现微信号 / 二维码 / 价格数字
- 全部引导到评论区扣1或简介，私域再谈
```

`templates/knowledge/hooks-basics.md`（示例知识包）:
```markdown
# 钩子方法论要点（示例知识包，后续由 forgecast knowledge sync 替换为 dbskill 真实内容）

- 前3秒决定完播：钩子必须给出"与我有关"的信号（行业称呼、具体场景）
- 数字与对比是标题两大杠杆：「3个客服的活」比「很高效」强一个量级
- 痛点要写"现状成本"：时间、钱、差评，三选一量化
- CTA 只给一个动作：扣1 > 关注+点赞+收藏三连
```

- [ ] **Step 2: 写失败测试**

`packages/copywriter/test/knowledge.test.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '@forgecast/core'
import { describe, expect, it } from 'vitest'
import { searchAtoms } from '../src/knowledge'

function db() {
  const d = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-')), 't.db'))
  const ins = d.prepare('INSERT INTO knowledge_atoms (topic, content) VALUES (?, ?)')
  ins.run('hook', '前3秒必须出现行业称呼，痛点要量化')
  ins.run('hook', '标题带数字的点击率更高')
  ins.run('pricing', '定价用锚点对比，不用绝对承诺')
  return d
}

describe('searchAtoms', () => {
  it('按词命中并限量返回', () => {
    const out = searchAtoms(db(), ['痛点', '数字'], 8)
    expect(out.length).toBe(2)
    expect(out[0].content).toContain('痛点')
  })
  it('无命中返回空数组', () => {
    expect(searchAtoms(db(), ['不存在的词'])).toEqual([])
  })
})
```

`packages/copywriter/test/assemble.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { assemblePrompt } from '../src/assemble'

const base = {
  hook: 'pain' as const,
  hookTemplate: '钩子模板内容',
  formatSpec: '格式规范内容',
  knowledgeMd: '知识包内容',
  atoms: [{ id: 1, topic: 'hook', content: '原子一' }],
  analysis: '分析报告内容',
}

describe('assemblePrompt', () => {
  it('prompt 首行是钩子标记，且按 §5.6 顺序拼装', () => {
    const { system, prompt } = assemblePrompt(base)
    expect(prompt.startsWith('【钩子类型】pain')).toBe(true)
    expect(system).toContain('知识包内容')
    const order = ['钩子模板内容', '格式规范内容', '原子一', '分析报告内容']
    let last = -1
    for (const s of order) {
      const idx = prompt.indexOf(s)
      expect(idx, s).toBeGreaterThan(last)
      last = idx
    }
  })
  it('feedback 存在时追加在末尾', () => {
    const { prompt } = assemblePrompt({ ...base, feedback: '语气再口语一点' })
    expect(prompt).toContain('【用户修改意见，必须遵守】')
    expect(prompt.indexOf('语气再口语') > prompt.indexOf('分析报告内容')).toBe(true)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @forgecast/copywriter test`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

`packages/copywriter/src/knowledge.ts`:
```ts
import type Database from 'better-sqlite3'
import type { HookType } from '@forgecast/core'

export interface Atom { id: number; topic: string | null; content: string }

export const HOOK_KEYWORDS: Record<HookType, string[]> = {
  pain: ['痛点', '效率', '现状'],
  sideline: ['副业', '收入', '接单'],
  infogap: ['信息差', '成本', '定价'],
  story: ['故事', '交付', '客户'],
}

/** P1 用 LIKE 检索（中文 FTS 分词差，原子量小）；接口稳定，后续内部升级 FTS/embedding */
export function searchAtoms(db: Database.Database, terms: string[], limit = 8): Atom[] {
  const clean = terms.filter(Boolean)
  if (!clean.length) return []
  const where = clean.map(() => 'content LIKE ?').join(' OR ')
  const rows = db.prepare(
    `SELECT id, topic, content FROM knowledge_atoms WHERE ${where} LIMIT ?`,
  ).all(...clean.map((t) => `%${t}%`), limit) as Atom[]
  return rows
}
```

`packages/copywriter/src/assemble.ts`:
```ts
import type { HookType } from '@forgecast/core'
import type { Atom } from './knowledge'

export interface AssembleInput {
  hook: HookType
  hookTemplate: string
  formatSpec: string
  knowledgeMd: string
  atoms: Atom[]
  analysis: string
  feedback?: string
}

/** 提示词组装，顺序遵循主文档 §5.6：钩子模板 + 知识包(system) + 检索原子 + analysis + 修改意见 */
export function assemblePrompt(i: AssembleInput): { system: string; prompt: string } {
  const atomsBlock = i.atoms.length
    ? i.atoms.map((a, k) => `${k + 1}. ${a.content}`).join('\n')
    : '（无）'
  const system = [
    '你是小红书/抖音内容创作专家，为"基于开源二次开发的产品"写引流内容。真实感优先，广告腔一票否决。',
    i.knowledgeMd,
  ].filter(Boolean).join('\n\n')
  const prompt = [
    `【钩子类型】${i.hook}`,
    i.hookTemplate,
    i.formatSpec,
    `【方法论要点】\n${atomsBlock}`,
    `【商业化分析报告】\n${i.analysis}`,
    i.feedback ? `【用户修改意见，必须遵守】\n${i.feedback}` : '',
  ].filter(Boolean).join('\n\n---\n\n')
  return { system, prompt }
}
```

`packages/copywriter/src/index.ts` 追加：
```ts
export * from './knowledge'
export * from './assemble'
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @forgecast/copywriter test`
Expected: PASS（全部）

- [ ] **Step 6: Commit**

```bash
git add templates packages/copywriter && git commit -m "feat(copywriter): 4钩子提示词模板+格式规范+私域话术库；提示词组装与知识原子检索"
```

---

### Task 7: copywriter — generateCopy 生成主函数

**Files:**
- Create: `packages/copywriter/src/generate.ts`
- Create: `packages/core/src/ctx.ts`（CoreCtx 定义与工厂）
- Modify: `packages/copywriter/src/index.ts`, `packages/core/src/index.ts`
- Test: `packages/copywriter/test/generate.test.ts`

**Interfaces:**
- Produces（core）:
  - `interface CoreCtx { db: Database.Database; config: ForgecastConfig; llm: LlmClient }`
  - `function createCtx(root?: string, env?: NodeJS.ProcessEnv): CoreCtx`
- Produces（copywriter）:
  - `interface GenerateCopyInput { slug: string; hook: HookType; n?: number; feedback?: string; renderCovers?: boolean; onProgress?: (msg: string) => void }`
  - `interface GeneratedAsset { assetId: number; type: 'copy' | 'cover'; filePath: string; warnings: string[] }`（filePath 相对 workspace）
  - `async function generateCopy(ctx: CoreCtx, input: GenerateCopyInput): Promise<GeneratedAsset[]>`
- Consumes: Task 2-6 全部接口。本任务 `renderCovers` 默认 false（封面在 Task 8 接入后改默认 true）

- [ ] **Step 1: 写失败测试**

`packages/copywriter/test/generate.test.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { generateCopy } from '../src/generate'

let ctx: CoreCtx
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-gen-'))
  const config = loadConfig(root, {}) // mock 模式
  // 测试用真实模板目录（相对本测试文件定位到仓库根 templates/）
  config.paths.templates = path.resolve(__dirname, '../../../templates')
  const db = openDb(config.paths.db)
  db.prepare("INSERT INTO projects (slug, target_buyer) VALUES ('demo-project', '中小电商卖家')").run()
  fs.mkdirSync(path.join(root, 'workspace/demo-project'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace/demo-project/analysis.md'), '# 快客通 商业化分析\n## 痛点清单\n- 回消息熬夜')
  ctx = { db, config, llm: createLlmClient(config.llm) }
})

describe('generateCopy', () => {
  it('mock 模式产出 n 篇文案：落盘 + assets 登记 + 进度回调', async () => {
    const logs: string[] = []
    const out = await generateCopy(ctx, { slug: 'demo-project', hook: 'pain', n: 2, onProgress: (m) => logs.push(m) })
    const copies = out.filter((a) => a.type === 'copy')
    expect(copies).toHaveLength(2)
    for (const a of copies) {
      const abs = path.join(ctx.config.paths.workspace, a.filePath)
      expect(fs.existsSync(abs)).toBe(true)
      expect(fs.readFileSync(abs, 'utf8')).toContain('## 小红书正文')
      const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(a.assetId)
      expect(row.type).toBe('copy')
      expect(row.hook).toBe('pain')
      expect(row.status).toBe('draft')
    }
    expect(logs.some((l) => l.includes('生成'))).toBe(true)
  })
  it('项目不存在时抛错', async () => {
    await expect(generateCopy(ctx, { slug: 'nope', hook: 'pain' })).rejects.toThrow(/项目不存在/)
  })
  it('缺 analysis.md 时抛错', async () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('empty')").run()
    await expect(generateCopy(ctx, { slug: 'empty', hook: 'pain' })).rejects.toThrow(/analysis\.md/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/copywriter test`
Expected: FAIL（generate.ts 不存在；`CoreCtx` 未导出）

- [ ] **Step 3: 实现 core ctx**

`packages/core/src/ctx.ts`:
```ts
import type Database from 'better-sqlite3'
import { loadConfig, type ForgecastConfig } from './config'
import { openDb } from './db'
import { createLlmClient, type LlmClient } from './llm'

export interface CoreCtx {
  db: Database.Database
  config: ForgecastConfig
  llm: LlmClient
}

/** CLI 与 server 共用的上下文工厂 */
export function createCtx(root?: string, env?: NodeJS.ProcessEnv): CoreCtx {
  const config = loadConfig(root, env)
  const db = openDb(config.paths.db)
  const llm = createLlmClient(config.llm)
  return { db, config, llm }
}
```

`packages/core/src/index.ts` 追加：`export * from './ctx'`

- [ ] **Step 4: 实现 generate.ts**

`packages/copywriter/src/generate.ts`:
```ts
import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx, HookType } from '@forgecast/core'
import { assemblePrompt } from './assemble'
import { checkBannedWords } from './banned-words'
import { HOOK_KEYWORDS, searchAtoms } from './knowledge'
import { parseCopyOutput } from './parser'

export interface GenerateCopyInput {
  slug: string
  hook: HookType
  n?: number
  feedback?: string
  renderCovers?: boolean
  onProgress?: (msg: string) => void
}

export interface GeneratedAsset {
  assetId: number
  type: 'copy' | 'cover'
  filePath: string // 相对 workspace 目录
  warnings: string[]
}

function readIfExists(p: string): string {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

export async function generateCopy(ctx: CoreCtx, input: GenerateCopyInput): Promise<GeneratedAsset[]> {
  const { slug, hook, n = 1, feedback, onProgress = () => {} } = input
  const project: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug)
  if (!project) throw new Error(`项目不存在: ${slug}`)

  const wsDir = path.join(ctx.config.paths.workspace, slug)
  const analysisPath = path.join(wsDir, 'analysis.md')
  if (!fs.existsSync(analysisPath)) throw new Error(`缺少 analysis.md: ${analysisPath}（先补分析报告）`)
  const analysis = fs.readFileSync(analysisPath, 'utf8')

  onProgress('组装提示词…')
  const tplDir = ctx.config.paths.templates
  const hookTemplate = fs.readFileSync(path.join(tplDir, 'prompts', `copy-${hook}.md`), 'utf8')
  const formatSpec = fs.readFileSync(path.join(tplDir, 'prompts', '_format.md'), 'utf8')
  const knowledgeDir = path.join(tplDir, 'knowledge')
  const knowledgeMd = fs.existsSync(knowledgeDir)
    ? fs.readdirSync(knowledgeDir).filter((f) => f.endsWith('.md'))
        .map((f) => readIfExists(path.join(knowledgeDir, f))).join('\n\n')
    : ''
  const terms = [...HOOK_KEYWORDS[hook], ...(project.target_buyer ? [project.target_buyer] : [])]
  const atoms = searchAtoms(ctx.db, terms)
  const { system, prompt } = assemblePrompt({ hook, hookTemplate, formatSpec, knowledgeMd, atoms, analysis, feedback })

  const copyDir = path.join(wsDir, 'copy')
  fs.mkdirSync(copyDir, { recursive: true })
  const results: GeneratedAsset[] = []
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  for (let i = 1; i <= n; i++) {
    onProgress(`生成第 ${i}/${n} 篇（${ctx.config.llm.mode} 模式）…`)
    const raw = await ctx.llm.complete({ model: ctx.config.llm.models.copy, system, prompt })
    parseCopyOutput(raw) // 结构校验：解析失败即任务失败，不落盘半成品

    onProgress(`敏感词校验第 ${i}/${n} 篇…`)
    const warnings = checkBannedWords(raw).map((w) => `含敏感词: ${w}`)

    const fileName = `${hook}-${stamp}-${i}.md`
    const relPath = path.join(slug, 'copy', fileName)
    fs.writeFileSync(path.join(copyDir, fileName), raw, 'utf8')
    const info = ctx.db.prepare(
      'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
    ).run(project.id, 'copy', hook, relPath, JSON.stringify(warnings))
    results.push({ assetId: Number(info.lastInsertRowid), type: 'copy', filePath: relPath, warnings })
    onProgress(`第 ${i}/${n} 篇完成: ${relPath}${warnings.length ? `（⚠ ${warnings.join('；')}）` : ''}`)
  }
  return results
}
```

`packages/copywriter/src/index.ts` 追加：`export * from './generate'`

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @forgecast/copywriter test && pnpm --filter @forgecast/core test`
Expected: PASS（全部）

- [ ] **Step 6: Commit**

```bash
git add packages && git commit -m "feat(copywriter): generateCopy 主函数（组装→生成→校验→落盘→登记，mock 全链路可测）"
```

---

### Task 8: copywriter — 封面模板与渲染，接入 generateCopy

**Files:**
- Create: `templates/covers/bigtext.html`, `templates/covers/annotate.html`, `templates/covers/contrast.html`
- Create: `packages/copywriter/src/cover.ts`
- Modify: `packages/copywriter/src/generate.ts`（追加封面步骤）, `packages/copywriter/src/index.ts`
- Test: `packages/copywriter/test/cover.test.ts`

**Interfaces:**
- Produces:
  - `function buildCoverHtml(templateHtml: string, slots: { main: string; sub: string }): string`（纯函数，HTML 转义）
  - `async function renderCover(i: { templatesDir: string; template?: 'bigtext' | 'annotate' | 'contrast'; main: string; sub: string; outPath: string }): Promise<void>`（Playwright 截图 1242×1660）
  - `generateCopy` 的 `renderCovers` 默认改为 `true`；封面失败不阻断文案（转为 warning）
- Consumes: Task 7 `generateCopy`、Task 5 `parseCopyOutput`（取封面主/副标题）

- [ ] **Step 1: 写三套封面 HTML 模板**

`templates/covers/bigtext.html`（大字报型）:
```html
<!doctype html><html><head><meta charset="utf-8"><style>
:root { --bg1:#1a1a2e; --bg2:#16213e; --accent:#ffd54f; --fg:#ffffff; }
* { margin:0; box-sizing:border-box; }
body { width:1242px; height:1660px; display:flex; flex-direction:column;
  justify-content:center; align-items:center; gap:60px; padding:80px;
  background:linear-gradient(160deg,var(--bg1),var(--bg2));
  font-family:"PingFang SC","Noto Sans CJK SC",sans-serif; text-align:center; }
.main { font-size:120px; font-weight:900; color:var(--fg); line-height:1.25; }
.main em { font-style:normal; color:var(--accent); }
.sub { font-size:56px; color:var(--accent); background:rgba(255,213,79,.12);
  border:3px solid var(--accent); border-radius:20px; padding:24px 48px; }
</style></head><body>
<div class="main">{{main}}</div>
<div class="sub">{{sub}}</div>
</body></html>
```

`templates/covers/annotate.html`（截图+标注型，截图位为占位框，后续 item 填 demo 截图）:
```html
<!doctype html><html><head><meta charset="utf-8"><style>
:root { --bg:#f7f5f0; --ink:#222222; --accent:#e53935; }
* { margin:0; box-sizing:border-box; }
body { width:1242px; height:1660px; background:var(--bg); padding:70px;
  display:flex; flex-direction:column; gap:50px;
  font-family:"PingFang SC","Noto Sans CJK SC",sans-serif; }
.main { font-size:96px; font-weight:900; color:var(--ink); line-height:1.3; }
.shot { flex:1; border:6px dashed #bbb; border-radius:24px; display:flex;
  align-items:center; justify-content:center; color:#999; font-size:40px;
  background:#ffffff; }
.sub { align-self:flex-start; font-size:52px; color:#fff; background:var(--accent);
  padding:20px 44px; border-radius:16px; transform:rotate(-2deg); }
</style></head><body>
<div class="main">{{main}}</div>
<div class="shot">（demo 截图位）</div>
<div class="sub">{{sub}}</div>
</body></html>
```

`templates/covers/contrast.html`（对比型）:
```html
<!doctype html><html><head><meta charset="utf-8"><style>
:root { --left:#37474f; --right:#00897b; --fg:#ffffff; }
* { margin:0; box-sizing:border-box; }
body { width:1242px; height:1660px; display:flex; flex-direction:column;
  font-family:"PingFang SC","Noto Sans CJK SC",sans-serif; color:var(--fg); }
.main { background:#111; font-size:92px; font-weight:900; text-align:center;
  padding:70px 60px; line-height:1.3; }
.row { flex:1; display:flex; }
.cell { flex:1; display:flex; align-items:center; justify-content:center;
  font-size:64px; font-weight:700; padding:40px; text-align:center; }
.cell.old { background:var(--left); } .cell.new { background:var(--right); }
.sub { background:#111; font-size:52px; text-align:center; padding:50px; }
</style></head><body>
<div class="main">{{main}}</div>
<div class="row"><div class="cell old">以前 😫</div><div class="cell new">现在 😎</div></div>
<div class="sub">{{sub}}</div>
</body></html>
```

- [ ] **Step 2: 写失败测试（纯函数部分）**

`packages/copywriter/test/cover.test.ts`:
```ts
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCoverHtml } from '../src/cover'

const tplDir = path.resolve(__dirname, '../../../templates/covers')

describe('buildCoverHtml', () => {
  it('填槽并转义 HTML', () => {
    const tpl = fs.readFileSync(path.join(tplDir, 'bigtext.html'), 'utf8')
    const html = buildCoverHtml(tpl, { main: '网店客服<还>在手动回?', sub: '一套系统 & 三人份' })
    expect(html).toContain('网店客服&lt;还&gt;在手动回?')
    expect(html).toContain('一套系统 &amp; 三人份')
    expect(html).not.toContain('{{main}}')
    expect(html).not.toContain('{{sub}}')
  })
  it('三套模板都有两个槽位', () => {
    for (const f of ['bigtext.html', 'annotate.html', 'contrast.html']) {
      const tpl = fs.readFileSync(path.join(tplDir, f), 'utf8')
      expect(tpl, f).toContain('{{main}}')
      expect(tpl, f).toContain('{{sub}}')
    }
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @forgecast/copywriter test`
Expected: FAIL（cover.ts 不存在）

- [ ] **Step 4: 实现 cover.ts**

```ts
import fs from 'node:fs'
import path from 'node:path'

export type CoverTemplate = 'bigtext' | 'annotate' | 'contrast'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 纯函数：模板填槽（可单测，与 Playwright 解耦） */
export function buildCoverHtml(templateHtml: string, slots: { main: string; sub: string }): string {
  return templateHtml.replaceAll('{{main}}', esc(slots.main)).replaceAll('{{sub}}', esc(slots.sub))
}

export interface RenderCoverInput {
  templatesDir: string
  template?: CoverTemplate
  main: string
  sub: string
  outPath: string
}

/** Playwright 截图 1242×1660（小红书 3:4）。调用方自行 try/catch——封面失败不应阻断文案。 */
export async function renderCover(i: RenderCoverInput): Promise<void> {
  const { chromium } = await import('playwright')
  const tpl = fs.readFileSync(path.join(i.templatesDir, 'covers', `${i.template ?? 'bigtext'}.html`), 'utf8')
  const html = buildCoverHtml(tpl, { main: i.main, sub: i.sub })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1242, height: 1660 } })
    await page.setContent(html, { waitUntil: 'load' })
    fs.mkdirSync(path.dirname(i.outPath), { recursive: true })
    await page.screenshot({ path: i.outPath })
  } finally {
    await browser.close()
  }
}
```

- [ ] **Step 5: 接入 generateCopy**

`packages/copywriter/src/generate.ts` 修改：签名解构改为 `renderCovers = true`，并在每篇 copy 登记后追加：

```ts
    // —— Task 8 追加：封面渲染（失败降级为 warning，不阻断文案产出）——
    if (renderCovers) {
      onProgress(`渲染封面第 ${i}/${n} 篇…`)
      const doc = parseCopyOutput(raw)
      const coverName = `${hook}-${stamp}-${i}.png`
      const coverRel = path.join(slug, 'covers', coverName)
      try {
        const { renderCover } = await import('./cover')
        await renderCover({
          templatesDir: ctx.config.paths.templates,
          main: doc.cover.main, sub: doc.cover.sub,
          outPath: path.join(ctx.config.paths.workspace, coverRel),
        })
        const cInfo = ctx.db.prepare(
          'INSERT INTO assets (project_id, type, hook, file_path, warnings) VALUES (?, ?, ?, ?, ?)',
        ).run(project.id, 'cover', hook, coverRel, '[]')
        results.push({ assetId: Number(cInfo.lastInsertRowid), type: 'cover', filePath: coverRel, warnings: [] })
        onProgress(`封面完成: ${coverRel}`)
      } catch (err) {
        onProgress(`⚠ 封面渲染失败（文案不受影响）: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
```

同时 Task 7 测试中 `generateCopy` 调用需显式传 `renderCovers: false`（单测不依赖 Chromium）——更新 `test/generate.test.ts` 两处调用。`packages/copywriter/src/index.ts` 追加：`export * from './cover'`

- [ ] **Step 6: 安装 Chromium 并手动验证一次截图**

```bash
pnpm --filter @forgecast/copywriter exec playwright install chromium
pnpm --filter @forgecast/copywriter test
```
Expected: 测试 PASS。再跑一次真实渲染冒烟（临时脚本或 node -e），确认产出 png 尺寸 1242×1660：
```bash
cd packages/copywriter && node --import tsx -e "
import('./src/cover.ts').then(m => m.renderCover({
  templatesDir: new URL('../../templates', import.meta.url).pathname,
  main: '网店客服还在手动回？', sub: '一套系统扛住3个人的活',
  outPath: '/tmp/fc-cover-smoke.png',
})).then(() => console.log('ok'))"
file /tmp/fc-cover-smoke.png
```
Expected: `PNG image data, 1242 x 1660`

- [ ] **Step 7: Commit**

```bash
git add templates/covers packages/copywriter && git commit -m "feat(copywriter): 3套封面HTML模板 + Playwright 渲染，接入 generateCopy（失败降级）"
```

---

### Task 9: server — Hono 骨架 + 项目 API + workspace 同步

**Files:**
- Create: `packages/server/src/app.ts`, `packages/server/src/sync.ts`, `packages/server/src/index.ts`
- Test: `packages/server/test/projects.test.ts`

**Interfaces:**
- Produces:
  - `function createApp(ctx: CoreCtx, queue: TaskQueue): Hono`（Task 10 前 queue 参数先定义为 `unknown`，Task 10 收紧类型）——**本任务先实现 `createApp(ctx)` 单参形态，Task 10 再加 queue**
  - `function syncWorkspaceProjects(ctx: CoreCtx): void`（workspace/ 下每个目录 upsert 为 projects 行）
  - REST：`GET /api/projects`、`GET /api/projects/:slug`（含 `analysisMd` 字段）、`PATCH /api/projects/:slug`
- Consumes: Task 7 `CoreCtx`

- [ ] **Step 1: 写失败测试**

`packages/server/test/projects.test.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { syncWorkspaceProjects } from '../src/sync'

let ctx: CoreCtx

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-srv-'))
  const config = loadConfig(root, {})
  fs.mkdirSync(path.join(root, 'workspace/demo-project'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace/demo-project/analysis.md'), '# 分析')
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
})

describe('projects API', () => {
  it('syncWorkspaceProjects 把目录 upsert 成项目，幂等', () => {
    syncWorkspaceProjects(ctx)
    syncWorkspaceProjects(ctx)
    const rows = ctx.db.prepare('SELECT * FROM projects').all()
    expect(rows).toHaveLength(1)
    expect((rows[0] as any).slug).toBe('demo-project')
  })
  it('GET /api/projects 列表；GET 详情带 analysisMd；PATCH 可改字段', async () => {
    syncWorkspaceProjects(ctx)
    const app = createApp(ctx)
    const list = await (await app.request('/api/projects')).json() as any[]
    expect(list).toHaveLength(1)
    const detail = await (await app.request('/api/projects/demo-project')).json() as any
    expect(detail.analysisMd).toContain('# 分析')
    const patched = await app.request('/api/projects/demo-project', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brand_name: '快客通', price_deploy: 1999 }),
    })
    expect(patched.status).toBe(200)
    const after = await (await app.request('/api/projects/demo-project')).json() as any
    expect(after.brand_name).toBe('快客通')
    expect(after.price_deploy).toBe(1999)
  })
  it('未知项目 404', async () => {
    const app = createApp(ctx)
    expect((await app.request('/api/projects/nope')).status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/server test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`packages/server/src/sync.ts`:
```ts
import fs from 'node:fs'
import type { CoreCtx } from '@forgecast/core'

/** workspace/ 下每个目录即一个项目：启动时 upsert（P1 约定，替代手动 pick 流程） */
export function syncWorkspaceProjects(ctx: CoreCtx): void {
  if (!fs.existsSync(ctx.config.paths.workspace)) return
  const dirs = fs.readdirSync(ctx.config.paths.workspace, { withFileTypes: true })
    .filter((d) => d.isDirectory())
  const ins = ctx.db.prepare('INSERT INTO projects (slug) VALUES (?) ON CONFLICT(slug) DO NOTHING')
  for (const d of dirs) ins.run(d.name)
}
```

`packages/server/src/app.ts`:
```ts
import fs from 'node:fs'
import path from 'node:path'
import type { CoreCtx } from '@forgecast/core'
import { Hono } from 'hono'

const PATCHABLE = ['brand_name', 'target_buyer', 'demo_url', 'price_deploy', 'price_custom', 'stage'] as const

export function createApp(ctx: CoreCtx): Hono {
  const app = new Hono()

  app.get('/api/projects', (c) => {
    return c.json(ctx.db.prepare('SELECT * FROM projects ORDER BY id').all())
  })

  app.get('/api/projects/:slug', (c) => {
    const row: any = ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(c.req.param('slug'))
    if (!row) return c.json({ error: '项目不存在' }, 404)
    const analysisPath = path.join(ctx.config.paths.workspace, row.slug, 'analysis.md')
    const analysisMd = fs.existsSync(analysisPath) ? fs.readFileSync(analysisPath, 'utf8') : ''
    return c.json({ ...row, analysisMd })
  })

  app.patch('/api/projects/:slug', async (c) => {
    const slug = c.req.param('slug')
    const exists = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)
    if (!exists) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.json()
    const keys = PATCHABLE.filter((k) => k in body)
    if (keys.length) {
      ctx.db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE slug = ?`)
        .run(...keys.map((k) => body[k]), slug)
    }
    return c.json({ ok: true })
  })

  return app
}
```

`packages/server/src/index.ts`:
```ts
import { serve } from '@hono/node-server'
import { createCtx } from '@forgecast/core'
import { createApp } from './app'
import { syncWorkspaceProjects } from './sync'

const ctx = createCtx()
syncWorkspaceProjects(ctx)
const app = createApp(ctx)
serve({ fetch: app.fetch, port: 4321, hostname: '127.0.0.1' }, (info) => {
  console.log(`[forgecast] API 已启动 http://127.0.0.1:${info.port}（LLM 模式: ${ctx.config.llm.mode}）`)
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/server test`
Expected: PASS ×3

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "feat(server): Hono 骨架 + 项目 API + workspace 目录同步（只绑 127.0.0.1）"
```

---

### Task 10: server — 任务队列 + SSE

**Files:**
- Create: `packages/server/src/tasks.ts`
- Modify: `packages/server/src/app.ts`（挂 SSE 路由）, `packages/server/src/index.ts`
- Test: `packages/server/test/tasks.test.ts`

**Interfaces:**
- Produces:
  - `interface TaskEvent { ts: number; type: 'log' | 'done' | 'error'; message: string; result?: unknown }`
  - `interface TaskRecord { id: string; status: 'pending' | 'running' | 'done' | 'failed'; events: TaskEvent[] }`
  - `interface TaskQueue { enqueue(fn: (log: (msg: string) => void) => Promise<unknown>): string; get(id: string): TaskRecord | undefined; subscribe(id: string, cb: (e: TaskEvent) => void): () => void }`
  - `function createTaskQueue(): TaskQueue`（内存队列，并发 1，串行执行）
  - `createApp(ctx, queue)` 双参签名；REST：`GET /api/tasks/:id/events`（SSE，先回放历史事件再推实时，done/error 后关闭）
- Consumes: Task 9 `createApp`

- [ ] **Step 1: 写失败测试**

`packages/server/test/tasks.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createTaskQueue } from '../src/tasks'

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

describe('createTaskQueue', () => {
  it('执行任务并记录事件，成功后 status=done 且有 done 事件', async () => {
    const q = createTaskQueue()
    const id = q.enqueue(async (log) => { log('步骤1'); return { ok: 1 } })
    await wait(50)
    const t = q.get(id)!
    expect(t.status).toBe('done')
    expect(t.events.map((e) => e.type)).toEqual(['log', 'done'])
    expect(t.events[1].result).toEqual({ ok: 1 })
  })
  it('任务抛错 → status=failed 且有 error 事件', async () => {
    const q = createTaskQueue()
    const id = q.enqueue(async () => { throw new Error('炸了') })
    await wait(50)
    const t = q.get(id)!
    expect(t.status).toBe('failed')
    expect(t.events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('炸了') })
  })
  it('并发 1：两个任务串行执行', async () => {
    const q = createTaskQueue()
    const order: string[] = []
    q.enqueue(async () => { await wait(30); order.push('a') })
    q.enqueue(async () => { order.push('b') })
    await wait(100)
    expect(order).toEqual(['a', 'b'])
  })
  it('subscribe 收到后续事件，退订生效', async () => {
    const q = createTaskQueue()
    const got: string[] = []
    const id = q.enqueue(async (log) => { await wait(20); log('hi') })
    const off = q.subscribe(id, (e) => got.push(e.type))
    await wait(60)
    off()
    expect(got).toEqual(['log', 'done'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/server test`
Expected: FAIL（tasks.ts 不存在）

- [ ] **Step 3: 实现 tasks.ts**

```ts
import { randomUUID } from 'node:crypto'

export interface TaskEvent { ts: number; type: 'log' | 'done' | 'error'; message: string; result?: unknown }
export interface TaskRecord {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed'
  events: TaskEvent[]
}

export interface TaskQueue {
  enqueue(fn: (log: (msg: string) => void) => Promise<unknown>): string
  get(id: string): TaskRecord | undefined
  subscribe(id: string, cb: (e: TaskEvent) => void): () => void
}

/** 内存任务队列：并发 1（生成类操作串行），事件既存档又实时广播（供 SSE） */
export function createTaskQueue(): TaskQueue {
  const tasks = new Map<string, TaskRecord>()
  const subs = new Map<string, Set<(e: TaskEvent) => void>>()
  let chain: Promise<unknown> = Promise.resolve()

  function emit(id: string, e: TaskEvent) {
    tasks.get(id)!.events.push(e)
    for (const cb of subs.get(id) ?? []) cb(e)
  }

  return {
    enqueue(fn) {
      const id = randomUUID()
      tasks.set(id, { id, status: 'pending', events: [] })
      chain = chain.then(async () => {
        const t = tasks.get(id)!
        t.status = 'running'
        try {
          const result = await fn((msg) => emit(id, { ts: Date.now(), type: 'log', message: msg }))
          t.status = 'done'
          emit(id, { ts: Date.now(), type: 'done', message: '完成', result })
        } catch (err) {
          t.status = 'failed'
          emit(id, { ts: Date.now(), type: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      })
      return id
    },
    get: (id) => tasks.get(id),
    subscribe(id, cb) {
      if (!subs.has(id)) subs.set(id, new Set())
      subs.get(id)!.add(cb)
      return () => subs.get(id)!.delete(cb)
    },
  }
}
```

- [ ] **Step 4: 挂 SSE 路由并改双参签名**

`packages/server/src/app.ts`：签名改 `export function createApp(ctx: CoreCtx, queue: TaskQueue): Hono`，头部加 `import { streamSSE } from 'hono/streaming'` 与 `import type { TaskQueue, TaskEvent } from './tasks'`，追加路由：

```ts
  app.get('/api/tasks/:id/events', (c) => {
    const task = queue.get(c.req.param('id'))
    if (!task) return c.json({ error: '任务不存在' }, 404)
    return streamSSE(c, async (stream) => {
      let closed = false
      const send = (e: TaskEvent) => stream.writeSSE({ data: JSON.stringify(e) })
      for (const e of task.events) await send(e) // 回放历史（订阅前已发生的事件不丢）
      if (task.status === 'done' || task.status === 'failed') return
      await new Promise<void>((resolve) => {
        const off = queue.subscribe(task.id, async (e) => {
          await send(e)
          if (e.type === 'done' || e.type === 'error') { off(); closed = true; resolve() }
        })
        stream.onAbort(() => { if (!closed) { off(); resolve() } })
      })
    })
  })
```

`packages/server/src/index.ts`：`const queue = createTaskQueue()`，`createApp(ctx, queue)`。
`packages/server/test/projects.test.ts`：`createApp(ctx)` 改为 `createApp(ctx, createTaskQueue())`。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @forgecast/server test`
Expected: PASS（projects 3 + tasks 4）

- [ ] **Step 6: Commit**

```bash
git add packages/server && git commit -m "feat(server): 内存任务队列（并发1）+ SSE 进度流（历史回放+实时推送）"
```

---

### Task 11: server — 生成端点 + 素材 API + 上传 + 静态文件

**Files:**
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/assets.test.ts`

**Interfaces:**
- Produces（REST，全部挂在 createApp 内）:
  - `POST /api/projects/:slug/copy` body `{ hook, n?, feedback? }` → `{ taskId }`（任务体调 `generateCopy`）
  - `GET /api/projects/:slug/assets` → Asset[]（按 id 倒序）
  - `GET /api/assets/:id/content` → `{ content }`；`PUT /api/assets/:id/content` body `{ content }`（写回文件）
  - `PATCH /api/assets/:id` body `{ status }`（仅允许 draft/approved/published）
  - `POST /api/projects/:slug/raw`（multipart，字段名 `file`）→ 存 `workspace/<slug>/raw/`
  - `GET /api/projects/:slug/raw` → `{ files: string[] }`
  - `GET /files/*` → workspace 静态文件（路径穿越防护）
- Consumes: Task 7 `generateCopy`、Task 10 `TaskQueue`

- [ ] **Step 1: 写失败测试**

`packages/server/test/assets.test.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { syncWorkspaceProjects } from '../src/sync'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let queue: ReturnType<typeof createTaskQueue>

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-a-'))
  const config = loadConfig(root, {})
  config.paths.templates = path.resolve(__dirname, '../../../templates')
  fs.mkdirSync(path.join(root, 'workspace/demo-project'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace/demo-project/analysis.md'), '# 分析\n## 痛点清单\n- 熬夜回消息')
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  syncWorkspaceProjects(ctx)
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

async function generateOne(): Promise<any> {
  const res = await app.request('/api/projects/demo-project/copy', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook: 'pain', n: 1, renderCovers: false }),
  })
  expect(res.status).toBe(200)
  const { taskId } = await res.json() as any
  for (let i = 0; i < 100; i++) {
    await wait(30)
    const s = queue.get(taskId)!.status
    if (s === 'done') return
    if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

describe('copy 生成 + assets API', () => {
  it('POST copy → 任务完成 → assets 可查、内容可读可改、可审核', async () => {
    await generateOne()
    const assets = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
    expect(assets.length).toBeGreaterThanOrEqual(1)
    const copy = assets.find((a) => a.type === 'copy')!

    const got = await (await app.request(`/api/assets/${copy.id}/content`)).json() as any
    expect(got.content).toContain('## 小红书正文')

    const newContent = got.content.replace('## 小红书正文', '## 小红书正文\n（人工改过）')
    const put = await app.request(`/api/assets/${copy.id}/content`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: newContent }),
    })
    expect(put.status).toBe(200)
    const abs = path.join(ctx.config.paths.workspace, copy.file_path)
    expect(fs.readFileSync(abs, 'utf8')).toContain('（人工改过）')

    const patched = await app.request(`/api/assets/${copy.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })
    expect(patched.status).toBe(200)
    const after = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
    expect(after.find((a) => a.id === copy.id).status).toBe('approved')
  })
  it('非法 status 拒绝', async () => {
    await generateOne()
    const assets = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
    const res = await app.request(`/api/assets/${assets[0].id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'hacked' }),
    })
    expect(res.status).toBe(400)
  })
  it('raw 上传与列表', async () => {
    const fd = new FormData()
    fd.append('file', new File(['fake-video'], 'demo.mp4', { type: 'video/mp4' }))
    const up = await app.request('/api/projects/demo-project/raw', { method: 'POST', body: fd })
    expect(up.status).toBe(200)
    const { files } = await (await app.request('/api/projects/demo-project/raw')).json() as any
    expect(files).toContain('demo.mp4')
  })
  it('/files/* 提供 workspace 文件且防路径穿越', async () => {
    await generateOne()
    const assets = await (await app.request('/api/projects/demo-project/assets')).json() as any[]
    const copy = assets.find((a) => a.type === 'copy')!
    const ok = await app.request(`/files/${copy.file_path}`)
    expect(ok.status).toBe(200)
    const evil = await app.request('/files/../package.json')
    expect(evil.status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @forgecast/server test`
Expected: FAIL（路由不存在，404）

- [ ] **Step 3: 实现（app.ts 追加路由）**

头部追加 `import { generateCopy } from '@forgecast/copywriter'`、`import { HOOKS } from '@forgecast/core'`。createApp 内追加：

```ts
  // —— 生成 ——
  app.post('/api/projects/:slug/copy', async (c) => {
    const slug = c.req.param('slug')
    const project = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)
    if (!project) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.json()
    if (!HOOKS.includes(body.hook)) return c.json({ error: `hook 必须是 ${HOOKS.join('/')}` }, 400)
    const taskId = queue.enqueue((log) => generateCopy(ctx, {
      slug, hook: body.hook, n: body.n ?? 1, feedback: body.feedback,
      renderCovers: body.renderCovers ?? true, onProgress: log,
    }))
    return c.json({ taskId })
  })

  // —— 素材 ——
  app.get('/api/projects/:slug/assets', (c) => {
    const project: any = ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(c.req.param('slug'))
    if (!project) return c.json({ error: '项目不存在' }, 404)
    return c.json(ctx.db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY id DESC').all(project.id))
  })

  function assetAbsPath(id: string): { row: any; abs: string } | null {
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id)
    if (!row) return null
    return { row, abs: path.join(ctx.config.paths.workspace, row.file_path) }
  }

  app.get('/api/assets/:id/content', (c) => {
    const hit = assetAbsPath(c.req.param('id'))
    if (!hit || !fs.existsSync(hit.abs)) return c.json({ error: '素材不存在' }, 404)
    return c.json({ content: fs.readFileSync(hit.abs, 'utf8') })
  })

  app.put('/api/assets/:id/content', async (c) => {
    const hit = assetAbsPath(c.req.param('id'))
    if (!hit) return c.json({ error: '素材不存在' }, 404)
    const { content } = await c.req.json()
    if (typeof content !== 'string') return c.json({ error: 'content 必须是字符串' }, 400)
    fs.writeFileSync(hit.abs, content, 'utf8')
    return c.json({ ok: true })
  })

  app.patch('/api/assets/:id', async (c) => {
    const hit = assetAbsPath(c.req.param('id'))
    if (!hit) return c.json({ error: '素材不存在' }, 404)
    const { status } = await c.req.json()
    if (!['draft', 'approved', 'published'].includes(status)) return c.json({ error: '非法 status' }, 400)
    ctx.db.prepare('UPDATE assets SET status = ? WHERE id = ?').run(status, hit.row.id)
    return c.json({ ok: true })
  })

  // —— raw 上传与列表 ——
  app.post('/api/projects/:slug/raw', async (c) => {
    const slug = c.req.param('slug')
    if (!ctx.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) return c.json({ error: '项目不存在' }, 404)
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) return c.json({ error: '缺少 file 字段' }, 400)
    const rawDir = path.join(ctx.config.paths.workspace, slug, 'raw')
    fs.mkdirSync(rawDir, { recursive: true })
    const safeName = path.basename(file.name)
    fs.writeFileSync(path.join(rawDir, safeName), Buffer.from(await file.arrayBuffer()))
    return c.json({ ok: true, name: safeName })
  })

  app.get('/api/projects/:slug/raw', (c) => {
    const dir = path.join(ctx.config.paths.workspace, c.req.param('slug'), 'raw')
    return c.json({ files: fs.existsSync(dir) ? fs.readdirSync(dir) : [] })
  })

  // —— workspace 静态文件（封面/视频预览）——
  const MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.md': 'text/markdown; charset=utf-8',
  }
  app.get('/files/*', (c) => {
    const rel = decodeURIComponent(c.req.path.replace(/^\/files\//, ''))
    const wsRoot = path.resolve(ctx.config.paths.workspace)
    const abs = path.resolve(wsRoot, rel)
    if (!abs.startsWith(wsRoot + path.sep) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return c.notFound()
    }
    return c.body(fs.readFileSync(abs) as any, 200, {
      'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream',
    })
  })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @forgecast/server test`
Expected: PASS（全部）

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "feat(server): 生成端点+素材CRUD+raw上传+workspace静态托管（防路径穿越）"
```

---

### Task 12: CLI — forgecast dev / copy

**Files:**
- Create: `cli.ts`
- Test: 手动验证（CLI 是薄封装，逻辑都在已测的 core 函数里）

**Interfaces:**
- Consumes: `createCtx`、`generateCopy`、`syncWorkspaceProjects`（经 server 包不可取——sync 逻辑简单，CLI 直接内联同款 upsert 或仅提示先启动 server；**决定：CLI copy 前内联调用同款 sync SQL**，避免 CLI 依赖 server 包）
- Produces: `pnpm dev`（= `tsx cli.ts dev`）同时起 API 与 Web；`tsx cli.ts copy <slug> --hook=pain --n=2`

- [ ] **Step 1: 实现 cli.ts**

```ts
#!/usr/bin/env tsx
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createCtx } from '@forgecast/core'
import { generateCopy } from '@forgecast/copywriter'

const [cmd, ...rest] = process.argv.slice(2)

function arg(name: string): string | undefined {
  const hit = rest.find((a) => a.startsWith(`--${name}=`))
  return hit?.split('=')[1]
}

async function main() {
  switch (cmd) {
    case 'dev': {
      // API + Web 一键起：子进程各自输出带前缀
      const procs = [
        { name: 'api', p: spawn('pnpm', ['--filter', '@forgecast/server', 'dev'], { stdio: 'pipe' }) },
        { name: 'web', p: spawn('pnpm', ['--filter', 'web', 'dev'], { stdio: 'pipe' }) },
      ]
      for (const { name, p } of procs) {
        p.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`))
        p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`))
        p.on('exit', (code) => { console.log(`[${name}] 退出 ${code}`); process.exit(code ?? 1) })
      }
      break
    }
    case 'copy': {
      const slug = rest.find((a) => !a.startsWith('--'))
      const hook = arg('hook') as any
      if (!slug || !hook) { console.error('用法: forgecast copy <slug> --hook=pain [--n=1]'); process.exit(1) }
      const ctx = createCtx()
      // 与 server 同款 workspace 同步（保证 CLI 单独可用）
      if (fs.existsSync(ctx.config.paths.workspace)) {
        const ins = ctx.db.prepare('INSERT INTO projects (slug) VALUES (?) ON CONFLICT(slug) DO NOTHING')
        for (const d of fs.readdirSync(ctx.config.paths.workspace, { withFileTypes: true })) {
          if (d.isDirectory()) ins.run(d.name)
        }
      }
      const out = await generateCopy(ctx, {
        slug, hook, n: Number(arg('n') ?? 1), feedback: arg('feedback'),
        onProgress: (m) => console.log(`  ${m}`),
      })
      console.log(`\n完成 ${out.length} 个素材:`)
      for (const a of out) console.log(`  [${a.type}] workspace/${a.filePath}${a.warnings.length ? ` ⚠ ${a.warnings.join('；')}` : ''}`)
      break
    }
    default:
      console.log(`forgecast <command>
  dev                              启动 API(:4321) + Web(:5173)
  copy <slug> --hook=<型> [--n=N]  生成文案+封面（mock/live 由 .env 决定）
（scout/analyze/rebrand/video/knowledge/calendar 属后续里程碑项，未实现）`)
  }
}
main()
```

- [ ] **Step 2: 手动验证 copy 命令**

```bash
mkdir -p workspace/demo-project && [ -f workspace/demo-project/analysis.md ] || echo '# 占位' > workspace/demo-project/analysis.md
pnpm exec tsx cli.ts copy demo-project --hook=pain --n=1
ls workspace/demo-project/copy workspace/demo-project/covers
```
Expected: 打印进度日志，`copy/` 下出现 `pain-*.md`，`covers/` 下出现 `pain-*.png`（Chromium 已装的前提下）。

- [ ] **Step 3: Commit**

```bash
git add cli.ts workspace && git commit -m "feat(cli): forgecast dev/copy 命令（与 Web 共用同一套 core 函数）"
```

---

### Task 13: Web — 脚手架 + API 层 + 布局路由

**Files:**
- Create: `apps/web/package.json`（覆盖占位）, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/tsconfig.json`, `apps/web/src/main.tsx`, `apps/web/src/index.css`, `apps/web/src/api.ts`, `apps/web/src/App.tsx`

**Interfaces:**
- Produces:
  - `interface Project { id: number; slug: string; brand_name: string | null; target_buyer: string | null; demo_url: string | null; price_deploy: number | null; price_custom: number | null; stage: string; analysisMd?: string }`
  - `interface Asset { id: number; project_id: number; type: 'copy' | 'cover' | 'video'; hook: string | null; file_path: string; status: 'draft' | 'approved' | 'published'; warnings: string | null }`
  - `async function api<T>(path: string, init?: RequestInit): Promise<T>`
  - `function subscribeTask(taskId: string, onEvent: (e: { type: string; message: string }) => void): () => void`
  - 路由：`/`（重定向素材工坊）、`/workshop`、`/projects/:slug`
- Consumes: Task 9-11 的 REST API（经 vite proxy `/api`、`/files` → 4321）

- [ ] **Step 1: 写脚手架文件**

`apps/web/package.json`:
```json
{
  "name": "web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "echo 'web: 人工验收，无单测'"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.60.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-markdown": "^9.0.0",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0"
  }
}
```

`apps/web/vite.config.ts`:
```ts
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4321',
      '/files': 'http://127.0.0.1:4321',
    },
  },
})
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "types": [], "lib": ["ES2022", "DOM", "DOM.Iterable"] },
  "include": ["src"]
}
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ForgeCast 控制台</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

`apps/web/src/index.css`:
```css
@import "tailwindcss";
```

`apps/web/src/api.ts`:
```ts
export interface Project {
  id: number; slug: string; brand_name: string | null; target_buyer: string | null
  demo_url: string | null; price_deploy: number | null; price_custom: number | null
  stage: string; analysisMd?: string
}
export interface Asset {
  id: number; project_id: number; type: 'copy' | 'cover' | 'video'; hook: string | null
  file_path: string; status: 'draft' | 'approved' | 'published'; warnings: string | null
}
export interface TaskEvent { ts: number; type: 'log' | 'done' | 'error'; message: string }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

/** 订阅任务 SSE；done/error 后自动关闭。返回手动关闭函数。 */
export function subscribeTask(taskId: string, onEvent: (e: TaskEvent) => void): () => void {
  const es = new EventSource(`/api/tasks/${taskId}/events`)
  es.onmessage = (m) => {
    const e = JSON.parse(m.data) as TaskEvent
    onEvent(e)
    if (e.type === 'done' || e.type === 'error') es.close()
  }
  es.onerror = () => es.close()
  return () => es.close()
}
```

`apps/web/src/main.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

const qc = new QueryClient()
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter><App /></BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
```

`apps/web/src/App.tsx`:
```tsx
import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import ProjectDetailPage from './pages/ProjectDetailPage'
import WorkshopPage from './pages/WorkshopPage'

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b bg-white px-6 py-3 flex items-center gap-6">
        <span className="font-bold text-lg">ForgeCast</span>
        <nav className="flex gap-4 text-sm">
          <NavLink to="/workshop" className={({ isActive }) => isActive ? 'font-semibold text-blue-600' : 'text-neutral-500'}>素材工坊</NavLink>
        </nav>
      </header>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<Navigate to="/workshop" replace />} />
          <Route path="/workshop" element={<WorkshopPage />} />
          <Route path="/projects/:slug" element={<ProjectDetailPage />} />
        </Routes>
      </main>
    </div>
  )
}
```

（`pages/WorkshopPage.tsx`、`pages/ProjectDetailPage.tsx` 在 Task 14/15 实现；本任务先放最小占位使编译通过：）

`apps/web/src/pages/WorkshopPage.tsx`（占位）:
```tsx
export default function WorkshopPage() { return <div>素材工坊（Task 14）</div> }
```
`apps/web/src/pages/ProjectDetailPage.tsx`（占位）:
```tsx
export default function ProjectDetailPage() { return <div>项目详情（Task 15）</div> }
```

- [ ] **Step 2: 安装并验证可启动**

```bash
pnpm install
pnpm --filter web dev &
sleep 3 && curl -s http://localhost:5173 | head -5
kill %1
```
Expected: HTML 输出含 `ForgeCast 控制台`（title）。

- [ ] **Step 3: Commit**

```bash
git add apps/web pnpm-lock.yaml && git commit -m "feat(web): Vite+React+Tailwind 脚手架、API 层、路由布局（proxy→:4321）"
```

---

### Task 14: Web — 素材工坊页

**Files:**
- Create: `apps/web/src/pages/WorkshopPage.tsx`（覆盖占位）, `apps/web/src/components/AssetCard.tsx`

**Interfaces:**
- Consumes: Task 13 `api/subscribeTask/Project/Asset`；REST 全集
- Produces: 素材工坊完整交互——选项目+钩子+篇数→生成（SSE 日志）→素材列表（md 预览/行内编辑/审核/重新生成附意见/封面缩略图/敏感词警告高亮）

- [ ] **Step 1: 实现 AssetCard**

`apps/web/src/components/AssetCard.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, type Asset } from '../api'

export default function AssetCard({ asset, onRegenerate }: {
  asset: Asset
  onRegenerate: (feedback: string) => void
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState('')
  const warnings: string[] = asset.warnings ? JSON.parse(asset.warnings) : []

  const content = useQuery({
    queryKey: ['asset-content', asset.id],
    queryFn: () => api<{ content: string }>(`/api/assets/${asset.id}/content`),
    enabled: asset.type === 'copy',
  })
  const save = useMutation({
    mutationFn: (c: string) => api(`/api/assets/${asset.id}/content`, { method: 'PUT', body: JSON.stringify({ content: c }) }),
    onSuccess: () => { setEditing(false); qc.invalidateQueries({ queryKey: ['asset-content', asset.id] }) },
  })
  const approve = useMutation({
    mutationFn: (status: string) => api(`/api/assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets'] }),
  })

  if (asset.type === 'cover') {
    return (
      <div className="rounded-lg border bg-white p-3 flex items-center gap-3">
        <img src={`/files/${asset.file_path}`} alt="封面" className="h-32 rounded border" />
        <div className="text-sm text-neutral-500">封面 · {asset.hook} · {asset.status}</div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-neutral-500">
          #{asset.id} · {asset.hook} ·
          <span className={asset.status === 'approved' ? 'text-green-600 font-medium' : ''}> {asset.status}</span>
        </div>
        <div className="flex gap-2">
          {!editing && (
            <button className="rounded border px-3 py-1 text-sm"
              onClick={() => { setDraft(content.data?.content ?? ''); setEditing(true) }}>编辑</button>
          )}
          {asset.status === 'draft' && (
            <button className="rounded bg-green-600 px-3 py-1 text-sm text-white"
              onClick={() => approve.mutate('approved')}>审核通过</button>
          )}
        </div>
      </div>
      {warnings.length > 0 && (
        <div className="rounded bg-amber-50 border border-amber-300 px-3 py-2 text-sm text-amber-800">
          {warnings.join('；')}
        </div>
      )}
      {editing ? (
        <div className="space-y-2">
          <textarea className="w-full h-72 rounded border p-2 font-mono text-sm"
            value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2">
            <button className="rounded bg-blue-600 px-3 py-1 text-sm text-white" onClick={() => save.mutate(draft)}>保存</button>
            <button className="rounded border px-3 py-1 text-sm" onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      ) : (
        <div className="prose prose-sm max-w-none max-h-72 overflow-y-auto border-t pt-2">
          <ReactMarkdown>{content.data?.content ?? '加载中…'}</ReactMarkdown>
        </div>
      )}
      <div className="flex gap-2 border-t pt-2">
        <input className="flex-1 rounded border px-2 py-1 text-sm" placeholder="修改意见（拼入提示词重新生成）"
          value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        <button className="rounded border px-3 py-1 text-sm" disabled={!feedback}
          onClick={() => { onRegenerate(feedback); setFeedback('') }}>重新生成</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 实现 WorkshopPage**

`apps/web/src/pages/WorkshopPage.tsx`:
```tsx
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, subscribeTask, type Asset, type Project } from '../api'
import AssetCard from '../components/AssetCard'

const HOOKS = [
  { value: 'pain', label: '行业痛点型' },
  { value: 'sideline', label: '副业型' },
  { value: 'infogap', label: '信息差型' },
  { value: 'story', label: '接单故事型' },
]

export default function WorkshopPage() {
  const qc = useQueryClient()
  const [slug, setSlug] = useState('')
  const [hook, setHook] = useState('pain')
  const [n, setN] = useState(1)
  const [logs, setLogs] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  const selected = slug || projects.data?.[0]?.slug || ''
  const assets = useQuery({
    queryKey: ['assets', selected],
    queryFn: () => api<Asset[]>(`/api/projects/${selected}/assets`),
    enabled: !!selected,
  })

  async function generate(feedback?: string) {
    if (!selected || running) return
    setRunning(true)
    setLogs([])
    try {
      const { taskId } = await api<{ taskId: string }>(`/api/projects/${selected}/copy`, {
        method: 'POST', body: JSON.stringify({ hook, n, feedback }),
      })
      subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, `${e.type === 'error' ? '❌ ' : ''}${e.message}`])
        logRef.current?.scrollTo({ top: 999999 })
        if (e.type === 'done' || e.type === 'error') {
          setRunning(false)
          qc.invalidateQueries({ queryKey: ['assets', selected] })
        }
      })
    } catch (err) {
      setLogs((l) => [...l, `❌ ${err instanceof Error ? err.message : String(err)}`])
      setRunning(false)
    }
  }

  return (
    <div className="grid grid-cols-[320px_1fr] gap-6">
      {/* 左侧：生成面板 */}
      <div className="space-y-4">
        <div className="rounded-lg border bg-white p-4 space-y-3">
          <div>
            <label className="text-sm text-neutral-500">项目</label>
            <select className="mt-1 w-full rounded border p-2" value={selected} onChange={(e) => setSlug(e.target.value)}>
              {projects.data?.map((p) => <option key={p.slug} value={p.slug}>{p.brand_name ?? p.slug}</option>)}
            </select>
            {selected && <Link to={`/projects/${selected}`} className="text-xs text-blue-600">查看项目详情 →</Link>}
          </div>
          <div>
            <label className="text-sm text-neutral-500">钩子类型</label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {HOOKS.map((h) => (
                <button key={h.value}
                  className={`rounded border px-2 py-1.5 text-sm ${hook === h.value ? 'border-blue-600 bg-blue-50 text-blue-700' : ''}`}
                  onClick={() => setHook(h.value)}>{h.label}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm text-neutral-500">篇数</label>
            <input type="number" min={1} max={5} className="mt-1 w-full rounded border p-2"
              value={n} onChange={(e) => setN(Number(e.target.value))} />
          </div>
          <button className="w-full rounded bg-blue-600 py-2 text-white disabled:opacity-50"
            disabled={!selected || running} onClick={() => generate()}>
            {running ? '生成中…' : '生成'}
          </button>
        </div>
        {logs.length > 0 && (
          <div ref={logRef} className="rounded-lg border bg-neutral-900 p-3 text-xs text-green-400 font-mono h-48 overflow-y-auto space-y-1">
            {logs.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>
      {/* 右侧：素材列表 */}
      <div className="space-y-4">
        {assets.data?.length === 0 && <div className="text-neutral-400 text-sm">暂无素材，点左侧「生成」</div>}
        {assets.data?.map((a) => (
          <AssetCard key={a.id} asset={a} onRegenerate={(fb) => generate(fb)} />
        ))}
      </div>
    </div>
  )
}
```

安装 typography 插件不必要——`prose` 类在 Tailwind v4 需要 `@tailwindcss/typography`；为避免额外依赖，把 AssetCard 中 `prose prose-sm max-w-none` 替换为 `text-sm leading-relaxed [&_h2]:font-bold [&_h2]:mt-3 [&_li]:ml-4`。

- [ ] **Step 3: 手动验证**

```bash
pnpm dev
```
浏览器打开 http://localhost:5173/workshop：选 demo-project → 钩子「行业痛点型」→ 生成 → 观察 SSE 日志滚动 → 素材卡片出现（文案渲染 + 封面缩略图）→ 编辑保存 → 审核通过（状态变绿）→ 填修改意见重新生成。
Expected: 全流程无报错；`workspace/demo-project/copy/` 与 `covers/` 有新文件。

- [ ] **Step 4: Commit**

```bash
git add apps/web && git commit -m "feat(web): 素材工坊页（生成+SSE日志+md预览+行内编辑+审核+重新生成）"
```

---

### Task 15: Web — 项目详情页

**Files:**
- Create: `apps/web/src/pages/ProjectDetailPage.tsx`（覆盖占位）

**Interfaces:**
- Consumes: Task 13 `api/Project`；REST `GET/PATCH /api/projects/:slug`、`POST/GET /api/projects/:slug/raw`

- [ ] **Step 1: 实现**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useParams } from 'react-router-dom'
import { api, type Project } from '../api'

const FIELDS = [
  { key: 'brand_name', label: '品牌名' },
  { key: 'target_buyer', label: '买家画像' },
  { key: 'demo_url', label: 'Demo 地址' },
  { key: 'price_deploy', label: '部署价（元）', number: true },
  { key: 'price_custom', label: '定制起步价（元）', number: true },
] as const

export default function ProjectDetailPage() {
  const { slug = '' } = useParams()
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({})

  const project = useQuery({
    queryKey: ['project', slug],
    queryFn: () => api<Project>(`/api/projects/${slug}`),
  })
  const raw = useQuery({
    queryKey: ['raw', slug],
    queryFn: () => api<{ files: string[] }>(`/api/projects/${slug}/raw`),
  })
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/projects/${slug}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', slug] }),
  })

  async function upload(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`/api/projects/${slug}/raw`, { method: 'POST', body: fd })
    if (!res.ok) alert(`上传失败: ${await res.text()}`)
    qc.invalidateQueries({ queryKey: ['raw', slug] })
  }

  if (!project.data) return <div className="text-neutral-400">加载中…</div>
  const p = project.data

  return (
    <div className="grid grid-cols-[1fr_360px] gap-6">
      <div className="rounded-lg border bg-white p-6 text-sm leading-relaxed [&_h1]:text-xl [&_h1]:font-bold [&_h2]:font-bold [&_h2]:mt-4 [&_li]:ml-4">
        {p.analysisMd
          ? <ReactMarkdown>{p.analysisMd}</ReactMarkdown>
          : <div className="text-neutral-400">暂无 analysis.md——在 workspace/{slug}/ 下补充分析报告</div>}
      </div>
      <div className="space-y-4">
        <div className="rounded-lg border bg-white p-4 space-y-3">
          <h3 className="font-semibold">项目信息 · {p.slug}（{p.stage}）</h3>
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label className="text-xs text-neutral-500">{f.label}</label>
              <input className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
                defaultValue={(p as any)[f.key] ?? ''}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
            </div>
          ))}
          <button className="w-full rounded bg-blue-600 py-1.5 text-sm text-white"
            onClick={() => save.mutate(Object.fromEntries(
              Object.entries(form).map(([k, v]) => [k, FIELDS.find((f) => f.key === k && 'number' in f && (f as any).number) ? Number(v) : v]),
            ))}>保存</button>
        </div>
        <div className="rounded-lg border bg-white p-4 space-y-2">
          <h3 className="font-semibold">raw 素材（录屏/截图）</h3>
          <input type="file" className="text-sm"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <ul className="text-sm text-neutral-600 space-y-1">
            {raw.data?.files.map((f) => (
              <li key={f}><a className="text-blue-600" href={`/files/${slug}/raw/${f}`} target="_blank" rel="noreferrer">{f}</a></li>
            ))}
            {raw.data?.files.length === 0 && <li className="text-neutral-400">暂无</li>}
          </ul>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 手动验证**

`pnpm dev` → 素材工坊点「查看项目详情」→ analysis.md 渲染显示；填品牌名「快客通」、部署价 1999 保存 → 刷新仍在；上传一张图片 → 列表出现且可点开。

- [ ] **Step 3: Commit**

```bash
git add apps/web && git commit -m "feat(web): 项目详情页（analysis渲染+字段编辑+raw素材上传）"
```

---

### Task 16: demo-project 数据 + 端到端走查

**Files:**
- Create: `workspace/demo-project/analysis.md`（正式版，覆盖 Task 12 的占位）

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: 写正式 analysis.md**

`workspace/demo-project/analysis.md`（按主文档 §4 固定结构，与 fixtures 口径一致——「快客通」）:
```markdown
# 快客通（Chatwoot 换皮）商业化分析

## 一句话：这是给谁的什么
给中小电商卖家（淘宝/抖店/自建站）的多渠道在线客服系统：所有渠道咨询进一个后台，带自动回复和客户档案。

## 目标买家画像（主攻1个，备选2个）
- 主攻：淘宝/抖店中小卖家（1-5人团队），现在用微信+旺旺+抖店后台手动回复，每天花2-4小时，旺季漏单常态；为客服工具年花费 0-2000 元（多数硬扛）
- 备选1：自建站外贸 SOHO（需网页聊天组件）
- 备选2：本地服务商家（美容/维修，微信咨询漏回）

## 痛点清单（按付费意愿排序）
1. 多平台消息漏回 → 差评/丢单（现状成本：每漏一单损失几十到几百元）
2. 重复问题占 70% 咨询（发货时间/退换规则），人工逐条回（现状成本：每天 2h+）
3. 客户信息散落，回头客认不出（现状成本：复购率上不去）

## 换皮方向建议
- 品牌名候选：快客通 / 聚客答 / 店小应
- 砍：企业级团队协作、SLA 报表；留：多渠道收件箱、自动回复、客户档案
- 新增本土化：微信客服渠道接入、抖店消息对接

## 定价建议
- 部署价：1999 元（含服务器配置指导）
- 定制起步价：5000 元
- 参照物：市面客服 SaaS 年费 6000-20000 元/年

## 钩子匹配
- 副业型：适用度 中 ——「我花3天装了个客服系统，现在每月多一份收入」
- 信息差型：适用度 高 ——「老板花2万买的客服系统，成本其实不到500」
- 接单故事型：适用度 高 ——「客户问能不能做个客服系统，我说等我一天」
- 行业痛点型：适用度 高 ——「做电商的还在用微信回客户？」

## 风险
- Chatwoot 为 MIT 协议，可商用改造；不使用其商标与 Logo
- 小红书已有同类"开源客服"内容，差异化打"电商垂直场景"
- 交付难点：买家服务器环境五花八门 → 标准化 Docker 部署文档
```

- [ ] **Step 2: 端到端走查（验收清单）**

```bash
rm -rf db && pnpm dev   # 干净库启动，验证迁移+同步
```
浏览器逐项确认：
1. `/workshop` 项目下拉出现 demo-project
2. 生成（pain, n=2）→ SSE 日志滚动 → 2 篇文案 + 2 张封面出现
3. 文案预览是渲染后的 markdown；点编辑改一行→保存→预览更新
4. 审核通过 → 状态 approved
5. 填修改意见「语气更口语」→ 重新生成 → 新素材出现
6. 项目详情：analysis.md 完整渲染；改字段保存；上传文件成功
7. CLI 同源验证：`pnpm exec tsx cli.ts copy demo-project --hook=story` 产出落盘且 Web 刷新可见
Expected: 7 项全过。任何一项失败按 systematic-debugging 处理后重走。

- [ ] **Step 3: Commit**

```bash
git add workspace && git commit -m "feat: demo-project 正式分析报告（快客通），端到端走查通过"
```

---

### Task 17: Docker Compose 骨架 + README

**Files:**
- Create: `docker-compose.yml`, `Dockerfile`, `.dockerignore`, `README.md`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: `docker compose config -q` 通过的编排骨架；项目 README

- [ ] **Step 1: 写 Docker 文件**

`Dockerfile`:
```dockerfile
FROM node:20-slim
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps ./apps
COPY cli.ts tsconfig.base.json ./
RUN pnpm install --frozen-lockfile
EXPOSE 4321
CMD ["pnpm", "--filter", "@forgecast/server", "dev"]
```

`.dockerignore`:
```
node_modules
**/node_modules
db
workspace
.env
.git
```

`docker-compose.yml`:
```yaml
services:
  app:                      # Hono API + CLI 入口
    build: .
    ports: ["127.0.0.1:4321:4321"]
    volumes:
      - ./workspace:/app/workspace
      - ./db:/app/db
      - ./templates:/app/templates
    env_file: .env

  # renderer: Remotion 渲染 worker —— P1 item 4 实装（Chromium+ffmpeg+中文字体封镜像）
  # renderer:
  #   build: { context: ., dockerfile: Dockerfile.renderer }
  #   volumes:
  #     - ./workspace:/app/workspace
```

- [ ] **Step 2: 验证编排语法（不做全量构建）**

```bash
cp -n .env.example .env || true
docker compose config -q && echo "compose 语法 OK"
```
Expected: `compose 语法 OK`。全量镜像构建属一次性验证，需要时执行 `DOCKER_BUILDKIT=0 docker compose build`（**必须带 DOCKER_BUILDKIT=0**，本机路径含中文）——不阻塞本任务。

- [ ] **Step 3: 写 README.md**

```markdown
# ForgeCast — 开源变现内容工厂

一条「筛选开源项目 → 换皮成自有产品 → 批量生成小红书/抖音素材 → 引流接定制单」的个人内容生产流水线。当前进度：**P1 第 1-3 项**（core+server 骨架、M4 copywriter、Web 素材工坊+项目详情）。

## 技术栈
Node 20 + TypeScript + pnpm monorepo；SQLite(better-sqlite3)；Hono；Vite + React + Tailwind；Playwright（封面截图）；vitest。

## 快速开始
```bash
corepack enable && corepack use pnpm@9.15.0
pnpm install
pnpm --filter @forgecast/copywriter exec playwright install chromium  # 封面渲染依赖
cp .env.example .env    # 默认 mock 模式，无需任何 key
pnpm dev                # API :4321 + Web :5173
```
打开 http://localhost:5173 → 素材工坊 → 选 demo-project → 生成。

## 环境变量（.env）
| 变量 | 说明 |
|---|---|
| FORGECAST_LLM_MODE | `mock`（默认，无 key 演示）/ `live`（走中转站真实生成） |
| FORGECAST_LLM_BASE_URL | OpenAI 兼容中转地址，默认 aitoken.homes/v1 |
| FORGECAST_LLM_KEY | live 模式必填 |
| FORGECAST_MODEL_ANALYSIS / COPY / SCORING | 各环节模型 id |

## CLI
```bash
pnpm exec tsx cli.ts copy <slug> --hook=pain|sideline|infogap|story [--n=N]
```

## 目录结构
- `packages/core` 配置/SQLite/LLM client；`packages/copywriter` M4 文案与封面；`packages/server` 本地 API
- `apps/web` Web 控制台；`templates/` 提示词与封面模板（核心资产）；`workspace/<slug>/` 每项目产物

## Docker（可选）
```bash
DOCKER_BUILDKIT=0 docker compose build   # 本机路径含中文，必须禁 BuildKit
docker compose up -d
```

## 路线图
见 `开源变现内容工厂-开发文档.md` §10：接下来是 M5 视频（Remotion）、M2 分析、M1 抓取、M6 日历复盘。
```

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml README.md && git commit -m "chore: Docker Compose 骨架（renderer 占位）+ README"
```

---

## 自查记录

- **Spec 覆盖**：设计文档 §4.1-4.7 逐条对应 Task 4 / 3 / 7+10+11 / 9-11 / 13-15 / 12 / 17；§5 模板资产对应 Task 6+8；§6 测试策略贯穿各任务；验收标准对应 Task 16。设计文档中「FTS top-8」在 Task 6 收敛为 LIKE 实现（接口不变），已在任务内注明理由。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`CoreCtx`/`HookType`/`GenerateCopyInput`/`TaskQueue`/`createApp(ctx, queue)` 等签名跨任务核对一致；Task 9 单参 `createApp(ctx)` 在 Task 10 明确升级为双参并同步改测试。
