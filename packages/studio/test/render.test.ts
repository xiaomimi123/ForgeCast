import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderVideo } from '../src/render'

describe('renderVideo stub', () => {
  it('写出非空占位文件（不加载 remotion）', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-r-')), 'a.mp4')
    await renderVideo('entry', 'Flash', { painTitle: 'x', sellingPoint: 'y', cta: 'z', brandName: 'b' }, out, 'stub')
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.statSync(out).size).toBeGreaterThan(0)
  })
})
