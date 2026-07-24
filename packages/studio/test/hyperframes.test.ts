import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { analyzeBeats, escapeHtml, fillTemplate, pickBgm, readShots, renderHyperframes, scaffoldHfProject, snapToBeat } from '../src/hyperframes'
import { buildMixFilter, mixAudio } from '../src/hyperframes'

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

describe('readShots', () => {
  it('按文件名排序、解析竖/横向；非图片忽略；空目录空数组', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'))
    // 1x2 png（竖）与 2x1 png（横）最小合法头
    fs.writeFileSync(path.join(dir, '02.png'), pngOf(1, 2))
    fs.writeFileSync(path.join(dir, '01.png'), pngOf(2, 1))
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x')
    const shots = readShots(dir)
    expect(shots.map((s) => s.rel)).toEqual(['01.png', '02.png'])
    expect(shots[0].orientation).toBe('landscape')
    expect(shots[1].orientation).toBe('portrait')
  })
})
// 辅助：构造给定宽高的最小 PNG（IHDR 里写宽高即可，无需完整像素）
function pngOf(w: number, h: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12)
  return Buffer.concat([sig, ihdr])
}

describe('analyzeBeats', () => {
  it('缓存存在时不 spawn，直接读', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-'))
    const bgm = path.join(dir, 'x.mp3'); fs.writeFileSync(bgm, 'fake')
    fs.writeFileSync(bgm + '.beats.json', JSON.stringify({ t0: 0.1, T: 0.5, bpm: 120, beats: [0.1, 0.6], strongBeats: [0.1], duration: 30 }))
    const run = vi.fn()
    const g = await analyzeBeats(bgm, '/fake/py', { run })
    expect(run).not.toHaveBeenCalled()
    expect(g?.bpm).toBe(120)
    expect(g?.beats).toEqual([0.1, 0.6])
  })
  it('无缓存时 spawn 生成后读', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-'))
    const bgm = path.join(dir, 'y.mp3'); fs.writeFileSync(bgm, 'fake')
    const run = vi.fn(async () => { fs.writeFileSync(bgm + '.beats.json', JSON.stringify({ t0: 0, T: 0.5, bpm: 120, beats: [0], strongBeats: [], duration: 10 })) })
    const g = await analyzeBeats(bgm, '/fake/py', { run })
    expect(run).toHaveBeenCalledOnce()
    expect(g?.duration).toBe(10)
  })
  it('spawn 失败或缓存坏 → null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-'))
    const bgm = path.join(dir, 'z.mp3'); fs.writeFileSync(bgm, 'fake')
    const run = vi.fn(async () => { throw new Error('librosa 挂了') })
    expect(await analyzeBeats(bgm, '/fake/py', { run })).toBeNull()
  })
})

describe('snapToBeat', () => {
  it('吸附到最近的拍', () => {
    expect(snapToBeat(3.1, [0, 1, 2, 3, 4])).toBe(3)
    expect(snapToBeat(3.6, [0, 1, 2, 3, 4])).toBe(4)
  })
  it('beats 空时原样返回', () => {
    expect(snapToBeat(3.1, [])).toBe(3.1)
  })
})

describe('pickBgm', () => {
  it('指定名命中（补后缀）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'tech.mp3'), 'a')
    expect(pickBgm(dir, 'tech')).toBe(path.join(dir, 'tech.mp3'))
  })
  it('不指定则取字典序第一个音频', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'b.mp3'), 'a'); fs.writeFileSync(path.join(dir, 'a.wav'), 'a')
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x') // 非音频忽略
    expect(pickBgm(dir)).toBe(path.join(dir, 'a.wav'))
  })
  it('空目录/不存在返 null', () => {
    expect(pickBgm('/no/such/dir')).toBeNull()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    expect(pickBgm(dir)).toBeNull()
  })
})

describe('buildMixFilter', () => {
  it('无 SFX：BGM 压低 + ducking + 与旁白 amix', () => {
    const f = buildMixFilter({ hasSfx: false, strongBeats: [], durationSec: 20 })
    expect(f).toContain('sidechaincompress')
    expect(f).toContain('amix')
    expect(f).not.toContain('adelay')
  })
  it('有 SFX：每个强拍 adelay 后并入', () => {
    const f = buildMixFilter({ hasSfx: true, strongBeats: [1.5, 3.0], durationSec: 20 })
    expect(f).toContain('adelay=1500')
    expect(f).toContain('adelay=3000')
  })
})

describe('mixAudio', () => {
  it('spawn ffmpeg 且失败抛错', async () => {
    const run = vi.fn(async () => { throw new Error('ffmpeg 挂') })
    await expect(mixAudio('/tmp/x.mp4', { bgmPath: '/tmp/b.mp3', sfxPath: null, strongBeats: [], durationSec: 10, deps: { run } }))
      .rejects.toThrow(/ffmpeg 挂/)
  })
})
