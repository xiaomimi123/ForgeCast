import fs from 'node:fs'
import path from 'node:path'

const STUB_BYTES = Buffer.from('FORGECAST_STUB_MP4\n')

/** flash 渲染：stub 写占位文件；render 用 Remotion 真渲。@remotion/* 动态加载（stub/测试不触及）。 */
export async function renderFlash(
  entry: string,
  inputProps: Record<string, unknown>,
  outPath: string,
  mode: 'render' | 'stub',
  opts: { onProgress?: (m: string) => void } = {},
): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  if (mode === 'stub') {
    fs.writeFileSync(outPath, STUB_BYTES)
    return
  }
  const { bundle } = await import('@remotion/bundler')
  const { selectComposition, renderMedia } = await import('@remotion/renderer')
  const serveUrl = await bundle({ entryPoint: entry })
  const composition = await selectComposition({ serveUrl, id: 'Flash', inputProps })
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outPath,
    inputProps,
    onProgress: ({ progress }) => opts.onProgress?.(`渲染 ${Math.round(progress * 100)}%…`),
  })
}
