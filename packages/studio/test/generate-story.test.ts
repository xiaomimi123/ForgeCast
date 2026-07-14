import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyFixtures, createLlmClient, loadConfig, openDb, type CoreCtx } from '@forgecast/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { generateVideo } from '../src/generate'

let ctx: CoreCtx
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-story-'))
  const config = loadConfig(root, { FORGECAST_VIDEO_MODE: 'stub' }) // tts 默认 stub
  ctx = { db: openDb(config.paths.db), config, llm: createLlmClient(config.llm) }
  ctx.db.prepare("INSERT INTO projects (slug, brand_name) VALUES ('demo', '快客通')").run()
  const cd = path.join(root, 'workspace/demo/copy'); fs.mkdirSync(cd, { recursive: true })
  fs.writeFileSync(path.join(cd, 'story-1.md'), copyFixtures.story)
  ctx.db.prepare("INSERT INTO assets (project_id, type, hook, file_path) VALUES (1, 'copy', 'story', 'demo/copy/story-1.md')").run()
})

describe('generateVideo tpl=story (stub)', () => {
  it('产出 wav + props.json(含 cues/audioSrc) + 占位 mp4 + video 素材', async () => {
    const out = await generateVideo(ctx, { slug: 'demo', tpl: 'story' })
    const abs = path.join(ctx.config.paths.workspace, out.filePath)
    expect(fs.existsSync(abs)).toBe(true)
    const props = JSON.parse(fs.readFileSync(abs.replace(/\.mp4$/, '.props.json'), 'utf8'))
    expect(Array.isArray(props.bubbles)).toBe(true)
    expect(Array.isArray(props.cues)).toBe(true)
    expect(typeof props.audioSrc).toBe('string')
    const wavAbs = path.join(ctx.config.paths.workspace, props.audioSrc)
    expect(fs.existsSync(wavAbs)).toBe(true)
    const row: any = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(out.assetId)
    expect(row.type).toBe('video')
  })
})
