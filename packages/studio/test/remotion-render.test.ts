import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderRemotion } from '../src/remotion-render'
import type { VideoSpec } from '../src/videospec'

const spec: VideoSpec = {
  version: 1, videoId: 'v1', slug: 's', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [] },
  canvas: { width: 1080, height: 1920 }, durationSec: 12,
  layers: [{
    id: 'l1', kind: 'text', from: null, overridden: false, start: 0, duration: 3, track: 1,
    content: { kind: 'text', text: 'hi' }, style: {}, effects: [],
  }],
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
}

describe('renderRemotion', () => {
  it('stub 模式产出占位文件且不起浏览器', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-'))
    const out = join(dir, 'out.mp4')
    await renderRemotion(spec, out, { mode: 'stub', publicDir: dir })
    expect(existsSync(out)).toBe(true)
  })

  it('stub 模式不因缺少浏览器/资源而抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-'))
    await expect(
      renderRemotion(spec, join(dir, 'o.mp4'), { mode: 'stub', publicDir: dir }),
    ).resolves.not.toThrow()
  })
})
