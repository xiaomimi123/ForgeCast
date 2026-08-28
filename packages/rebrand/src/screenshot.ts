/** 对 http://127.0.0.1:<port> 截图存到 outPath。跟 packages/copywriter/src/cover.ts 同样的 chromium.launch() 用法。 */
export async function captureScreenshot(port: number, outPath: string): Promise<boolean> {
  const { chromium } = await import('playwright')
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'load', timeout: 15000 })
    await page.screenshot({ path: outPath })
    return true
  } catch {
    return false
  } finally {
    if (browser) await browser.close()
  }
}
