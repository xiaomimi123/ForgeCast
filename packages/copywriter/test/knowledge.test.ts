import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '@forgecast/core'
import { describe, expect, it } from 'vitest'
import { searchAtoms } from '../src/knowledge'

function db() {
  const d = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-')), 't.db'))
  const ins = d.prepare('INSERT INTO knowledge_atoms (topic, content) VALUES (?, ?)')
  ins.run('hook', '前3秒必须出现行业称呼，痛点要量化')
  ins.run('hook', '标题带数字的点击率更高')
  ins.run('pricing', '定价用锚点对比，不用绝对承诺')
  return d
}

describe('searchAtoms', () => {
  it('按词命中并限量返回', () => {
    const out = searchAtoms(db(), ['痛点', '数字'], 8)
    expect(out.length).toBe(2)
    expect(out[0].content).toContain('痛点')
  })
  it('无命中返回空数组', () => {
    expect(searchAtoms(db(), ['不存在的词'])).toEqual([])
  })
})
