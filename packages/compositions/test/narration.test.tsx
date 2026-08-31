import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SpecComposition } from '../src/SpecComposition'
import type { AudioSpec, VideoSpec } from '../src/videospec-types'

afterEach(cleanup)

// SpecComposition 会用 useCurrentFrame/useVideoConfig，纯 React 测试里没有 Remotion 上下文，
// 故整包 mock；<Audio> 换成可查询的 <audio data-testid>。
vi.mock('remotion', () => ({
  Audio: (p: Record<string, unknown>) => <audio data-testid="narration" src={p.src as string} />,
  Video: (p: Record<string, unknown>) => <video src={p.src as string} />,
  useCurrentFrame: () => 0,
  useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 360 }),
}))

const spec = (audio: AudioSpec): VideoSpec => ({
  version: 1, videoId: 'v', slug: 's', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [] },
  canvas: { width: 1080, height: 1920 }, durationSec: 10,
  layers: [{
    id: 't', kind: 'text', from: null, overridden: false, start: 0, duration: 10, track: 1,
    content: { kind: 'text', text: '标题' }, style: {}, effects: [],
  }],
  audio, warnings: [],
})

const NO_AUDIO: AudioSpec = { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }

describe('旁白音轨（设计稿 §5）', () => {
  it('spec 有 narration → 合成里有 <Audio>，src 原样（已由调用方归一化成 publicDir 相对）', () => {
    const { getByTestId } = render(<SpecComposition
      spec={spec({ ...NO_AUDIO, narration: { src: 'assets/narration.wav', degraded: null } })} />)
    expect(getByTestId('narration').getAttribute('src')).toBe('assets/narration.wav')
  })

  it('src 含空格/#/? 等字符 → 逐段编码（与图片同一套编码，整串 encodeURIComponent 会拆掉子目录）', () => {
    const { getByTestId } = render(<SpecComposition
      spec={spec({ ...NO_AUDIO, narration: { src: 'a b/n#1.wav', degraded: null } })} />)
    expect(getByTestId('narration').getAttribute('src')).toBe('a%20b/n%231.wav')
  })

  it('spec 无 narration → 合成里没有 <Audio>（不能凭空造一条音轨）', () => {
    const { queryByTestId } = render(<SpecComposition spec={spec(NO_AUDIO)} />)
    expect(queryByTestId('narration')).toBeNull()
  })

  it('画面照常渲出（加音轨不影响图层）', () => {
    const { baseElement } = render(<SpecComposition
      spec={spec({ ...NO_AUDIO, narration: { src: 'assets/narration.wav', degraded: null } })} />)
    expect(baseElement.textContent).toContain('标题')
  })
})
