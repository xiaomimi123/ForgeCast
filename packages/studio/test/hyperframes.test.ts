import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { escapeHtml, fillTemplate, renderHyperframes, scaffoldHfProject } from '../src/hyperframes'

describe('fillTemplate', () => {
  it('替换具名 slot 并转义用户数据', () => {
    const out = fillTemplate('<h1>{{title}}</h1>', { title: 'a<b>&"c' })
    expect(out).toBe('<h1>a&lt;b&gt;&amp;&quot;c</h1>')
  })
  it('未提供的 slot 替换为空串', () => {
    expect(fillTemplate('x{{y}}z', {})).toBe('xz')
  })
})

describe('escapeHtml', () => {
  it('转义 & < > " 单引号', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})

describe('scaffoldHfProject', () => {
  it('写出 hyperframes.json + index.html + assets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'))
    scaffoldHfProject(dir, '<html>x</html>', { 'narration.wav': Buffer.from([1, 2]) })
    expect(fs.existsSync(path.join(dir, 'hyperframes.json'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('x')
    expect(fs.readFileSync(path.join(dir, 'assets/narration.wav')).length).toBe(2)
  })
})

describe('renderHyperframes stub', () => {
  it('stub 模式写占位不 spawn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'))
    const out = path.join(dir, 'out.mp4')
    await renderHyperframes(dir, out, 'stub')
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.statSync(out).size).toBeGreaterThan(0)
  })
})
