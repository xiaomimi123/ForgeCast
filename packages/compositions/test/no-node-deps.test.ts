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

  it('src 下没有任何 Node 内置模块导入', () => {
    const bad: string[] = []
    for (const f of files) {
      const s = readFileSync(f, 'utf-8')
      if (/from\s+['"](node:|fs|path|child_process|os|crypto)['"]/.test(s)) bad.push(f)
    }
    expect(bad).toEqual([])
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
