import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let queue: ReturnType<typeof createTaskQueue>
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-vsrv-'))
  // TTS 也 stub：本套测的是 video API/队列/素材流程，非 TTS。默认 kokoro 会 spawn
  // `npx hyperframes tts`，失败降级要 ~2.8s（超过 runTask 的 2s 轮询窗），令测试超时假红。
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub', FORGECAST_TTS_MODE: 'stub' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  const copyDir = path.join(root, 'workspace/demo/copy')
  fs.mkdirSync(copyDir, { recursive: true })
  fs.writeFileSync(path.join(copyDir, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

/** hf 目录改按 videoId 分目录（`workspace/<slug>/hf/<videoId>/`），见 @forgecast/studio Task 5——
 *  测试里一次只生成一条视频，取该目录下唯一的子目录即可。 */
function hfIndexHtml(workspace: string, slug: string): string {
  const hfRoot = path.join(workspace, slug, 'hf')
  const [videoId] = fs.readdirSync(hfRoot)
  return fs.readFileSync(path.join(hfRoot, videoId, 'index.html'), 'utf8')
}

async function runTask(taskId: string) {
  for (let i = 0; i < 100; i++) {
    await wait(20)
    const s = queue.get(taskId)!.status
    if (s === 'done') return
    if (s === 'failed') throw new Error(queue.get(taskId)!.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

describe('video API (stub)', () => {
  it('POST video → 任务完成 → assets 出现 video 素材', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as any
    await runTask(taskId)
    const assets = await (await app.request('/api/projects/demo/assets')).json() as any[]
    expect(assets.some((a) => a.type === 'video')).toBe(true)
  })
  it('POST video {ratio:landscape} → 透传给 generateVideo，产出横屏 1920x1080 画布', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ratio: 'landscape' }),
    })).json() as any
    await runTask(taskId)
    const html = hfIndexHtml(ctx.config.paths.workspace, 'demo')
    expect(html).toContain('data-width="1920"')
    expect(html).toContain('data-height="1080"')
  })
  it('POST video 不传 ratio 或传非法值 → 回落竖屏', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ratio: 'square' }),
    })).json() as any
    await runTask(taskId)
    const html = hfIndexHtml(ctx.config.paths.workspace, 'demo')
    expect(html).toContain('data-width="1080"')
    expect(html).toContain('data-height="1920"')
  })
  it('POST video {tpl:story} → 任务完成 → video 素材', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tpl: 'story' }),
    })).json() as any
    await runTask(taskId)
    const assets = await (await app.request('/api/projects/demo/assets')).json() as any[]
    expect(assets.some((a) => a.type === 'video')).toBe(true)
  })
  it('POST video {tpl:demo} → 任务完成 → video 素材', async () => {
    // demo 模板需要 shots/：放一张最小竖图 PNG（IHDR 写 1080x1920）
    const shotsDir = path.join(ctx.config.paths.workspace, 'demo', 'shots')
    fs.mkdirSync(shotsDir, { recursive: true })
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const ihdr = Buffer.alloc(25); ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4); ihdr.writeUInt32BE(1080, 8); ihdr.writeUInt32BE(1920, 12)
    fs.writeFileSync(path.join(shotsDir, '01.png'), Buffer.concat([sig, ihdr]))
    const { taskId } = await (await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tpl: 'demo' }),
    })).json() as any
    await runTask(taskId)
    const assets = await (await app.request('/api/projects/demo/assets')).json() as any[]
    expect(assets.some((a) => a.type === 'video')).toBe(true)
  })
  it('POST video {tpl:insight} → 任务完成 → video 素材', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tpl: 'insight' }),
    })).json() as any
    await runTask(taskId)
    const assets = await (await app.request('/api/projects/demo/assets')).json() as any[]
    expect(assets.some((a) => a.type === 'video')).toBe(true)
  })
  it('未知项目 → 404', async () => {
    expect((await app.request('/api/projects/nope/video', { method: 'POST' })).status).toBe(404)
  })
  it('POST video 透传 bgm/mood/bg/captions → 不报错、正常出片', async () => {
    const { taskId } = await (await app.request('/api/projects/demo/video', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bgm: 'none', mood: 'tense', bg: 'aurora', captions: false }),
    })).json() as any
    await runTask(taskId)
    const assets = await (await app.request('/api/projects/demo/assets')).json() as any[]
    expect(assets.some((a) => a.type === 'video')).toBe(true)
  })
})

/** talk（口播合成）：body 必带 uploadAssetId，且必须指向本项目 origin='upload' 的视频素材。
 *  片源用 ffmpeg 现合的 2s 小 mp4（管线里要真跑 ffprobe 量时长）；ffmpeg 不在则跳过。 */
const HAS_FFMPEG = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
let sampleMp4 = ''
function makeUpload(): number {
  if (!sampleMp4) {
    sampleMp4 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-talk-src-')), 'src.mp4')
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-pix_fmt', 'yuv420p', sampleMp4], { stdio: 'ignore' })
  }
  const dir = path.join(ctx.config.paths.workspace, 'demo', 'uploads')
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(sampleMp4, path.join(dir, 'talk.mp4'))
  return Number(ctx.db.prepare(
    "INSERT INTO assets (project_id, type, hook, file_path, warnings, origin) VALUES (1, 'video', NULL, 'demo/uploads/talk.mp4', '[]', 'upload')",
  ).run().lastInsertRowid)
}
async function postVideo(body: any) {
  return app.request('/api/projects/demo/video', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('video API tpl=talk', () => {
  it('缺 uploadAssetId → 400', async () => {
    const res = await postVideo({ tpl: 'talk' })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toContain('口播素材')
  })
  it('uploadAssetId 指向文案素材 → 400', async () => {
    expect((await postVideo({ tpl: 'talk', uploadAssetId: 1 })).status).toBe(400)
  })
  it('uploadAssetId 指向 rendered 成片 → 400', async () => {
    const id = Number(ctx.db.prepare(
      "INSERT INTO assets (project_id, type, hook, file_path, warnings, origin) VALUES (1, 'video', NULL, 'demo/videos/x.mp4', '[]', 'rendered')",
    ).run().lastInsertRowid)
    expect((await postVideo({ tpl: 'talk', uploadAssetId: id })).status).toBe(400)
  })
  it.skipIf(!HAS_FFMPEG)('合法 → 入队并跑通，meta 为 {kind:video, slug, sourceAssetId: 文案 id}', async () => {
    const upId = makeUpload()
    const { taskId } = await (await postVideo({ tpl: 'talk', assetId: 1, uploadAssetId: upId })).json() as any
    expect(queue.get(taskId)!.meta).toEqual({ kind: 'video', slug: 'demo', sourceAssetId: 1 })
    await runTask(taskId)
    const assets = await (await app.request('/api/projects/demo/assets')).json() as any[]
    expect(assets.some((a) => a.type === 'video' && String(a.file_path).includes('/videos/talk-'))).toBe(true)
  })
})
