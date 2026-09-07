import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `src/brand-kit.ts` 被 apps/web 深导入（`@forgecast/studio/src/brand-kit`，见
 * EditorPage.tsx 注释）——绕开包入口是为了不把 @remotion/renderer、better-sqlite3 这些
 * Node 侧依赖拖进浏览器包。这条测试守的就是这条绕开路径的前提：brand-kit.ts 自己不能再
 * 悄悄长出 node: 内置模块 / fs / path 之类的导入，否则同样的问题会从后门溜回来。
 * 形态照抄 packages/editing/test/no-node-deps.test.ts，范围收窄到这一个文件。
 */
describe('brand-kit.ts 零 Node 依赖（apps/web 深导入的前提）', () => {
  const testFilePath = fileURLToPath(import.meta.url)
  const filePath = join(dirname(testFilePath), '..', 'src', 'brand-kit.ts')

  const BUILTIN = String.raw`node:[a-z_/]+|fs|path|child_process|os|crypto|stream|url|util|buffer|process|worker_threads|zlib|net|http|https`
  const PATTERNS = [
    new RegExp(String.raw`(?:from|import)\s*\(?\s*['"](?:${BUILTIN})['"]`),
    new RegExp(String.raw`import\s*\(\s*['"](?:${BUILTIN})['"]`),
    new RegExp(String.raw`require\s*\(\s*['"](?:${BUILTIN})['"]`),
  ]

  it('brand-kit.ts 没有任何 Node 内置模块导入（静态 / 动态 import / require）', () => {
    const s = readFileSync(filePath, 'utf-8')
    const bad = PATTERNS.some((re) => re.test(s))
    expect(bad).toBe(false)
  })
})
