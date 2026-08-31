import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildInputProps, fingerprintCompositions, linkPublicDirToBundleRoot,
  narrationSrcForPublicDir, renderRemotion, resolveServeUrl,
} from '../src/remotion-render'
import { resolveBgVariant } from '../src/generate'
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

describe('bgVariant 取值规则（表驱动——同类回归本仓已出过 4 次）', () => {
  // rand 固定成 0 → TECH_BGS[0] === 'grid'，random/auto 的结果可断言
  const rand = (): number => 0
  const cases: Array<[string, string | undefined, string | undefined]> = [
    ['story', 'grid', undefined],       // story 一律不加背景（保聊天截图观感）
    ['story', 'random', undefined],
    ['story', undefined, undefined],
    ['flash', 'grid', 'grid'],          // 具名变体原样透传
    ['demo', 'matrix', 'matrix'],
    ['insight', 'random', 'grid'],      // random/auto 解析成具体一套
    ['changelog', 'auto', 'grid'],
    ['flash', 'none', 'none'],          // none/空 → Background 渲空
    ['flash', '', 'none'],
    ['flash', undefined, 'none'],
    ['custom-7', 'grid', 'grid'],       // 自定义模板不走这条路，但规则本身不特判
  ]
  for (const [tpl, bg, want] of cases) {
    it(`${tpl} + bg=${String(bg)} → ${String(want)}`, () => {
      expect(resolveBgVariant(tpl, bg, rand)).toBe(want)
    })
  }

  it('解析一次即定：同一次调用的结果被 HTML 与 Remotion 共用，不各随机各的', () => {
    // 连续两次 random 用不同 rand 会给出不同值——正说明调用方必须只调一次并复用
    expect(resolveBgVariant('flash', 'random', () => 0)).toBe('grid')
    expect(resolveBgVariant('flash', 'random', () => 0.99)).toBe('mesh')
  })
})

describe('bundle 缓存键与淘汰', () => {
  it('指纹随文件 mtime/新增文件变化，同内容不变则稳定', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-'))
    mkdirSync(join(dir, 'styles'))
    writeFileSync(join(dir, 'styles', 'base.css'), 'a{}')
    const a = fingerprintCompositions(dir)
    expect(fingerprintCompositions(dir)).toBe(a)
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'styles', 'base.css'), past, past)
    const b = fingerprintCompositions(dir)
    expect(b).not.toBe(a)                       // 改 css（含 mtime）必须让 bundle 重打
    writeFileSync(join(dir, 'entry.ts'), 'x')
    expect(fingerprintCompositions(dir)).not.toBe(b)  // 新增入口文件也要被看见
  })

  it('同 publicDir 同指纹 → 复用；指纹变 → 重打；换 publicDir → 不复用（否则第二条视频拿到第一条的资源）', async () => {
    let built = 0
    const build = async (): Promise<string> => `${join(tmpdir(), 'bundle-')}${++built}`
    const a = mkdtempSync(join(tmpdir(), 'pd-a-'))
    const b = mkdtempSync(join(tmpdir(), 'pd-b-'))
    expect(await resolveServeUrl(a, 'fp1', build)).toBe(await resolveServeUrl(a, 'fp1', build))
    expect(built).toBe(1)
    await resolveServeUrl(a, 'fp2', build)
    expect(built).toBe(2)                       // 指纹变了必须重打
    await resolveServeUrl(b, 'fp2', build)
    expect(built).toBe(3)                       // 换 publicDir 不许复用
  })

  it('淘汰时把磁盘上的 bundle 目录一起删掉（只删 tmp 下的），否则每条视频泄漏一份完整副本', async () => {
    const dirs: string[] = []
    const build = async (): Promise<string> => {
      const d = mkdtempSync(join(tmpdir(), 'remotion-webpack-bundle-'))
      writeFileSync(join(d, 'index.html'), 'x')
      dirs.push(d)
      return d
    }
    const keys = [0, 1, 2, 3].map(() => mkdtempSync(join(tmpdir(), 'pd-')))
    for (const k of keys) await resolveServeUrl(k, 'fp', build)
    expect(dirs).toHaveLength(4)
    expect(dirs.slice(0, 2).map((d) => existsSync(d))).toEqual([false, false])  // 最早两份已删
    expect(dirs.slice(2).map((d) => existsSync(d))).toEqual([true, true])       // 保留 MAX_CACHED_BUNDLES=2
  })
})

