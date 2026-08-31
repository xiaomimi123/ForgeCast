import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SpecView } from '../src/SpecView'
import type { Layer, VideoSpec } from '../src/videospec-types'

// 本包 vitest.config.ts 关闭了 globals，@testing-library/react 的自动 afterEach
// 清理钩子不会被注入，多个 render() 会在 document.body 里累积——这里用 getByTestId
// 查询整个 baseElement（不像其余测试用 container.querySelector 局部查询），
// 必须显式 cleanup() 才能让三条 it 互不干扰。
afterEach(cleanup)

vi.mock('remotion', () => ({
  Video: (p: Record<string, unknown>) => <video data-testid="rv" src={p.src as string} muted={p.muted as boolean} />,
  useCurrentFrame: () => 0,
  useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 360 }),
}))

const spec = (layers: Layer[]): VideoSpec => ({
  version: 1, videoId: 'v', slug: 's', template: 'flash', createdAt: '',
  semantic: { hook: null, sourceAssetId: null, sections: [] },
  canvas: { width: 1080, height: 1920 }, durationSec: 10, layers,
  audio: { narration: null, bgm: null, beatGrid: null, captionsEnabled: false }, warnings: [],
})

describe('video 图层', () => {
  it('渲出 Remotion <Video> 并透传 src / muted', () => {
    const { getByTestId } = render(<SpecView spec={spec([{
      id: 'bg', kind: 'video', from: null, overridden: false, start: 0, duration: 10, track: 0,
      content: { kind: 'video', src: 'clip.mp4', muted: true }, style: {}, effects: [],
    }])} timeSec={1} />)
    const v = getByTestId('rv') as HTMLVideoElement
    expect(v.getAttribute('src')).toBe('clip.mp4')
    expect(v.muted).toBe(true)
  })

  it('文字图层能叠在视频图层之上（合成能力成立）', () => {
    const { container } = render(<SpecView spec={spec([
      { id: 'bg', kind: 'video', from: null, overridden: false, start: 0, duration: 10, track: 0,
        content: { kind: 'video', src: 'clip.mp4', muted: true }, style: {}, effects: [] },
      { id: 'title', kind: 'text', from: null, overridden: false, start: 0, duration: 10, track: 5,
        content: { kind: 'text', text: '动态标题' }, style: {}, effects: [] },
    ])} timeSec={1} />)
    const bg = container.querySelector('#bg') as HTMLElement
    const title = container.querySelector('#title') as HTMLElement
    expect(title.textContent).toContain('动态标题')
    expect(Number(title.style.zIndex)).toBeGreaterThan(Number(bg.style.zIndex))
  })

  it('视频路径同样逐段编码', () => {
    const { getByTestId } = render(<SpecView spec={spec([{
      id: 'bg', kind: 'video', from: null, overridden: false, start: 0, duration: 10, track: 0,
      content: { kind: 'video', src: 'my clip#1.mp4', muted: false }, style: {}, effects: [],
    }])} timeSec={1} />)
    expect((getByTestId('rv') as HTMLVideoElement).getAttribute('src')).toBe('my%20clip%231.mp4')
  })
})
