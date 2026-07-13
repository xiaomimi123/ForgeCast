import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { generateVideo } from '../src/generate'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-vid-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub' })
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
  const copyDir = path.join(root, 'workspace/demo/copy')
  fs.mkdirSync(copyDir, { recursive: true })
  fs.writeFileSync(path.join(copyDir, 'pain-1.md'), copyFixtures.pain)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'pain', 'demo/copy/pain-1.md')").run()
})

describe('generateVideo (stub)', () => {
  it('产出 props.json + 占位 mp4 + 登记 video 素材', async () => {
    const out = await generateVideo(ctx, { slug: 'demo', tpl: 'flash' })
    expect(out.filePath).toMatch(/demo\/videos\/.*\.mp4$/)
    const abs = path.join(ctx.config.paths.workspace, out.filePath)
    expect(fs.existsSync(abs)).toBe(true)
    const propsFile = abs.replace(/\.mp4$/, '.props.json')
    expect(fs.existsSync(propsFile)).toBe(true)
    const props = JSON.parse(fs.readFileSync(propsFile, 'utf8'))
    expect(props.painTitle.length).toBeGreaterThan(0)
    expect(props.brandName).toBe('快客通')
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.type).toBe('video')
    expect(row.file_path).toBe(out.filePath)
  })
  it('无 copy 素材 → 抛错', async () => {
    ctx.db.prepare("INSERT INTO projects (slug) VALUES ('empty')").run()
    await expect(generateVideo(ctx, { slug: 'empty' })).rejects.toThrow(/文案/)
  })
})
