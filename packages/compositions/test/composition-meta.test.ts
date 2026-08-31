/**
 * Remotion 装配链的轻量守卫。
 *
 * 背景：本包的组件测试全部 `vi.mock('remotion')`，于是 Root.tsx / entry.ts / composition id /
 * calculateMetadata 这一段**零覆盖**——把 id 改掉、durationInFrames 算错，全仓测试照样全绿，
 * 只有真渲几分钟后炸在 selectComposition 或产出错时长的成片。composition.ts 不 import remotion，
 * 所以这条断言可以脱开 mock 直接跑真值。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPOSITION_ID, specMetadata } from '../src/composition'
import { FPS } from '../src/time'
import type { VideoSpec } from '../src/videospec-types'
import flash from './fixtures/flash.json'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

describe('composition 装配', () => {
  it('Root.tsx 用的正是导出的 COMPOSITION_ID（不再是手抄字面量）', () => {
    const root = readFileSync(join(srcDir, 'Root.tsx'), 'utf-8')
    expect(root).toContain('id={COMPOSITION_ID}')
    expect(root).not.toMatch(/id="\w+"/)
  })

  it('entry.ts 仍调用 registerRoot——删掉它 bundle 里就没有任何 composition', () => {
    expect(readFileSync(join(srcDir, 'entry.ts'), 'utf-8')).toContain('registerRoot(RemotionRoot)')
  })

  it('specMetadata 用真 spec 算出正确的时长/画幅/fps', () => {
    const spec = flash as VideoSpec
    const m = specMetadata(spec)
    expect(m.fps).toBe(30)
    expect(m.width).toBe(spec.canvas.width)
    expect(m.height).toBe(spec.canvas.height)
    expect(m.durationInFrames).toBe(Math.round(spec.durationSec * FPS))
    expect(m.durationInFrames).toBeGreaterThan(0)
  })

  it('COMPOSITION_ID 是非空字符串', () => {
    expect(COMPOSITION_ID).toBe('spec')
  })
})
