import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx, app: ReturnType<typeof createApp>, root: string
let queue: ReturnType<typeof createTaskQueue>

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)) }
async function runTask(taskId: string) {
  for (let i = 0; i < 200; i++) {
    await wait(20)
    const t = queue.get(taskId)!
    if (t.status === 'done') return
    if (t.status === 'failed') throw new Error(t.events.at(-1)!.message)
  }
  throw new Error('任务超时')
}

const layer = (over: Partial<{ id: string; start: number; duration: number; track: number }> = {}) => ({
  id: over.id ?? 'l1', kind: 'text', from: null, overridden: false,
  start: over.start ?? 0, duration: over.duration ?? 3, track: over.track ?? 1,
  content: { kind: 'text', text: 'hi' }, style: {}, effects: [],
})

const validSpec = (videoId = 'deadbeef01') => ({
  version: 1, videoId, slug: 's1', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [] },
  canvas: { width: 1080, height: 1920 }, durationSec: 12,
  layers: [layer()],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-spec-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('s1')").run()
  queue = createTaskQueue()
  app = createApp(ctx, queue)
})

function specPath(videoId: string) {
  return path.join(root, 'workspace/s1/specs', `${videoId}.json`)
}
function origPath(videoId: string) {
  return path.join(root, 'workspace/s1/specs', `${videoId}.orig.json`)
}

describe('spec 读写端点', () => {
  it('GET 不存在 → 404', async () => {
    const res = await app.request('/api/projects/s1/specs/deadbeef01')
    expect(res.status).toBe(404)
  })

  it('GET 读盘上 spec', async () => {
    fs.mkdirSync(path.dirname(specPath('deadbeef01')), { recursive: true })
    fs.writeFileSync(specPath('deadbeef01'), JSON.stringify(validSpec()))
    const res = await app.request('/api/projects/s1/specs/deadbeef01')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.videoId).toBe('deadbeef01')
    // 没写过 .orig.json → hasOrig false，剪辑台据此**进场即隐藏**「重置为生成结果」
    expect(body.hasOrig).toBe(false)
  })

  it('GET 带 hasOrig：有 .orig.json 快照时为 true', async () => {
    fs.mkdirSync(path.dirname(specPath('deadbeef01')), { recursive: true })
    fs.writeFileSync(specPath('deadbeef01'), JSON.stringify(validSpec()))
    fs.writeFileSync(origPath('deadbeef01'), JSON.stringify(validSpec()))
    const body = await (await app.request('/api/projects/s1/specs/deadbeef01')).json() as any
    expect(body.hasOrig).toBe(true)
  })

  it('PUT 合法 spec → 200 且文件内容更新', async () => {
    fs.mkdirSync(path.dirname(specPath('deadbeef01')), { recursive: true })
    fs.writeFileSync(specPath('deadbeef01'), JSON.stringify(validSpec()))
    const updated = { ...validSpec(), durationSec: 20 }
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updated),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as any).ok).toBe(true)
    const onDisk = JSON.parse(fs.readFileSync(specPath('deadbeef01'), 'utf8'))
    expect(onDisk.durationSec).toBe(20)
  })

  it('PUT 同 track 重叠 → 400 提到 track', async () => {
    const bad = { ...validSpec(), layers: [layer({ id: 'l1', start: 0, duration: 5, track: 1 }), layer({ id: 'l2', start: 3, duration: 5, track: 1 })] }
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toMatch(/track/)
  })

  it('PUT 同 track 首尾相接（不重叠）→ 200（防将来 < 手滑改成 <= 把合法排布误杀）', async () => {
    const ok = { ...validSpec(), layers: [layer({ id: 'l1', start: 0, duration: 5, track: 1 }), layer({ id: 'l2', start: 5, duration: 3, track: 1 })] }
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ok),
    })
    expect(res.status).toBe(200)
  })

  it('PUT version !== 1 → 400', async () => {
    const bad = { ...validSpec(), version: 2 }
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad),
    })
    expect(res.status).toBe(400)
  })

  it('PUT layers 缺字段 → 400', async () => {
    const bad = { ...validSpec(), layers: [{ id: 'l1', kind: 'text' }] }
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad),
    })
    expect(res.status).toBe(400)
  })

  it('PUT start<0 或 duration<=0 → 400', async () => {
    const bad1 = { ...validSpec(), layers: [layer({ start: -1 })] }
    expect((await app.request('/api/projects/s1/specs/deadbeef01', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad1) })).status).toBe(400)
    const bad2 = { ...validSpec(), layers: [layer({ duration: 0 })] }
    expect((await app.request('/api/projects/s1/specs/deadbeef01', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad2) })).status).toBe(400)
  })

  it('videoId 带 ../ 编码 → 400，不触盘', async () => {
    const res = await app.request('/api/projects/s1/specs/' + encodeURIComponent('../x'))
    expect(res.status).toBe(400)
    // 不触盘：不应该在 workspace 之外产生任何文件（无法穷举，退化为确认没有抛出 500 / 未创建 s1 目录之外的东西）
    expect(fs.existsSync(path.join(root, 'workspace/x.json'))).toBe(false)
  })

  it('PUT 的 videoId 与路径不一致 → 400', async () => {
    const mismatched = validSpec('other-id')
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mismatched),
    })
    expect(res.status).toBe(400)
  })
})

