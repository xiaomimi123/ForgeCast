import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCoverHtml, imageToDataUri, pickRawShot } from '../src/cover'

const tplDir = path.resolve(__dirname, '../../../templates/covers')
// 最小合法 1×1 PNG
const PNG1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

describe('buildCoverHtml', () => {
  it('填槽并转义 HTML', () => {
    const tpl = fs.readFileSync(path.join(tplDir, 'bigtext.html'), 'utf8')
    const html = buildCoverHtml(tpl, { main: '网店客服<还>在手动回?', sub: '一套系统 & 三人份' })
    expect(html).toContain('网店客服&lt;还&gt;在手动回?')
    expect(html).toContain('一套系统 &amp; 三人份')
    expect(html).not.toContain('{{main}}')
    expect(html).not.toContain('{{sub}}')
  })
  it('三套模板都有两个槽位', () => {
    for (const f of ['bigtext.html', 'annotate.html', 'contrast.html']) {
      const tpl = fs.readFileSync(path.join(tplDir, f), 'utf8')
      expect(tpl, f).toContain('{{main}}')
      expect(tpl, f).toContain('{{sub}}')
    }
  })
  it('annotate 有截图槽 {{shot}}，填入 shot', () => {
    const tpl = fs.readFileSync(path.join(tplDir, 'annotate.html'), 'utf8')
    expect(tpl).toContain('{{shot}}')
    const html = buildCoverHtml(tpl, { main: 'M', sub: 'S', shot: 'data:image/png;base64,AAA' })
    expect(html).toContain('data:image/png;base64,AAA')
    expect(html).not.toContain('{{shot}}')
  })
  it('无 shot 时 {{shot}} 置空、不残留占位', () => {
    const html = buildCoverHtml('<i>{{shot}}</i>', { main: 'M', sub: 'S' })
    expect(html).toBe('<i></i>')
  })
})

describe('pickRawShot', () => {
  function mkRaw(files: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-raw-'))
    for (const f of files) fs.writeFileSync(path.join(dir, f), 'x')
    return dir
  }
  it('图片优先于视频', () => {
    const dir = mkRaw(['b.mp4', 'a.png'])
    expect(pickRawShot(dir)).toEqual({ kind: 'image', path: path.join(dir, 'a.png') })
  })
  it('无图片时取视频', () => {
    const dir = mkRaw(['clip.mov', 'notes.txt'])
    expect(pickRawShot(dir)).toEqual({ kind: 'video', path: path.join(dir, 'clip.mov') })
  })
  it('无可用素材/目录不存在 → null', () => {
    expect(pickRawShot(mkRaw(['readme.txt']))).toBeNull()
    expect(pickRawShot('/no/such/dir')).toBeNull()
  })
})

describe('imageToDataUri', () => {
  it('按扩展名给 mime + base64', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-img-'))
    const p = path.join(dir, 'x.png')
    fs.writeFileSync(p, PNG1x1)
    const uri = imageToDataUri(p)
    expect(uri.startsWith('data:image/png;base64,')).toBe(true)
    expect(uri).toContain(PNG1x1.toString('base64'))
  })
})
