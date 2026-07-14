import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { generateVideo } from '../src/generate'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-demo-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
  const cd = path.join(root, 'workspace/demo/copy'); fs.mkdirSync(cd, { recursive: true })
  fs.writeFileSync(path.join(cd, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
})

describe('generateVideo tpl=demo (stub)', () => {
  it('无录屏：demoVideoSrc undefined，仍产 props+占位mp4+video 素材', async () => {
    const out = await generateVideo(ctx, { slug: 'demo', tpl: 'demo' })
    const abs = path.join(ctx.config.paths.workspace, out.filePath)
    expect(fs.existsSync(abs)).toBe(true)
    const props = JSON.parse(fs.readFileSync(abs.replace(/\.mp4$/, '.props.json'), 'utf8'))
    expect(Array.isArray(props.painPoints)).toBe(true)
    expect(props.demoVideoSrc).toBeUndefined()
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.type).toBe('video')
  })
  it('有 raw 录屏：demoVideoSrc 指向该文件（相对）', async () => {
    const rawDir = path.join(root, 'workspace/demo/raw'); fs.mkdirSync(rawDir, { recursive: true })
    fs.writeFileSync(path.join(rawDir, 'screen.mp4'), 'fake-video')
    const out = await generateVideo(ctx, { slug: 'demo', tpl: 'demo' })
    const props = JSON.parse(fs.readFileSync(path.join(ctx.config.paths.workspace, out.filePath).replace(/\.mp4$/, '.props.json'), 'utf8'))
    expect(props.demoVideoSrc).toBe(path.join('demo', 'raw', 'screen.mp4'))
  })
})
