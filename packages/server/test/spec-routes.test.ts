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

  it('PUT 带未知顶层字段（如 hasOrig）→ 200，盘上剥除该字段', async () => {
    fs.mkdirSync(path.dirname(specPath('deadbeef01')), { recursive: true })
    fs.writeFileSync(specPath('deadbeef01'), JSON.stringify(validSpec()))
    // hasOrig 是 GET 响应的包装字段，不属于 VideoSpec——前端若忘了摘，PUT 回来会带上它。
    const withHasOrig = { ...validSpec(), hasOrig: true, someOtherUnknown: 'noise' }
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(withHasOrig),
    })
    expect(res.status).toBe(200)
    const onDisk = JSON.parse(fs.readFileSync(specPath('deadbeef01'), 'utf8'))
    expect(onDisk).not.toHaveProperty('hasOrig')
    expect(onDisk).not.toHaveProperty('someOtherUnknown')
  })

  it('PUT 已知字段全部保留（白名单不误删合法字段）', async () => {
    fs.mkdirSync(path.dirname(specPath('deadbeef01')), { recursive: true })
    fs.writeFileSync(specPath('deadbeef01'), JSON.stringify(validSpec()))
    const spec = validSpec()
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec),
    })
    expect(res.status).toBe(200)
    const onDisk = JSON.parse(fs.readFileSync(specPath('deadbeef01'), 'utf8'))
    expect(onDisk).toEqual(spec)
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

describe('pick-bgm 换曲 + 节拍重分析', () => {
  const BGM_REL = 'tense/a.mp3'
  function seedBgm() {
    fs.mkdirSync(path.join(root, 'templates/bgm/tense'), { recursive: true })
    fs.writeFileSync(path.join(root, 'templates/bgm/tense/a.mp3'), 'fake')
    return path.join(root, 'templates/bgm', BGM_REL)
  }
  /** analyzeBeats 先读 `<bgm>.beats.json` 缓存（见 hyperframes.ts）——测试就用它当成功替身，不 spawn python。 */
  function seedBeatCache(bgmAbs: string) {
    fs.writeFileSync(`${bgmAbs}.beats.json`, JSON.stringify({
      t0: 0.25, T: 0.5, bpm: 120, beats: [0.25, 0.75, 1.25], strongBeats: [0.25, 2.25], duration: 24,
    }))
  }
  function seedSpec(videoId: string, audio: Record<string, unknown>) {
    fs.mkdirSync(path.dirname(specPath(videoId)), { recursive: true })
    fs.writeFileSync(specPath(videoId), JSON.stringify({
      ...validSpec(videoId),
      audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false, ...audio },
    }))
  }
  const post = (body: unknown, videoId = 'deadbeef01') => app.request(`/api/projects/s1/specs/${videoId}/pick-bgm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  it('换曲成功：bgm 更新 + beatGrid 重分析 + manualBeats 保留', async () => {
    const abs = seedBgm(); seedBeatCache(abs)
    seedSpec('deadbeef01', { bgm: { src: '/old/x.mp3', mood: 'warm' }, beatGrid: { t0: 9, T: 9, bpm: 9, strongBeats: [9], manualBeats: [1.5, 3.25] } })
    const res = await post({ bgm: BGM_REL, mood: 'tense' })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.audio.bgm).toEqual({ src: abs, mood: 'tense' })
    expect(body.audio.beatGrid.bpm).toBe(120)
    expect(body.audio.beatGrid.t0).toBe(0.25)
    expect(body.audio.beatGrid.strongBeats).toEqual([0.25, 2.25])
    expect(body.audio.beatGrid.manualBeats).toEqual([1.5, 3.25]) // 手动卡点不被自动重分析覆盖
    const onDisk = JSON.parse(fs.readFileSync(specPath('deadbeef01'), 'utf8'))
    expect(onDisk.audio.beatGrid.manualBeats).toEqual([1.5, 3.25])
    expect(onDisk.audio.bgm.src).toBe(abs)
  })

  it('曲库为空 → 400', async () => {
    seedSpec('deadbeef01', {})
    const res = await post({ mood: 'tense' })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toContain('曲库')
  })

  it('bgm 路径穿越 → 400', async () => {
    seedBgm()
    seedSpec('deadbeef01', {})
    const res = await post({ bgm: '../../../etc/hosts' })
    expect(res.status).toBe(400)
  })

  it('节拍分析失败 → 仍换曲 + warning + manualBeats 保留（beatGrid 不整块置 null）', async () => {
    const abs = seedBgm() // 不写 .beats.json，beatPython 为空 → spawn 失败 → analyzeBeats 返 null
    seedSpec('deadbeef01', { beatGrid: { t0: 1, T: 0.5, bpm: 120, strongBeats: [1], manualBeats: [2.5] } })
    const res = await post({ bgm: BGM_REL })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.audio.bgm.src).toBe(abs) // 换曲照做
    expect(body.audio.beatGrid).toEqual({ t0: 0, T: 0, bpm: 0, strongBeats: [], manualBeats: [2.5] })
    expect(body.warnings).toContain('节拍分析失败，卡点吸附不可用')
  })

  it('节拍分析失败且原本无手动卡点 → beatGrid 置 null', async () => {
    seedBgm()
    seedSpec('deadbeef01', { beatGrid: { t0: 1, T: 0.5, bpm: 120, strongBeats: [1] } })
    const body = await (await post({ bgm: BGM_REL })).json() as any
    expect(body.audio.beatGrid).toBeNull()
  })

  it('spec 不存在 → 404；videoId 非法 → 400', async () => {
    expect((await post({ bgm: BGM_REL })).status).toBe(404)
    expect((await app.request(`/api/projects/s1/specs/${encodeURIComponent('../x')}/pick-bgm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status).toBe(400)
  })
})

