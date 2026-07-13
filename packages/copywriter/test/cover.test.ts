import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCoverHtml } from '../src/cover'

const tplDir = path.resolve(__dirname, '../../../templates/covers')

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
})
