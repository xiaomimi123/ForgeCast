import fs from 'node:fs'
import path from 'node:path'

const STUB_BYTES = Buffer.from('FORGECAST_STUB_MP4\n')

/** 渲染视频：stub 写占位；render 用 Remotion 真渲（compositionId 选模板）。@remotion/* 动态加载。
 *  publicDir：Story/Demo 里 <Audio>/<OffthreadVideo> 用 staticFile() 引用的相对路径（如 "chatwoot/videos/x.wav"）
 *  按此目录解析——bundle() 会把该目录内容复制/软链到打包产物的静态根下供渲染时加载。 */
export async function renderVideo(
  entry: string,
  compositionId: string,
  inputProps: Record<string, unknown>,
  outPath: string,
  mode: 'render' | 'stub',
  opts: { onProgress?: (m: string) => void; publicDir?: string } = {},
): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  if (mode === 'stub') { fs.writeFileSync(outPath, STUB_BYTES); return }
  const { bundle } = await import('@remotion/bundler')
  const { selectComposition, renderMedia } = await import('@remotion/renderer')
  const serveUrl = await bundle({ entryPoint: entry, publicDir: opts.publicDir ?? null })
  const composition = await selectComposition({ serveUrl, id: compositionId, inputProps })
  await renderMedia({
    composition, serveUrl, codec: 'h264', outputLocation: outPath, inputProps,
    onProgress: ({ progress }) => opts.onProgress?.(`渲染 ${Math.round(progress * 100)}%…`),
  })
}