describe('reset 端点', () => {
  it('有 orig → 还原并返回', async () => {
    fs.mkdirSync(path.dirname(specPath('deadbeef01')), { recursive: true })
    const orig = validSpec()
    fs.writeFileSync(origPath('deadbeef01'), JSON.stringify(orig))
    fs.writeFileSync(specPath('deadbeef01'), JSON.stringify({ ...orig, durationSec: 999 }))
    const res = await app.request('/api/projects/s1/specs/deadbeef01/reset', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.durationSec).toBe(12)
    const onDisk = JSON.parse(fs.readFileSync(specPath('deadbeef01'), 'utf8'))
    expect(onDisk.durationSec).toBe(12)
  })

  it('无 orig → 404 带说明', async () => {
    fs.mkdirSync(path.dirname(specPath('deadbeef01')), { recursive: true })
    fs.writeFileSync(specPath('deadbeef01'), JSON.stringify(validSpec()))
    const res = await app.request('/api/projects/s1/specs/deadbeef01/reset', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.error).toMatch(/无生成快照/)
  })
})

describe('render 端点（剪辑台渲成片）', () => {
  /** 重渲复用首次生成留下的 hf 素材目录，测试里手工摆一个空目录即可（stub 渲染不读内容）。 */
  function seedSpecAndHf(videoId: string, over: Record<string, unknown> = {}) {
    fs.mkdirSync(path.dirname(specPath(videoId)), { recursive: true })
    fs.writeFileSync(specPath(videoId), JSON.stringify({ ...validSpec(videoId), ...over }))
    fs.mkdirSync(path.join(root, 'workspace/s1/hf', videoId), { recursive: true })
  }

  it('videoId 非法 → 400', async () => {
    const res = await app.request('/api/projects/s1/specs/' + encodeURIComponent('../x') + '/render', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('项目不存在 → 404', async () => {
    const res = await app.request('/api/projects/nope/specs/deadbeef01/render', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('spec 不存在 → 404', async () => {
    const res = await app.request('/api/projects/s1/specs/deadbeef01/render', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('POST render → {taskId}，任务完成后多一条 video 行（stub）', async () => {
    seedSpecAndHf('deadbeef01')
    const res = await app.request('/api/projects/s1/specs/deadbeef01/render', { method: 'POST' })
    expect(res.status).toBe(200)
    const { taskId } = await res.json() as any
    expect(typeof taskId).toBe('string')
    await runTask(taskId)
    const rows = ctx.db.prepare("SELECT * FROM assets WHERE type = 'video'").all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].spec_path).toBe(path.join('s1', 'specs', 'deadbeef01.json'))
  })

  it('任务 meta 带 kind/slug/sourceAssetId（P0「渲染中」派生靠它）', async () => {
    seedSpecAndHf('deadbeef02', { semantic: { hook: null, sourceAssetId: 7, sections: [] } })
    const res = await app.request('/api/projects/s1/specs/deadbeef02/render', { method: 'POST' })
    const { taskId } = await res.json() as any
    expect(queue.get(taskId)!.meta).toEqual({ kind: 'video', slug: 's1', sourceAssetId: 7 })
    await runTask(taskId)
  })

  it('自定义模板（custom-*）→ 400，文案指向「换模板」', async () => {
    seedSpecAndHf('deadbeef03', { template: 'custom-1', layers: [] })
    const res = await app.request('/api/projects/s1/specs/deadbeef03/render', { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toBe('自定义模板暂不支持从剪辑台重渲')
  })

  it('普通模板但 layers 被删空 → 400，文案指向「加回图层」（与 custom 分开）', async () => {
    seedSpecAndHf('deadbeef04', { layers: [] })
    const res = await app.request('/api/projects/s1/specs/deadbeef04/render', { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toBe('图层为空，无可渲染内容')
  })
})

describe('rewrite-section 端点', () => {
  function rewritableSpec(videoId: string, over: Record<string, unknown> = {}) {
    return {
      ...validSpec(videoId),
      semantic: {
        hook: null, sourceAssetId: null,
        sections: [{ id: 'sec-hook', role: 'hook', text: '原文案' }, { id: 'sec-other', role: 'body', text: '别的段' }],
      },
      // 目标层 l1 + 一个 from 指向别的 section 的图层 l2，用来证明「其他图层不受影响」
      layers: [
        { ...layer({ id: 'l1' }), from: 'sec-hook', content: { kind: 'text', text: '原文案' } },
        { ...layer({ id: 'l2', start: 5, duration: 4, track: 2 }), from: 'sec-other', content: { kind: 'text', text: '别的图层文案' } },
      ],
      ...over,
    }
  }
  function seed(videoId: string, over: Record<string, unknown> = {}) {
    fs.mkdirSync(path.dirname(specPath(videoId)), { recursive: true })
    fs.writeFileSync(specPath(videoId), JSON.stringify(rewritableSpec(videoId, over)))
  }

  it('videoId 非法 → 400', async () => {
    const res = await app.request('/api/projects/s1/specs/' + encodeURIComponent('../x') + '/rewrite-section', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sectionId: 'sec-hook' }),
    })
    expect(res.status).toBe(400)
  })

  it('项目不存在 → 404', async () => {
    const res = await app.request('/api/projects/nope/specs/deadbeef01/rewrite-section', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sectionId: 'sec-hook' }),
    })
    expect(res.status).toBe(404)
  })

  it('spec 不存在 → 404', async () => {
    const res = await app.request('/api/projects/s1/specs/deadbeef01/rewrite-section', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sectionId: 'sec-hook' }),
    })
    expect(res.status).toBe(404)
  })

  it('成功 → 200，落盘更新 spec.warnings 与图层 text', async () => {
    seed('deadbeef01')
    const res = await app.request('/api/projects/s1/specs/deadbeef01/rewrite-section', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sectionId: 'sec-hook' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.newText).toBe('原文案（重写版）')
    expect(body.spec.semantic.sections[0].text).toBe('原文案（重写版）')
    const onDisk = JSON.parse(fs.readFileSync(specPath('deadbeef01'), 'utf8'))
    expect(onDisk.layers[0].content.text).toBe('原文案（重写版）')
    expect(onDisk.warnings).toContain('「sec-hook」已重写，旁白仍为旧文案，语音与画面文案可能不一致')
    // 关键不变量：非目标图层（l2）与非目标 section（sec-other）完全不受影响
    const seeded = rewritableSpec('deadbeef01')
    expect(onDisk.layers.find((l: any) => l.id === 'l2')).toEqual(seeded.layers.find((l: any) => l.id === 'l2'))
    expect(onDisk.semantic.sections.find((s: any) => s.id === 'sec-other').text).toBe('别的段')
  })

  it('目标图层 overridden 且无 force → 409 带 affected', async () => {
    seed('deadbeef01', { layers: [{ ...layer({ id: 'l1' }), from: 'sec-hook', overridden: true, content: { kind: 'text', text: '原文案' } }] })
    const res = await app.request('/api/projects/s1/specs/deadbeef01/rewrite-section', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sectionId: 'sec-hook' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as any
    expect(body.error).toBe('该段有手工改动')
    expect(body.affected).toEqual(['l1'])
  })

  it('目标图层 overridden 但带 force → 通过并落盘', async () => {
    seed('deadbeef01', { layers: [{ ...layer({ id: 'l1' }), from: 'sec-hook', overridden: true, content: { kind: 'text', text: '原文案' } }] })
    const res = await app.request('/api/projects/s1/specs/deadbeef01/rewrite-section', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sectionId: 'sec-hook', force: true }),
    })
    expect(res.status).toBe(200)
    const onDisk = JSON.parse(fs.readFileSync(specPath('deadbeef01'), 'utf8'))
    expect(onDisk.layers[0].content.text).toBe('原文案（重写版）')
    expect(onDisk.layers[0].overridden).toBe(true)
  })

  it('不支持的段（dialogue）→ 400', async () => {
    seed('deadbeef01', {
      semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-d', role: 'body', dialogue: [{ who: 'them', text: 'hi' }] }] },
      layers: [{ ...layer({ id: 'l1' }), from: 'sec-d', content: { kind: 'text', text: 'x' } }],
    })
    const res = await app.request('/api/projects/s1/specs/deadbeef01/rewrite-section', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sectionId: 'sec-d' }),
    })
    expect(res.status).toBe(400)
  })
})
