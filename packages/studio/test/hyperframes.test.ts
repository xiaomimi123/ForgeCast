import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { analyzeBeats, escapeHtml, fillTemplate, pickBgm, pickMoodBgm, readShots, renderHyperframes, scaffoldHfProject, snapStarts, snapToBeat } from '../src/hyperframes'
import { buildMixFilter, mixAudio } from '../src/hyperframes'
import { buildDemoSections, buildTechBg, fillAccents, gridBeats, injectAudioCaptions, resolveTechBg } from '../src/hyperframes'
import { HOOK_MOOD, resolveMood, chooseBgmPath } from '../src/hyperframes'

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

describe('snapStarts（顺序吸附防重叠）', () => {
  it('无网格原样返回 start', () => {
    expect(snapStarts([{ start: 0, dur: 3 }, { start: 3, dur: 3 }], undefined)).toEqual([0, 3])
  })
  it('密集拍网格下吸附后单调递增且相邻段不重叠（钳位生效）', () => {
    // per=0.8s 的短段轮播，拍间隔 0.6s：独立吸附会让第二段吸到 6.6 < 第一段结束 6.8，重叠。
    const beats = Array.from({ length: 30 }, (_, i) => +(i * 0.6).toFixed(2))
    const segs = [{ start: 6, dur: 0.8 }, { start: 6.8, dur: 0.8 }, { start: 7.6, dur: 0.8 }]
    const st = snapStarts(segs, beats)
    // 逐段：后段 start 不早于前段结束（无重叠、不倒序）
    for (let i = 1; i < st.length; i++) {
      expect(st[i]).toBeGreaterThanOrEqual(st[i - 1] + segs[i - 1].dur)
    }
    // 且这个数据确实触发了钳位（至少一段的 snapped start 被抬离了它自己最近的拍）——
    // 断言 st[1] 不等于对 6.8 的独立最近拍（0.6*11=6.6），证明钳位真的介入了
    expect(st[1]).toBeGreaterThan(6.6)
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

describe('pickBgm 随机 + 向后兼容', () => {
  it('给 rand 从音频列表随机挑（注入 rand 断言命中项）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'a.mp3'), 'x'); fs.writeFileSync(path.join(dir, 'b.mp3'), 'x'); fs.writeFileSync(path.join(dir, 'c.mp3'), 'x')
    // 排序后 [a,b,c]；rand=0→a，rand≈0.99→c
    expect(pickBgm(dir, undefined, () => 0)).toBe(path.join(dir, 'a.mp3'))
    expect(pickBgm(dir, undefined, () => 0.99)).toBe(path.join(dir, 'c.mp3'))
  })
  it('不给 rand 仍字典序第一个（向后兼容）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'b.mp3'), 'x'); fs.writeFileSync(path.join(dir, 'a.mp3'), 'x')
    expect(pickBgm(dir)).toBe(path.join(dir, 'a.mp3'))
  })
})

describe('pickMoodBgm 情绪子目录', () => {
  it('情绪子目录有曲 → 该子目录随机', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.mkdirSync(path.join(dir, 'tense'))
    fs.writeFileSync(path.join(dir, 'tense', 'x.mp3'), 'x')
    fs.writeFileSync(path.join(dir, 'root.mp3'), 'x') // 根目录也有，但情绪目录优先
    expect(pickMoodBgm(dir, 'tense', () => 0)).toBe(path.join(dir, 'tense', 'x.mp3'))
  })
  it('情绪子目录缺失/空 → 回落根目录随机', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'root.mp3'), 'x')
    expect(pickMoodBgm(dir, 'tense', () => 0)).toBe(path.join(dir, 'root.mp3'))       // 无 tense 子目录
    fs.mkdirSync(path.join(dir, 'warm'))                                              // 空子目录
    expect(pickMoodBgm(dir, 'warm', () => 0)).toBe(path.join(dir, 'root.mp3'))
  })
  it('mood 为空 → 直接根目录随机', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'root.mp3'), 'x')
    expect(pickMoodBgm(dir, '', () => 0)).toBe(path.join(dir, 'root.mp3'))
  })
  it('子目录与根都空 → null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    expect(pickMoodBgm(dir, 'tense', () => 0)).toBeNull()
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

describe('gridBeats（线性网格外推整条时长）', () => {
  const g = (t0: number, T: number) => ({ t0, T, bpm: 60 / T, beats: [t0], strongBeats: [], duration: 24 })
  it('按 t0 相位、T 间隔外推到 durationSec（覆盖检测 beats 之外）', () => {
    const b = gridBeats(g(0.3, 0.5), 3)
    expect(b[0]).toBeCloseTo(0.3, 4)
    expect(b[1] - b[0]).toBeCloseTo(0.5, 4)
    expect(b[b.length - 1]).toBeLessThanOrEqual(3 + 1e-6)
    expect(b.length).toBe(6) // 0.3,0.8,1.3,1.8,2.3,2.8
  })
  it('T 非正时兜底返回检测 beats', () => {
    expect(gridBeats({ t0: 0, T: 0, bpm: 0, beats: [1, 2], strongBeats: [], duration: 5 }, 10)).toEqual([1, 2])
  })
})

describe('buildTechBg 科技背景变体', () => {
  it('已知变体出对应 class + 内层 + 烘进时长的 GSAP 微动', () => {
    const g = buildTechBg('synth', 30)
    expect(g.cls).toBe('bg-synth')
    expect(g.inner).toContain('class="sun"')
    expect(g.inner).toContain('class="mv"')
    expect(g.anim).toContain('duration:30')
    expect(g.anim).not.toContain('{{') // 时长已烘进，不留模板 slot
  })
  it('未知变体回落 grid', () => {
    expect(buildTechBg('nope', 10).cls).toBe('bg-grid')
  })
  it('resolveTechBg：random 按 rng 挑一套，具体名原样返回', () => {
    expect(resolveTechBg('synth')).toBe('synth')
    expect(resolveTechBg('random', () => 0)).toBe('grid')       // 索引 0
    expect(resolveTechBg('auto', () => 0.99)).toBe('mesh')      // 索引 4（末位）
  })
})

describe('injectAudioCaptions 字幕开关', () => {
  const cues = [{ start: 0, end: 2, text: '你好' }, { start: 2, end: 4, text: '世界' }]
  it('captions=true 注入字幕 div（不带 tw 解码）', () => {
    const out = injectAudioCaptions('<!--HF_AUDIO--><!--HF_CAPTIONS-->', 'a.wav', cues, 10, true)
    expect(out).toContain('class="cap clip"')
    expect(out).not.toContain('cap clip tw')
    expect(out).toContain('你好')
  })
  it('captions=false 不注入字幕，仍保留音轨', () => {
    const out = injectAudioCaptions('<!--HF_AUDIO--><!--HF_CAPTIONS-->', 'a.wav', cues, 10, false)
    expect(out).not.toContain('class="cap')
    expect(out).not.toContain('你好')
    expect(out).toContain('<audio id="narration"')
  })
})

describe('fillAccents', () => {
  it('填入关键帧行并消费标记', () => {
    const out = fillAccents('<script>tl;<!--HF_ACCENTS--></script>', 'tl.to("#car0",{},1);')
    expect(out).toContain('tl.to("#car0"')
    expect(out).not.toContain('<!--HF_ACCENTS-->')
  })
  it('空强调则清空标记', () => {
    const out = fillAccents('<script><!--HF_ACCENTS--></script>', '')
    expect(out).not.toContain('<!--HF_ACCENTS-->')
    expect(out).toBe('<script></script>')
  })
})

describe('buildDemoSections（截图轮播卡点）', () => {
  const base = {
    hookTitle: '钩子', painPoints: ['痛1', '痛2'], priceAnchor: '¥99', cta: '扣1', brandName: 'demo',
    shots: [{ rel: '01.png', orientation: 'portrait' as const }, { rel: '02.png', orientation: 'landscape' as const }],
  }
  it('有节拍网格：每 4 拍一刀、图不够循环、每张切进来弹跳', () => {
    // T=0.5s 的密网格（0..29.5），窗口 [6, 24)，每 4 拍(=2s)一刀
    const beats = Array.from({ length: 60 }, (_, i) => +(i * 0.5).toFixed(2))
    const r = buildDemoSections({ ...base, durationSec: 30, beats })
    // 多于图片数的切点（>2）→ 说明在快切而非按图数均分
    const nCar = (r.html.match(/id="car\d+"/g) || []).length
    expect(nCar).toBeGreaterThan(base.shots.length)
    // 循环取图：两张图的 src 都出现（且 01 出现多次）
    expect(r.html).toContain('01.png'); expect(r.html).toContain('02.png')
    expect((r.html.match(/01\.png/g) || []).length).toBeGreaterThanOrEqual(2)
    // 每刀一条图片弹跳，挂在对应 #carK 上、消费标记后可注入
    expect(r.accents).toContain('tl.to("#car0"')
    expect(r.accents.split('\n').length).toBe(nCar)
    // 切点落在拍网格上（首刀 data-start 是 0.5 的整数倍）
    const firstCar = r.html.match(/id="car0" data-start="([0-9.]+)"/)
    expect(firstCar).toBeTruthy()
    expect((Number(firstCar![1]) / 0.5) % 1).toBeCloseTo(0, 5)
  })
  it('无 BGM：退回按图数均分、不加弹跳', () => {
    const r = buildDemoSections({ ...base, durationSec: 30 })
    expect((r.html.match(/id="car\d+"/g) || []).length).toBe(base.shots.length) // 一图一段
    expect(r.accents).toBe('') // 无 BGM 不卡点不弹
  })
})

describe('resolveMood 情绪映射', () => {
  it('四 hook 映射到情绪键', () => {
    expect(resolveMood('pain')).toBe('tense')
    expect(resolveMood('sideline')).toBe('upbeat')
    expect(resolveMood('infogap')).toBe('tech')
    expect(resolveMood('story')).toBe('warm')
  })
  it('override 覆盖 hook 映射', () => {
    expect(resolveMood('pain', 'warm')).toBe('warm')
  })
  it('未知 hook 且无 override → 空串', () => {
    expect(resolveMood('nope')).toBe('')
    expect(resolveMood('')).toBe('')
  })
})

describe('chooseBgmPath 选曲优先级链', () => {
  function seed() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.mkdirSync(path.join(dir, 'tense')); fs.mkdirSync(path.join(dir, 'warm'))
    fs.writeFileSync(path.join(dir, 'tense', 't.mp3'), 'x')
    fs.writeFileSync(path.join(dir, 'warm', 'w.mp3'), 'x')
    fs.writeFileSync(path.join(dir, 'named.mp3'), 'x')
    fs.writeFileSync(path.join(dir, 'root.mp3'), 'x')
    return dir
  }
  it('--bgm 指定具体曲 → 跳过情绪匹配', () => {
    const dir = seed()
    expect(chooseBgmPath(dir, { bgm: 'named', mood: 'warm', hook: 'pain' }, () => 0)).toBe(path.join(dir, 'named.mp3'))
  })
  it('bgm=none → null（--no-bgm）', () => {
    const dir = seed()
    expect(chooseBgmPath(dir, { bgm: 'none', mood: '', hook: 'pain' }, () => 0)).toBeNull()
  })
  it('--mood 覆盖 hook 自动映射', () => {
    const dir = seed()
    // hook=pain 本应 tense；mood=warm 覆盖 → warm 子目录
    expect(chooseBgmPath(dir, { bgm: '', mood: 'warm', hook: 'pain' }, () => 0)).toBe(path.join(dir, 'warm', 'w.mp3'))
  })
  it('默认按 hook 自动映射情绪', () => {
    const dir = seed()
    expect(chooseBgmPath(dir, { bgm: '', mood: '', hook: 'pain' }, () => 0)).toBe(path.join(dir, 'tense', 't.mp3'))
  })
  it('情绪目录空 → 回落根目录', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-'))
    fs.writeFileSync(path.join(dir, 'root.mp3'), 'x') // 无情绪子目录
    expect(chooseBgmPath(dir, { bgm: '', mood: '', hook: 'pain' }, () => 0)).toBe(path.join(dir, 'root.mp3'))
  })
})
