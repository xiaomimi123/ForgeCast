import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Root.tsx 注册的 composition id 由 compositions 包**单一导出**，不再两处手抄字面量。
// 深导入 src/composition 而非包入口：入口 index.ts 带六份 CSS 的副作用导入，Node 里 import 会炸。
import { COMPOSITION_ID } from '@forgecast/compositions/src/composition'
import type { VideoSpec } from './videospec'

const STUB_BYTES = Buffer.from('FORGECAST_STUB_MP4\n')
/** 与 hyperframes.ts 同值：Docker/低配机渲染慢，FORGECAST_RENDER_TIMEOUT_MS 可加大。 */
const RENDER_TIMEOUT_MS = 600_000
const COMPOSITIONS_SRC = fileURLToPath(new URL('../../compositions/src', import.meta.url))
/** compositions 包的 Remotion 入口（registerRoot 在那里调）。 */
const ENTRY_POINT = path.join(COMPOSITIONS_SRC, 'entry.ts')


/** 已打好的 bundle：**键含 publicDir**——每条视频的 publicDir 不同，只按源码指纹缓存会让
 *  第二条视频拿到第一条的资源目录（截图/旁白串台）。值里再存指纹，改了组件源码就重打。
 *
 *  据实说明：hfDir 里含独立 videoId，所以**每条视频的 publicDir 都不同 → 这个缓存今天实际
 *  从不命中**，省不到 webpack 冷启的时间。它现在真正起作用的只有淘汰侧（见 resolveServeUrl
 *  的 evictBundle）：bundle() 的 outDir 在 os.tmpdir() 且 publicDir 是整目录复制，不删的话
 *  每条视频都在 /tmp 留一份「截图+旁白 wav+webpack 产物」的完整副本，小盘 VPS 几十条就
 *  no space left（renderHyperframes 时代不留任何 tmp）。让它真能命中（把 publicDir 从缓存键里
 *  拆出去、或改用 symlink 版 publicDir）是独立一项，已裁决延后。 */
const bundleCache = new Map<string, { fingerprint: string; serveUrl: string }>()

/** bundle 目录保留份数。取 2 而不是 1：留一份给「同 publicDir 重渲」的命中，再多就是纯占盘。 */
const MAX_CACHED_BUNDLES = 2

/** compositions 包源码指纹（相对路径 + mtimeMs + size，不读内容）：变了才重建 bundle——
 *  每条视频都 bundle 一次会显著拖慢（webpack 冷启数秒起）。 */
export function fingerprintCompositions(dir = COMPOSITIONS_SRC): string {
  const parts: string[] = []
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) walk(p)
      else parts.push(`${path.relative(dir, p)}:${st.mtimeMs}:${st.size}`)
    }
  }
  walk(dir)
  return parts.join('\n')
}

/**
 * 把 bundle 内的 public/ 顶层条目再软链到 bundle 根，让**根相对/裸相对**的资源路径也能解析。
 *
 * 背景：`bundle({ publicDir })` 把 publicDir 内容复制到 `<bundle>/public/`，`staticFile()` 因此
 * 解析成 `./public/xxx`；但 spec 里的图片/视频 src 是裸相对的 `assets/<rel>`（迁自 HyperFrames 模板，
 * 见 lower.ts），base.css 的 @font-face 又是根相对的 `/assets/fonts/…`——两者在渲染页面（`/index.html`）
 * 下都指向 `/assets/…`，不经过 `/public`。这里补一条 `<bundle>/assets → public/assets` 的**相对**软链，
 * 两种写法就都落回 publicDir 的同名目录。用相对软链而非绝对：Docker 挂载卷内绝对路径会失效。
 *
 * 只软链目录、且跳过与 bundle 产物同名的条目（index.html/bundle.js 等），不覆盖打包产物。
 * Remotion 的静态服务器对**最终路径**是软链的文件回 404（serve-handler 用 lstat），但路径中间的
 * 软链目录由内核解析、不受影响——所以链目录可以，链单个文件不行。
 */
export function linkPublicDirToBundleRoot(bundleDir: string): void {
  const pub = path.join(bundleDir, 'public')
  if (!fs.existsSync(pub)) return
  const failed: string[] = []
  for (const name of fs.readdirSync(pub)) {
    const dst = path.join(bundleDir, name)
    if (!fs.statSync(path.join(pub, name)).isDirectory()) continue
    if (fs.lstatSync(dst, { throwIfNoEntry: false })) continue
    try { fs.symlinkSync(path.join('public', name), dst, 'dir') } catch { /* 下面统一校验 */ }
    // **必须校验**：链不上就退回 /public 语义，所有图片/字体 404，渲出的是「缺图但零报错」
    // 的成片——本仓库最忌的失败形状。宁可在这里炸，也不要让静默坏片流到成品目录。
    if (!fs.existsSync(dst)) failed.push(name)
  }
  if (failed.length) {
    throw new Error(`Remotion 打包目录软链失败（${failed.join(', ')}）：静态资源将全部 404，`
      + '已中止渲染以免产出缺图但零报错的成片。检查 bundle 目录所在文件系统是否支持软链。')
  }
}

/**
 * 取一个可用的 bundle serveUrl：命中（同 publicDir + 同指纹）就复用，否则 `build()` 重打。
 * 抽出来是为了让缓存键与淘汰能被单测直接钉住（真 bundle 太慢，测试注入假 build）。
 *
 * 淘汰：超过 MAX_CACHED_BUNDLES 就删最早的一条，并**连同磁盘目录一起删**——只删 Map 不删盘
 * 等于换个地方泄漏。只删 os.tmpdir() 下的目录（bundle() 的默认落点），避免误删调用方指定的路径。
 */