describe('waveform 波形 peaks', () => {
  /**
   * 已知时长的 WAV：44 字节头 + 8kHz 单声道 16bit 的 10Hz 正弦，避免依赖任何外部素材。
   * ⚠️ 波形要 10Hz 这种**低频**：端点会把音频重采样到 200Hz，高频（如逐样本翻正负的
   * 4kHz 方波）会被抗混叠低通滤干净，读回来是一片近似静音，测不出振幅。
   */
  function writeWav(abs: string, seconds: number, amp = 16000) {
    const rate = 8000, n = rate * seconds
    const data = Buffer.alloc(n * 2)
    for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 10 * i) / rate)), i * 2)
    const head = Buffer.alloc(44)
    head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8)
    head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
    head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34)
    head.write('data', 36); head.writeUInt32LE(data.length, 40)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, Buffer.concat([head, data]))
    return abs
  }
  function seedSpecWithBgm(videoId: string, src: string | null) {
    fs.mkdirSync(path.dirname(specPath(videoId)), { recursive: true })
    fs.writeFileSync(specPath(videoId), JSON.stringify({
      ...validSpec(videoId),
      audio: { narration: null, bgm: src ? { src, mood: null } : null, beatGrid: null, captionsEnabled: false },
    }))
  }

  it('返回 ≤1000 个 0..1 的 peaks 与正确 durationSec', async () => {
    const wav = writeWav(path.join(root, 'templates/bgm/tone.wav'), 12)
    seedSpecWithBgm('deadbeef01', wav)
    const res = await app.request('/api/projects/s1/specs/deadbeef01/waveform')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(Array.isArray(body.peaks)).toBe(true)
    expect(body.peaks.length).toBeGreaterThan(0)
    expect(body.peaks.length).toBeLessThanOrEqual(1000)
    for (const p of body.peaks) expect(p).toBeGreaterThanOrEqual(0)
    for (const p of body.peaks) expect(p).toBeLessThanOrEqual(1)
    expect(Math.max(...body.peaks)).toBeGreaterThan(0.2) // 非静音，确实读到了样本
    expect(body.durationSec).toBeGreaterThan(11.5)
    expect(body.durationSec).toBeLessThan(12.5)
  })

  it('第二次命中缓存，结果一致', async () => {
    const wav = writeWav(path.join(root, 'templates/bgm/tone.wav'), 3)
    seedSpecWithBgm('deadbeef01', wav)
    const a = await (await app.request('/api/projects/s1/specs/deadbeef01/waveform')).json() as any
    const b = await (await app.request('/api/projects/s1/specs/deadbeef01/waveform')).json() as any
    expect(b).toEqual(a)
  })

  it('spec 无 bgm → 404', async () => {
    seedSpecWithBgm('deadbeef01', null)
    expect((await app.request('/api/projects/s1/specs/deadbeef01/waveform')).status).toBe(404)
  })

  it('bgm 文件缺失 → 404', async () => {
    seedSpecWithBgm('deadbeef01', path.join(root, 'templates/bgm/missing.wav'))
    expect((await app.request('/api/projects/s1/specs/deadbeef01/waveform')).status).toBe(404)
  })

  it('ffmpeg 解不开的文件（非零退出）→ 503', async () => {
    const bad = path.join(root, 'templates/bgm/bad.wav')
    fs.mkdirSync(path.dirname(bad), { recursive: true })
    fs.writeFileSync(bad, 'not audio at all')
    seedSpecWithBgm('deadbeef01', bad)
    const res = await app.request('/api/projects/s1/specs/deadbeef01/waveform')
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toContain('波形不可用')
  })

  it('bgm.src 落在 templates/workspace 之外（如 /etc/hosts）→ 400，不 spawn ffmpeg', async () => {
    seedSpecWithBgm('deadbeef01', '/etc/hosts')
    const res = await app.request('/api/projects/s1/specs/deadbeef01/waveform')
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toContain('路径非法')
  })

  it('bgm.src 用 ../ 试图逃出 templates 子树 → 400', async () => {
    // templates/bgm/../../../etc/hosts 解析出去就落在两棵子树之外
    const escaped = path.join(root, 'templates/bgm/../../../etc/hosts')
    seedSpecWithBgm('deadbeef01', escaped)
    const res = await app.request('/api/projects/s1/specs/deadbeef01/waveform')
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toContain('路径非法')
  })

  it('bgm.src 落在 workspace 子树内（非 templates）也放行——两棵子树都认', async () => {
    const wav = writeWav(path.join(root, 'workspace/s1/uploads/tone.wav'), 3)
    seedSpecWithBgm('deadbeef01', wav)
    const res = await app.request('/api/projects/s1/specs/deadbeef01/waveform')
    expect(res.status).toBe(200)
  })
})

