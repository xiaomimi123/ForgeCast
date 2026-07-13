import fs from 'node:fs'
import path from 'node:path'

export type CoverTemplate = 'bigtext' | 'annotate' | 'contrast'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 纯函数：模板填槽（可单测，与 Playwright 解耦） */
export function buildCoverHtml(templateHtml: string, slots: { main: string; sub: string }): string {
  return templateHtml.replaceAll('{{main}}', esc(slots.main)).replaceAll('{{sub}}', esc(slots.sub))
}

export interface RenderCoverInput {
  templatesDir: string
  template?: CoverTemplate
  main: string
  sub: string
  outPath: string
}

/** Playwright 截图 1242×1660（小红书 3:4）。调用方自行 try/catch——封面失败不应阻断文案。 */
export async function renderCover(i: RenderCoverInput): Promise<void> {
  const { chromium } = await import('playwright')
  const tpl = fs.readFileSync(path.join(i.templatesDir, 'covers', `${i.template ?? 'bigtext'}.html`), 'utf8')
  const html = buildCoverHtml(tpl, { main: i.main, sub: i.sub })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1242, height: 1660 } })
    await page.setContent(html, { waitUntil: 'load' })
    fs.mkdirSync(path.dirname(i.outPath), { recursive: true })
    await page.screenshot({ path: i.outPath })
  } finally {
    await browser.close()
  }
}
