import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VideoSpec } from './videospec'

const STUB_BYTES = Buffer.from('FORGECAST_STUB_MP4\n')
/** 与 hyperframes.ts 同值：Docker/低配机渲染慢，FORGECAST_RENDER_TIMEOUT_MS 可加大。 */
const RENDER_TIMEOUT_MS = 600_000
const COMPOSITIONS_SRC = fileURLToPath(new URL('../../compositions/src', import.meta.url))
/** compositions 包的 Remotion 入口（registerRoot 在那里调）。 */
const ENTRY_POINT = path.join(COMPOSITIONS_SRC, 'entry.ts')
/** Root.tsx 里注册的唯一 composition id；宽高/时长由 calculateMetadata 从 spec 算。 */
const COMPOSITION_ID = 'spec'

/** 已打好的 bundle：**键含 publicDir**——每条视频的 publicDir 不同，只按源码指纹缓存会让
 *  第二条视频拿到第一条的资源目录（截图/旁白串台）。值里再存指纹，改了组件源码就重打。 */
const bundleCache = new Map<string, { fingerprint: string; serveUrl: string }>()

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
  for (const name of fs.readdirSync(pub)) {
    const dst = path.join(bundleDir, name)
    if (!fs.statSync(path.join(pub, name)).isDirectory()) continue
    if (fs.lstatSync(dst, { throwIfNoEntry: false })) continue
    try { fs.symlinkSync(path.join('public', name), dst, 'dir') } catch { /* 链不上就退回 public/ 语义 */ }
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
  const fingerprint = fingerprintCompositions()
  const hit = bundleCache.get(publicDir)
  let serveUrl = hit && hit.fingerprint === fingerprint ? hit.serveUrl : null
  if (!serveUrl) {
    opts.onProgress?.('打包合成…')
    serveUrl = await bundle({ entryPoint: ENTRY_POINT, publicDir })
    linkPublicDirToBundleRoot(serveUrl)
    bundleCache.set(publicDir, { fingerprint, serveUrl })
  }

  const inputProps: Record<string, unknown> = { spec, bgVariant: opts.bgVariant }
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