describe('decodeMono 超时', () => {
  it('DECODE_TIMEOUT_MS 已接线为 30s', async () => {
    const { DECODE_TIMEOUT_MS } = await import('../src/spec-routes')
    expect(DECODE_TIMEOUT_MS).toBe(30_000)
  })

  it('ffmpeg 卡住不返回时，timeoutMs 到点 kill 子进程并 resolve(\'timeout\')', async () => {
    // 命名管道（FIFO）：open() 供 ffmpeg 读取会一直阻塞到有写端连上——我们不写，制造一次
    // 真实的「读不完」，而不是伪造。用极小的 timeoutMs（30ms）避免这条用例拖慢整个套件。
    const { execFileSync } = await import('node:child_process')
    const { decodeMono } = await import('../src/spec-routes')
    const fifo = path.join(root, 'stuck.fifo')
    execFileSync('mkfifo', [fifo])
    const start = Date.now()
    const result = await decodeMono(fifo, 30)
    expect(result).toBe('timeout')
    expect(Date.now() - start).toBeLessThan(5000) // 确实是超时触发的，不是巧合地跑完了
  })
})

describe('PUT 保留内层 manualBeats', () => {
  it('pickKnownSpecFields 只剥顶层，audio.beatGrid.manualBeats 原样过闸', async () => {
    const spec = {
      ...validSpec('deadbeef01'),
      audio: {
        narration: null, bgm: { src: '/x.mp3', mood: null },
        beatGrid: { t0: 0.5, T: 0.5, bpm: 120, strongBeats: [0.5], manualBeats: [1.25, 4.75] },
        captionsEnabled: false,
      },
    }
    const res = await app.request('/api/projects/s1/specs/deadbeef01', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec),
    })
    expect(res.status).toBe(200)
    const onDisk = JSON.parse(fs.readFileSync(specPath('deadbeef01'), 'utf8'))
    expect(onDisk.audio.beatGrid.manualBeats).toEqual([1.25, 4.75])
  })
})