export async function resolveServeUrl(
  publicDir: string, fingerprint: string, build: () => Promise<string>,
): Promise<string> {
  const hit = bundleCache.get(publicDir)
  if (hit && hit.fingerprint === fingerprint) return hit.serveUrl
  if (hit) evictBundle(publicDir)
  const serveUrl = await build()
  bundleCache.set(publicDir, { fingerprint, serveUrl })
  while (bundleCache.size > MAX_CACHED_BUNDLES) evictBundle(bundleCache.keys().next().value as string)
  return serveUrl
}

function evictBundle(key: string): void {
  const gone = bundleCache.get(key)
  bundleCache.delete(key)
  if (!gone) return
  const dir = path.resolve(gone.serveUrl)
  if (!dir.startsWith(path.resolve(os.tmpdir()) + path.sep)) return
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 删不掉只是占盘，不该炸渲染 */ }
}

/**
 * 把 `spec.audio.narration.src` 归一化成 **publicDir 相对**路径：spec 里存的是 workspace 相对
 * （`<slug>/hf/<videoId>/assets/narration.wav`，见 tts.ts 的 path.relative(workspace, …)），
 * 而 publicDir 是 hf 项目目录，图层里的图片 src 又是 hf 相对（`assets/<rel>`）——两套基准。
 * 裁决：**在这里适配**，不动 videospec.ts schema、不动 lower()（①② 共用层，动它会波及等价门禁）。
 * 做法：从左往右逐段剥前缀，取第一个在 publicDir 下真实存在的后缀；找不到返回 null（不挂音轨）。
 */
export function narrationSrcForPublicDir(src: string, publicDir: string): string | null {
  const segs = src.split(/[\\/]+/).filter(Boolean)
  for (let i = 0; i < segs.length; i++) {
    const rel = segs.slice(i).join('/')
    if (fs.existsSync(path.join(publicDir, rel))) return rel
  }
  return null
}

/** 构造传给 Remotion 的 inputProps：只改 narration.src 的基准，其余原样（spec 不可变，浅拷贝）。 */
export function buildInputProps(
  spec: VideoSpec, publicDir: string, bgVariant?: string,
): { spec: VideoSpec; bgVariant?: string } {
  const narration = spec.audio.narration
  if (!narration) return { spec, bgVariant }
  const rel = narrationSrcForPublicDir(narration.src, publicDir)
  return {
    spec: { ...spec, audio: { ...spec.audio, narration: rel ? { ...narration, src: rel } : null } },
    bgVariant,
  }
}

/**
 * 用 Remotion 渲染一条 VideoSpec。
 * - `mode === 'stub'`：写占位字节后立刻返回，**不 bundle、不起浏览器**（测试与 stub 流程走这条）。
 * - `publicDir`：静态资源（截图、旁白 wav、字体）目录。**只有 `bundle()` 收这个参数，`renderMedia()` 不收**——
 *   资源只能在打包时暴露，运行期没有第二次机会（①里翻过一次车）。
 * - `bgVariant`：科技背景变体，由调用方用 `resolveTechBg` 解析**一次**后传入；组件内绝不随机，
 *   否则逐帧结果不同、渲染必然闪烁。
 * - 超时：`FORGECAST_RENDER_TIMEOUT_MS`（默认 10 分钟），到点用 cancelSignal 掐掉渲染再抛错。
 */
export async function renderRemotion(
  spec: VideoSpec, outAbs: string,
  opts: { mode: 'render' | 'stub'; publicDir: string; bgVariant?: string; onProgress?: (m: string) => void; timeoutMs?: number },
): Promise<void> {
  fs.mkdirSync(path.dirname(outAbs), { recursive: true })
  if (opts.mode === 'stub') { fs.writeFileSync(outAbs, STUB_BYTES); return }

  // 动态 import：stub 路径（含全部单测）不该为了 @remotion/renderer 去解压/查找浏览器
  const { bundle } = await import('@remotion/bundler')
  const { makeCancelSignal, renderMedia, selectComposition } = await import('@remotion/renderer')

  const publicDir = path.resolve(opts.publicDir)
  const serveUrl = await resolveServeUrl(publicDir, fingerprintCompositions(), async () => {
    opts.onProgress?.('打包合成…')
    const dir = await bundle({ entryPoint: ENTRY_POINT, publicDir })
    linkPublicDirToBundleRoot(dir)
    return dir
  })

  const inputProps = buildInputProps(spec, publicDir, opts.bgVariant)
  if (spec.audio.narration && !inputProps.spec.audio.narration) {
    // 静默丢音轨 = 成片只剩 BGM 没人声且零报错，必须让它出现在 warnings 里
    const msg = `旁白音轨未在渲染目录内找到（${spec.audio.narration.src}），成片将没有人声`
    opts.onProgress?.(`⚠ ${msg}`)
    spec.warnings.push(msg)
  }
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps })
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.FORGECAST_RENDER_TIMEOUT_MS) || RENDER_TIMEOUT_MS)
  const { cancelSignal, cancel } = makeCancelSignal()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; cancel() }, timeoutMs)
  try {
    await renderMedia({
      composition, serveUrl, codec: 'h264', outputLocation: outAbs, inputProps, cancelSignal,
      onProgress: ({ progress }) => opts.onProgress?.(`渲染 ${Math.round(progress * 100)}%`),
    })
  } catch (e) {
    if (timedOut) throw new Error(`Remotion 渲染超时（${timeoutMs}ms），可调大 FORGECAST_RENDER_TIMEOUT_MS`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}
