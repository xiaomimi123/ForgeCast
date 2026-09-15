import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createTaskQueue } from '../src/tasks'

let ctx: CoreCtx
let app: ReturnType<typeof createApp>
let ws: string
const VIDEO_ID = '11111111-2222-3333-4444-555555555555'

/** 素材包现场：只建目录，**不**登记 assets 行——端点靠 slug 定项目、videoId 只定目录，
 *  素材包在渲染登记之前就已存在（管线先 scaffold、后 INSERT），加图层不该等成片行落库。 */
function seedVideo(slug: string, videoId = VIDEO_ID): void {
  fs.mkdirSync(path.join(ws, slug, 'hf', videoId, 'assets'), { recursive: true })
}

async function uploadImage(slug: string, name: string, type = 'image/png', body = 'fake-bytes'): Promise<Response> {
  const fd = new FormData()
  fd.append('file', new File([body], name, { type }))
  return app.request(`/api/projects/${slug}/upload-image`, { method: 'POST', body: fd })
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-media-'))
  const config = loadConfig(root, {})
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ws = config.paths.workspace
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('demo')").run()
  ctx.db.prepare("INSERT INTO projects (slug) VALUES ('other')").run()
  app = createApp(ctx, createTaskQueue())
})

describe('POST /api/projects/:slug/upload-image', () => {
  it('png 上传 → 200，落盘 + 登记 image/upload 素材行', async () => {
    const res = await uploadImage('demo', 'logo.png')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.filePath).toBe(path.join('demo', 'uploads', 'logo.png'))
    expect(fs.existsSync(path.join(ws, body.filePath))).toBe(true)
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(body.id)
    expect(row.type).toBe('image')
    expect(row.origin).toBe('upload')
  })

  it('svg / webp / jpg 也放行', async () => {
    expect((await uploadImage('demo', 'a.svg', 'image/svg+xml')).status).toBe(200)
    expect((await uploadImage('demo', 'b.webp', 'image/webp')).status).toBe(200)
    expect((await uploadImage('demo', 'c.jpg', 'image/jpeg')).status).toBe(200)
  })

  it('非白名单扩展名 → 400，不落盘不落库', async () => {
    const res = await uploadImage('demo', 'evil.exe', 'application/octet-stream')
    expect(res.status).toBe(400)
    expect(fs.existsSync(path.join(ws, 'demo', 'uploads', 'evil.exe'))).toBe(false)
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM assets WHERE type='image'").get()).toEqual({ n: 0 })
  })

  it('扩展名合法但 MIME 不在白名单 → 400', async () => {
    expect((await uploadImage('demo', 'a.png', 'text/html')).status).toBe(400)
  })

  it('超过 10MB → 400', async () => {
    const big = 'x'.repeat(10 * 1024 * 1024 + 1)
    expect((await uploadImage('demo', 'big.png', 'image/png', big)).status).toBe(400)
  })

  it('同名不覆盖旧文件（加时间戳前缀）', async () => {
    const a = await (await uploadImage('demo', 'logo.png')).json() as any
    const b = await (await uploadImage('demo', 'logo.png')).json() as any
    expect(b.filePath).not.toBe(a.filePath)
    expect(fs.existsSync(path.join(ws, a.filePath))).toBe(true)
    expect(fs.existsSync(path.join(ws, b.filePath))).toBe(true)
  })

  it('项目不存在 → 404；缺 file 字段 → 400', async () => {
    expect((await uploadImage('nope', 'a.png')).status).toBe(404)
    const res = await app.request('/api/projects/demo/upload-image', { method: 'POST', body: new FormData() })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/projects/:slug/image-assets', () => {
  it('列本项目 upload 图片 + demo 截图，跨项目不串', async () => {
    await uploadImage('demo', 'logo.png')
    await uploadImage('other', 'their.png')
    fs.mkdirSync(path.join(ws, 'demo', 'shots'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'demo', 'shots', 'dash.png'), 'x')
    const list = await (await app.request('/api/projects/demo/image-assets')).json() as any[]
    expect(list.filter((x) => x.kind === 'upload').map((x) => x.name)).toEqual(['logo.png'])
    const shot = list.find((x) => x.kind === 'shot')
    expect(shot).toMatchObject({ kind: 'shot', name: 'dash.png', path: path.join('shots', 'dash.png') })
    expect(shot.id).toBeUndefined()
  })

  it('项目不存在 → 404；空项目 → 空数组', async () => {
    expect((await app.request('/api/projects/nope/image-assets')).status).toBe(404)
    expect(await (await app.request('/api/projects/demo/image-assets')).json()).toEqual([])
  })
})

describe('POST /api/projects/:slug/videos/:videoId/media-asset', () => {
  const post = (videoId: string, body: unknown, slug = 'demo') => app.request(`/api/projects/${slug}/videos/${videoId}/media-asset`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  it('assetId → 拷进素材包 assets/media/，返回相对 src', async () => {
    seedVideo('demo')
    const up = await (await uploadImage('demo', 'logo.png', 'image/png', 'PNGDATA')).json() as any
    const res = await post(VIDEO_ID, { assetId: up.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ src: 'assets/media/logo.png' })
    const dest = path.join(ws, 'demo', 'hf', VIDEO_ID, 'assets', 'media', 'logo.png')
    expect(fs.readFileSync(dest, 'utf8')).toBe('PNGDATA')
  })

  it('重名加 -1 后缀，不覆盖已在包里的同名素材', async () => {
    seedVideo('demo')
    const a = await (await uploadImage('demo', 'logo.png', 'image/png', 'AAA')).json() as any
    expect((await (await post(VIDEO_ID, { assetId: a.id })).json() as any).src).toBe('assets/media/logo.png')
    expect((await (await post(VIDEO_ID, { assetId: a.id })).json() as any).src).toBe('assets/media/logo-1.png')
    expect((await (await post(VIDEO_ID, { assetId: a.id })).json() as any).src).toBe('assets/media/logo-2.png')
    const mediaDir = path.join(ws, 'demo', 'hf', VIDEO_ID, 'assets', 'media')
    expect(fs.readdirSync(mediaDir).sort()).toEqual(['logo-1.png', 'logo-2.png', 'logo.png'])
  })

  it('shotPath → 从项目截图目录拷进包', async () => {
    seedVideo('demo')
    fs.mkdirSync(path.join(ws, 'demo', 'shots'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'demo', 'shots', 'dash.png'), 'SHOT')
    const res = await post(VIDEO_ID, { shotPath: 'shots/dash.png' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ src: 'assets/media/dash.png' })
    expect(fs.readFileSync(path.join(ws, 'demo', 'hf', VIDEO_ID, 'assets', 'media', 'dash.png'), 'utf8')).toBe('SHOT')
  })

  it('跨项目素材 → 400，且不落地任何文件', async () => {
    seedVideo('demo')
    const up = await (await uploadImage('other', 'their.png')).json() as any
    const res = await post(VIDEO_ID, { assetId: up.id })
    expect(res.status).toBe(400)
    expect(fs.existsSync(path.join(ws, 'demo', 'hf', VIDEO_ID, 'assets', 'media'))).toBe(false)
  })

  it('assetId 不存在 → 404；不是图片素材（video 行）→ 404', async () => {
    seedVideo('demo')
    expect((await post(VIDEO_ID, { assetId: 99999 })).status).toBe(404)
    const info = ctx.db.prepare(
      "INSERT INTO assets (project_id, type, file_path, origin) VALUES (1, 'video', 'demo/uploads/a.mp4', 'upload')",
    ).run()
    expect((await post(VIDEO_ID, { assetId: Number(info.lastInsertRowid) })).status).toBe(404)
  })

  it('assetId 与 shotPath 二选一：都不给 / 都给 → 400', async () => {
    seedVideo('demo')
    expect((await post(VIDEO_ID, {})).status).toBe(400)
    expect((await post(VIDEO_ID, { assetId: 1, shotPath: 'shots/a.png' })).status).toBe(400)
  })

  it('项目不存在 → 404；videoId 非法 → 400；素材包不存在 → 404', async () => {
    seedVideo('demo')
    expect((await post(VIDEO_ID, { shotPath: 'shots/a.png' }, 'nope')).status).toBe(404)
    expect((await post('zz!!', { shotPath: 'shots/a.png' })).status).toBe(400)
    expect((await post('deadbeef-dead-dead-dead-deaddeaddead', { shotPath: 'shots/a.png' })).status).toBe(404)
  })

  it('slug 与素材不匹配：拿 other 的素材包路径 + demo 的素材 → 404（other 没这个包）', async () => {
    seedVideo('demo')
    const up = await (await uploadImage('demo', 'logo.png')).json() as any
    // 同一个 videoId 挂到别的项目下：包在 demo/hf 里，other/hf 里没有 → 404，绝不越项目取包
    expect((await post(VIDEO_ID, { assetId: up.id }, 'other')).status).toBe(404)
    // 反向：包对了但素材是 other 的 → 400（授权），且不落地文件
    const theirs = await (await uploadImage('other', 'their.png')).json() as any
    expect((await post(VIDEO_ID, { assetId: theirs.id })).status).toBe(400)
    expect(fs.existsSync(path.join(ws, 'demo', 'hf', VIDEO_ID, 'assets', 'media'))).toBe(false)
  })

  describe('shotPath 路径穿越防护', () => {
    const attacks = [
      '../other/shots/x.png',
      'shots/../../secret.txt',
      '/etc/passwd',
      'shots/./../../secret.txt',
      '..\\..\\secret.png',   // Windows 分隔符：POSIX 下会被当成合法文件名混过 resolve 前缀检查
      'shots/sub/../../../secret.png',
    ]
    for (const p of attacks) {
      it(`拒绝 ${p} → 400`, async () => {
        seedVideo('demo')
        fs.writeFileSync(path.join(ws, 'secret.txt'), 'TOP SECRET')
        const res = await post(VIDEO_ID, { shotPath: p })
        expect(res.status).toBe(400)
        expect(fs.existsSync(path.join(ws, 'demo', 'hf', VIDEO_ID, 'assets', 'media'))).toBe(false)
      })
    }
    it('项目内的软链指向项目外 → 400（resolve 不解析软链，只有 realpath 拦得住）', async () => {
      seedVideo('demo')
      const outside = path.join(ws, 'secret.png')
      fs.writeFileSync(outside, 'TOP SECRET')
      fs.mkdirSync(path.join(ws, 'demo', 'shots'), { recursive: true })
      fs.symlinkSync(outside, path.join(ws, 'demo', 'shots', 'evil.png'))
      const res = await post(VIDEO_ID, { shotPath: 'shots/evil.png' })
      expect(res.status).toBe(400)
      expect(fs.existsSync(path.join(ws, 'demo', 'hf', VIDEO_ID, 'assets', 'media'))).toBe(false)
    })

    it('项目内但文件不存在 → 404', async () => {
      seedVideo('demo')
      expect((await post(VIDEO_ID, { shotPath: 'shots/nope.png' })).status).toBe(404)
    })
  })
})

describe('brand-kit logoAssetId', () => {
  const putKit = (slug: string, kit: unknown) => app.request(`/api/projects/${slug}/brand-kit`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(kit),
  })

  it('本项目 upload 图片 → 200，GET 原样回', async () => {
    const up = await (await uploadImage('demo', 'logo.png')).json() as any
    expect((await putKit('demo', { logoAssetId: up.id, primaryColor: '#112233' })).status).toBe(200)
    expect(await (await app.request('/api/projects/demo/brand-kit')).json())
      .toEqual({ logoAssetId: up.id, primaryColor: '#112233' })
  })

  it('跨项目素材 → 400', async () => {
    const up = await (await uploadImage('other', 'their.png')).json() as any
    expect((await putKit('demo', { logoAssetId: up.id })).status).toBe(400)
  })

  it('不存在 / 非图片 / 非数字 → 400', async () => {
    expect((await putKit('demo', { logoAssetId: 99999 })).status).toBe(400)
    ctx.db.prepare("INSERT INTO assets (project_id, type, file_path, origin) VALUES (1, 'video', 'demo/uploads/a.mp4', 'upload')").run()
    const vid: any = ctx.db.prepare("SELECT id FROM assets WHERE type='video'").get()
    expect((await putKit('demo', { logoAssetId: vid.id })).status).toBe(400)
    expect((await putKit('demo', { logoAssetId: 'abc' })).status).toBe(400)
  })

  it('不给 logoAssetId 的 kit 照旧通过（零回归）', async () => {
    expect((await putKit('demo', { primaryColor: '#ffffff' })).status).toBe(200)
  })
})
