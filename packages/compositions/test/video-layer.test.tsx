import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SpecView } from '../src/SpecView'
import { secToFrames } from '../src/time'
import type { Layer, VideoSpec } from '../src/videospec-types'

// 本包 vitest.config.ts 关闭了 globals，@testing-library/react 的自动 afterEach
// 清理钩子不会被注入，多个 render() 会在 document.body 里累积——这里用 getByTestId
// 查询整个 baseElement（不像其余测试用 container.querySelector 局部查询），
// 必须显式 cleanup() 才能让三条 it 互不干扰。
afterEach(cleanup)

// 共用默认 mock，另覆盖 Video/Sequence——本文件要靠 data-* 探针断言时间轴换算。
vi.mock('remotion', async () => (await import('./mocks/remotion')).makeRemotionMock({
  Video: (p: Record<string, unknown>) => (
    <video
      data-testid="rv"
      src={p.src as string}
      muted={p.muted as boolean}
      data-start-from={p.startFrom as number}
      data-end-at={p.endAt as number | undefined}
      data-volume={p.volume as number}
    />
  ),
  Sequence: (p: Record<string, unknown>) => (
    <div data-testid="seq" data-from={p.from as number} data-dif={p.durationInFrames as number}>
      {p.children as React.ReactNode}
    </div>
  ),
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

  it('视频图层包 <Sequence>：from/durationInFrames 来自 layer 时间', () => {
    const { getByTestId } = render(<SpecView spec={spec([{
      id: 'bg', kind: 'video', from: null, overridden: false, start: 3, duration: 4, track: 0,
      content: { kind: 'video', src: 'clip.mp4', muted: true }, style: {}, effects: [],
    }])} timeSec={3} />)
    const seq = getByTestId('seq') as HTMLElement
    expect(Number(seq.dataset.from)).toBe(secToFrames(3))
    expect(Number(seq.dataset.dif)).toBe(secToFrames(4))
  })

  it('trimStart/volume 透传 startFrom/volume；缺省 0/1', () => {
    const { getByTestId } = render(<SpecView spec={spec([{
      id: 'bg', kind: 'video', from: null, overridden: false, start: 0, duration: 10, track: 0,
      content: { kind: 'video', src: 'clip.mp4', muted: true, trimStart: 2.5, volume: 0.4 }, style: {}, effects: [],
    }])} timeSec={1} />)
    const v1 = getByTestId('rv') as HTMLVideoElement
    expect(Number(v1.dataset.startFrom)).toBe(secToFrames(2.5))
    expect(Number(v1.dataset.volume)).toBe(0.4)
    cleanup()
    const { getByTestId: getByTestId2 } = render(<SpecView spec={spec([{
      id: 'bg2', kind: 'video', from: null, overridden: false, start: 0, duration: 10, track: 0,
      content: { kind: 'video', src: 'clip.mp4', muted: true }, style: {}, effects: [],
    }])} timeSec={1} />)
    const v2 = getByTestId2('rv') as HTMLVideoElement
    expect(Number(v2.dataset.startFrom)).toBe(0)
    expect(Number(v2.dataset.volume)).toBe(1)
  })

  it('trimEnd 透传 endAt；缺省不传', () => {
    const { getByTestId } = render(<SpecView spec={spec([{
      id: 'bg', kind: 'video', from: null, overridden: false, start: 0, duration: 10, track: 0,
      content: { kind: 'video', src: 'clip.mp4', muted: true, trimEnd: 6 }, style: {}, effects: [],
    }])} timeSec={1} />)
    const v = getByTestId('rv') as HTMLVideoElement
    expect(Number(v.dataset.endAt)).toBe(secToFrames(6))
    cleanup()
    const { getByTestId: getByTestId2 } = render(<SpecView spec={spec([{
      id: 'bg2', kind: 'video', from: null, overridden: false, start: 0, duration: 10, track: 0,
      content: { kind: 'video', src: 'clip.mp4', muted: true }, style: {}, effects: [],
    }])} timeSec={1} />)
    const v2 = getByTestId2('rv') as HTMLVideoElement
    expect(v2.dataset.endAt).toBeUndefined()
  })

  // 这里只钉 `<Sequence from>` 的**透传值**（DOM 里读 data-from），不能证明浏览器真的从那个位置
  // 起播——那是 Remotion 运行期行为，单测的 Sequence 是个假组件。真实起播位置由子项目④ Task 8 的
  // 端到端真渲验收（裁头 2s 后成片 t=0 无红帧、蓝底秒数从 2 起）亲眼验过，证据见
  // `.superpowers/sdd/2026-09-06-talk-composite/task-8-report.md`。测试名照断言强度写，别再写成「债还清了」。
  it('Sequence.from 透传（真实起播位置由 Task 8 真渲验证）', () => {
    const { getByTestId } = render(<SpecView spec={spec([{
      id: 'bg', kind: 'video', from: null, overridden: false, start: 5, duration: 3, track: 0,
      content: { kind: 'video', src: 'clip.mp4', muted: true }, style: {}, effects: [],
    }])} timeSec={5} />)
    const seq = getByTestId('seq') as HTMLElement
    expect(Number(seq.dataset.from)).toBe(secToFrames(5))
    expect(Number(seq.dataset.from)).not.toBe(0)
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
