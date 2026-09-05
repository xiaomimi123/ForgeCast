/**
 * 四份测试共用的 `remotion` 整包 mock。
 *
 * 为什么要 mock：`SpecComposition` / `LayerView` 用 `useCurrentFrame()`、`useVideoConfig()`，
 * `<Video>` 内部也依赖后者——这些 hook 只在 `<Composition>` 树内可用，纯 React 测试里渲染
 * 会直接抛错。默认实现只保证「能渲出可查询的 DOM 节点」，不模拟 remotion 自身的时间轴换算
 * （那是 video-layer.test.tsx 的活，它用 `extra` 覆盖 `Video`/`Sequence` 加 data-* 探针）。
 *
 * 用法（注意 vi.mock 会被提升到文件顶部，工厂里不能引用外部变量，只能动态 import）：
 *
 *   vi.mock('remotion', async () => (await import('./mocks/remotion')).makeRemotionMock())
 *   vi.mock('remotion', async () => (await import('./mocks/remotion')).makeRemotionMock({ Video: … }))
 */
type Props = Record<string, unknown>

/** `extra` 里的键覆盖同名默认导出，其余保持默认。 */
export function makeRemotionMock(extra: Record<string, unknown> = {}) {
  return {
    Audio: (p: Props) => <audio data-testid="narration" src={p.src as string} />,
    Video: (p: Props) => <video data-testid="rv" src={p.src as string} muted={p.muted as boolean} />,
    Sequence: (p: Props) => <>{p.children as React.ReactNode}</>,
    useCurrentFrame: () => 0,
    useVideoConfig: () => ({ fps: 30, width: 1080, height: 1920, durationInFrames: 360 }),
    ...extra,
  }
}