describe('旁白 src 归一化（spec 存 workspace 相对，publicDir 是 hf 目录）', () => {
  const withNarration = (src: string): VideoSpec =>
    ({ ...spec, audio: { ...spec.audio, narration: { src, degraded: null } } })

  it('剥掉 workspace 前缀，取在 publicDir 下真实存在的后缀', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nar-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'narration.wav'), 'RIFF')
    expect(narrationSrcForPublicDir('slug/hf/v1/assets/narration.wav', dir)).toBe('assets/narration.wav')
    expect(narrationSrcForPublicDir('assets/narration.wav', dir)).toBe('assets/narration.wav')
  })

  // 这条启发式唯一的判据就是「长的优先」：多个后缀同时存在时必须取**更深**那个。
  // 反过来（从短后缀开始试）在其余用例下全绿，却会把音轨指到同名的浅层文件——
  // 又是一条「渲得出来但声音不对且零报错」，故单独钉死。
  it('多个后缀都存在时取更深的那个（最长后缀优先，不是最短）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nar-'))
    mkdirSync(join(dir, 'v1', 'assets'), { recursive: true })
    writeFileSync(join(dir, 'narration.wav'), 'RIFF-浅')
    writeFileSync(join(dir, 'v1', 'assets', 'narration.wav'), 'RIFF-深')
    expect(narrationSrcForPublicDir('slug/hf/v1/assets/narration.wav', dir)).toBe('v1/assets/narration.wav')
  })

  it('文件不在 publicDir 下 → null（不挂一条必然 404 的音轨）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nar-'))
    expect(narrationSrcForPublicDir('slug/hf/v1/assets/narration.wav', dir)).toBeNull()
  })

  it('buildInputProps 只改 narration.src，不动原 spec，也不动 schema 其他字段', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nar-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'narration.wav'), 'RIFF')
    const src = 's/hf/v1/assets/narration.wav'
    const original = withNarration(src)
    const props = buildInputProps(original, dir, 'grid')
    expect(props.spec.audio.narration).toEqual({ src: 'assets/narration.wav', degraded: null })
    expect(props.bgVariant).toBe('grid')
    expect(props.spec.layers).toBe(original.layers)
    expect(original.audio.narration!.src).toBe(src)   // 入参 spec 不被就地改写
  })

  it('找不到音频 → narration 置 null（组件据此不挂 <Audio>）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nar-'))
    expect(buildInputProps(withNarration('s/hf/v1/assets/narration.wav'), dir).spec.audio.narration).toBeNull()
  })

  it('无 narration 的 spec 原样透传', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nar-'))
    expect(buildInputProps(spec, dir).spec).toBe(spec)
  })
})

describe('bundle 根软链', () => {
  it('把 public/ 下的目录软链回 bundle 根（裸相对与根相对的资源路径都靠它）', () => {
    const bundleDir = mkdtempSync(join(tmpdir(), 'bd-'))
    mkdirSync(join(bundleDir, 'public', 'assets', 'fonts'), { recursive: true })
    writeFileSync(join(bundleDir, 'public', 'assets', 'fonts', 'f.otf'), 'x')
    writeFileSync(join(bundleDir, 'index.html'), 'x')
    linkPublicDirToBundleRoot(bundleDir)
    expect(existsSync(join(bundleDir, 'assets', 'fonts', 'f.otf'))).toBe(true)
  })

  it('没有 public/ 目录时不炸（publicDir 为空的场景）', () => {
    const bundleDir = mkdtempSync(join(tmpdir(), 'bd-'))
    expect(() => linkPublicDirToBundleRoot(bundleDir)).not.toThrow()
  })
})
