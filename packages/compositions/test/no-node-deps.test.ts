import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : []
  })
}

describe('compositions 零 Node 依赖', () => {
  // 不用 `new URL('../src', import.meta.url)`——Vite 会静态识别这个字面量写法并把它
  // 当成资源 URL 改写，在 jsdom 环境下解析成 http://localhost:3000/src/index.ts 而不是
  // 真实文件路径。同时仓库目录名含中文，.pathname 是 percent-encoded 的，需要 fileURLToPath
  // 而不是 .pathname 来解码，否则 fs 直接 ENOENT。
  const testFilePath = fileURLToPath(import.meta.url)
  const files = walk(join(dirname(testFilePath), '..', 'src'))

  // 内置模块名。`node:` 前缀单独放开成 `node:<任意内置>`——旧版正则写的是 `node:|fs|...`，
  // 要求 `node:` 后面紧跟引号，于是 `import fs from 'node:fs'` 完全不匹配，守卫等于没有。
  const BUILTIN = String.raw`node:[a-z_/]+|fs|path|child_process|os|crypto|stream|url|util|buffer|process|worker_threads|zlib|net|http|https`
  const PATTERNS = [
    // 静态 import/export ... from 'x'  与  import 'x'
    new RegExp(String.raw`(?:from|import)\s*\(?\s*['"](?:${BUILTIN})['"]`),
    // 动态 import('x') / await import('x')
    new RegExp(String.raw`import\s*\(\s*['"](?:${BUILTIN})['"]`),
    // require('x')
    new RegExp(String.raw`require\s*\(\s*['"](?:${BUILTIN})['"]`),
  ]

  it('src 下没有任何 Node 内置模块导入（静态 / 动态 import / require）', () => {
    const bad: string[] = []
    for (const f of files) {
      const s = readFileSync(f, 'utf-8')
      if (PATTERNS.some((re) => re.test(s))) bad.push(f)
    }
    expect(bad).toEqual([])
  })

  // 这条守的是另一半：内置模块之外，任何**带 Node 依赖的第三方包**（better-sqlite3 之类）
  // 一旦成为 dependencies，值导入就会把它拖进浏览器包，而上面的内置模块正则看不见。
  // 白名单只留渲染必需的三个；新增依赖必须在这里显式过一遍人眼。
  it('package.json dependencies 只允许 react / react-dom / remotion', () => {
    const pkgPath = join(dirname(testFilePath), '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { dependencies?: Record<string, string> }
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['react', 'react-dom', 'remotion'])
  })

  it('对 @forgecast/studio 只能 import type，不得有值导入', () => {
    const bad: string[] = []
    for (const f of files) {
      for (const line of readFileSync(f, 'utf-8').split('\n')) {
        if (!line.includes('@forgecast/studio')) continue
        if (!/^\s*(import|export)\s+type\s/.test(line)) bad.push(`${f}: ${line.trim()}`)
      }
    }
    expect(bad).toEqual([])
  })
})
