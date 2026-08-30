import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { analyzeBeats, autoCutPlan, escapeHtml, fillTemplate, pickBgm, pickMoodBgm, planCutTimes, readShots, renderHyperframes, scaffoldHfProject, snapStarts, snapToBeat } from '../src/hyperframes'
import { buildMixFilter, mixAudio } from '../src/hyperframes'
import { buildChangelogSections, buildDemoSections, buildFlashSections, buildInsightSections, buildStorySections, buildTechBg, fillAccents, gridBeats, injectAudioCaptions, resolveTechBg } from '../src/hyperframes'
import { HOOK_MOOD, resolveMood, chooseBgmPath } from '../src/hyperframes'
import { DECODE_RUNTIME } from '../src/hyperframes'
import { buildCameraKeyframes, idlePhase, injectTechFx } from '../src/hyperframes'

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

  it('assets/fonts 坏软链（如宿主机绝对路径在容器内失效）被替换为可用的相对软链', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'))
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
    fs.symlinkSync('/no/such/host/path/fonts', path.join(dir, 'assets', 'fonts'), 'dir')
    expect(() => scaffoldHfProject(dir, '<html>x</html>')).not.toThrow()
    const fontsDst = path.join(dir, 'assets', 'fonts')
    const st = fs.lstatSync(fontsDst)
    if (st.isSymbolicLink()) {
      expect(fs.existsSync(fontsDst)).toBe(true)
      expect(path.isAbsolute(fs.readlinkSync(fontsDst))).toBe(false)
    } else {
      expect(st.isDirectory()).toBe(true)
    }
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
  it('图片数多于节拍切点数：仍保证每张图至少出现一次（不因快切节奏丢图）', () => {
    const manyShots = {
      ...base,
      shots: Array.from({ length: 5 }, (_, i) => ({ rel: `${String(i + 1).padStart(2, '0')}.png`, orientation: 'portrait' as const })),
    }
    // 窗口 [6,24) 内共 12 拍，每 4 拍取一刀 → 只够切出 3 刀（少于 5 张图，且 ≥2 不会触发"拍太少"回退）
    const beats = Array.from({ length: 12 }, (_, i) => 6 + i * 0.5)
    const r = buildDemoSections({ ...manyShots, durationSec: 30, beats })
    for (const s of manyShots.shots) expect(r.html).toContain(s.rel)
  })
})

describe('buildDemoSections 消费卡点方案', () => {
  const base = {
    hookTitle: '钩子', painPoints: ['痛1'], priceAnchor: '¥99', cta: '扣1', brandName: 'demo',
    shots: [{ rel: '01.png', orientation: 'portrait' as const }, { rel: '02.png', orientation: 'landscape' as const }],
  }
  it('给 plan 用方案 cuts（时间+配图），不再自动 cadence', () => {
    // 方案：两刀 8s(图1)、12s(图0)
    const r = buildDemoSections({ ...base, durationSec: 30, plan: { cuts: [{ start: 8, shot: 1 }, { start: 12, shot: 0 }] } })
    // car0 落在 8s、car1 落在 12s
    expect(r.html).toMatch(/id="car0" data-start="8/)
    expect(r.html).toMatch(/id="car1" data-start="12/)
    // 每刀一条图片弹跳
    expect(r.accents).toContain('tl.to("#car0"'); expect(r.accents).toContain('tl.to("#car1"')
  })
  it('plan cuts 超过窗口末(carEnd=dur-6)的被过滤', () => {
    // dur=30 → carEnd=24；一刀在 26s 应被丢
    const r = buildDemoSections({ ...base, durationSec: 30, plan: { cuts: [{ start: 8, shot: 0 }, { start: 26, shot: 1 }] } })
    expect((r.html.match(/id="car\d+"/g) || []).length).toBe(1)
  })
  it('plan cuts 早于窗口起点(carStart=6)的被过滤', () => {
    const r = buildDemoSections({ ...base, durationSec: 30, plan: { cuts: [{ start: 2, shot: 0 }, { start: 8, shot: 1 }] } })
    expect((r.html.match(/id="car\d+"/g) || []).length).toBe(1) // 2s 的被丢
  })
  it('不传 plan 行为不变（回归：无 beats 按图数均分）', () => {
    const r = buildDemoSections({ ...base, durationSec: 30 })
    expect((r.html.match(/id="car\d+"/g) || []).length).toBe(base.shots.length)
  })
})

describe('buildInsightSections（数据卡片按旁白节奏累加）', () => {
  const base = { painTitle: '大标题', cta: '扣1', brandName: 'demo' }
  it('cue 命中数字正则则生成卡片，data-start 等于 cue.start', () => {
    const cues = [
      { start: 2, end: 4, text: '这个数字达到了53%这么高' },
      { start: 6, end: 8, text: '没有数字的一句话' },
    ]
    const r = buildInsightSections({ cues, durationSec: 20, ...base })
    expect(r.html).toContain('data-start="2"')
    expect(r.html).toContain('53%')
    // 无数字的第二句不生成卡片
    expect((r.html.match(/class="card"/g) || []).length).toBe(1)
  })
  it('超过 3 张自动分组，组内 idx 从 0 开始取色循环', () => {
    const cues = Array.from({ length: 4 }, (_, i) => ({ start: i * 2, end: i * 2 + 1, text: `第${i}句有${10 + i}%数据` }))
    const r = buildInsightSections({ cues, durationSec: 30, ...base })
    // 4 张卡应分成 [3,1] 两组：第 4 张卡（组内 idx=0）应带第一组色 #ffd54f
    expect((r.html.match(/class="card"/g) || []).length).toBe(4)
    const ids = [...r.html.matchAll(/id="(insCard\d+_\d+)"/g)].map((m) => m[1])
    expect(ids).toEqual(['insCard0_0', 'insCard0_1', 'insCard0_2', 'insCard1_0'])
  })
  it('相邻卡片间隔超 12s 强制开新组', () => {
    const cues = [
      { start: 0, end: 1, text: '第一句50%' },
      { start: 20, end: 21, text: '第二句60%' }, // 间隔 20s > 12s
    ]
    const r = buildInsightSections({ cues, durationSec: 30, ...base })
    const ids = [...r.html.matchAll(/id="(insCard\d+_\d+)"/g)].map((m) => m[1])
    expect(ids).toEqual(['insCard0_0', 'insCard1_0'])
  })
  it('零命中：只渲染开场大字+结尾 CTA，不留空卡片区、不报错', () => {
    const cues = [{ start: 0, end: 2, text: '没有任何数字的一句话' }]
    const r = buildInsightSections({ cues, durationSec: 20, ...base })
    expect(r.html).not.toContain('class="card"')
    expect(r.html).toContain('大标题')
    expect(r.html).toContain('扣1')
    expect(r.accents).toBe('')
  })
  it('accents 逐卡片生成 tl.from 淡入', () => {
    const cues = [{ start: 3, end: 4, text: '增长了80%' }]
    const r = buildInsightSections({ cues, durationSec: 20, ...base })
    expect(r.accents).toContain('tl.from("#insCard0_0"')
    expect(r.accents).toContain(', 3);')
  })
})

describe('buildInsightSections 轨道分配', () => {
  const cues = [
    { start: 10, end: 14, text: '工期要 2-4周，一单多烧人力' },
    { start: 20, end: 24, text: '返工率高达 30%' },
    { start: 26, end: 30, text: '每单多花 3 个工作日' },
  ]
  it('同组内多张卡片不共用 track，避免 overlapping_clips_same_track', () => {
    const { html } = buildInsightSections({
      cues, durationSec: 60, painTitle: '标题', cta: '行动', brandName: '品牌',
    })
    // 收集所有卡片 clip 的 [track, start, end]
    const clips = [...html.matchAll(/id="insCard\d+_\d+"[^>]*data-start="([\d.]+)" data-duration="([\d.]+)" data-track-index="(\d+)"/g)]
      .map((m) => ({ start: +m[1], end: +m[1] + +m[2], track: +m[3] }))
    expect(clips.length).toBeGreaterThanOrEqual(2)
    for (const a of clips) {
      for (const b of clips) {
        if (a === b) continue
        if (a.track !== b.track) continue
        // 同轨则必须不重叠
        expect(a.end <= b.start || b.end <= a.start).toBe(true)
      }
    }
  })
  it('卡片轨道不与开场/结尾（track 1）和音轨（track 0）冲突', () => {
    const { html } = buildInsightSections({
      cues, durationSec: 60, painTitle: '标题', cta: '行动', brandName: '品牌',
    })
    const tracks = [...html.matchAll(/id="insCard\d+_\d+"[^>]*data-track-index="(\d+)"/g)].map((m) => +m[1])
    expect(tracks.every((t) => t >= 2)).toBe(true)
  })
})

describe('insight 构图约束', () => {
  const cues = Array.from({ length: 8 }, (_, i) => ({
    start: 5 + i * 6, end: 9 + i * 6, text: `第${i}项返工率 ${10 + i}%`,
  }))
  // fix round 1：驻留上限只在"还有后继卡"时生效——组内最后一张卡没有后继，不封顶，
  // 直接撑到本组窗口结束（sceneEnd），否则稀疏 cue 下会在卡与卡之间抠出空白（见下面单独 describe）。
  it('组内有后继的卡（非组内最后一张）驻留不超过 8 秒', () => {
    const { html } = buildInsightSections({ cues, durationSec: 60, painTitle: 'T', cta: 'C', brandName: 'B' })
    // 按本 fixture 的分组结果（[0,1,2] [3,4,5] [6,7]），非组内最后一张的 id 如下
    const nonLastIds = ['insCard0_0', 'insCard0_1', 'insCard1_0', 'insCard1_1', 'insCard2_0']
    for (const id of nonLastIds) {
      const m = html.match(new RegExp(`id="${id}"[^>]*data-duration="([\\d.]+)"`))
      expect(+m![1]).toBeLessThanOrEqual(8)
    }
  })
  it('组内最后一张卡不封顶，撑到本组窗口结束，不因 8 秒硬顶抠出空白', () => {
    const { html } = buildInsightSections({ cues, durationSec: 60, painTitle: 'T', cta: 'C', brandName: 'B' })
    // insCard0_2：组0 最后一张，撑到组1 第一张卡进场（23s），时长 23-17=6，超过看似的“上限”也不封顶
    expect(html).toMatch(/id="insCard0_2"[^>]*data-start="17" data-duration="6"/)
    // insCard2_1：组2（只剩2张）最后一张，撑到 outroStart（57s），时长 10 秒，明确 >8 秒
    expect(html).toMatch(/id="insCard2_1"[^>]*data-start="47" data-duration="10"/)
  })
  it('任意时刻同屏卡片不超过 3 张', () => {
    const { html } = buildInsightSections({ cues, durationSec: 60, painTitle: 'T', cta: 'C', brandName: 'B' })
    const clips = [...html.matchAll(/id="insCard\d+_\d+"[^>]*data-start="([\d.]+)" data-duration="([\d.]+)"/g)]
      .map((m) => ({ s: +m[1], e: +m[1] + +m[2] }))
    for (let t = 0; t <= 60; t += 0.5) {
      const live = clips.filter((c) => t >= c.s && t < c.e).length
      expect(live).toBeLessThanOrEqual(3)
    }
  })
})

describe('insight 稀疏 cue 不留空白帧（fix round 1 回归：8s 硬顶曾经在卡之间抠出十几秒空白）', () => {
  it('cue 间隔 >12s（每条独立成组，组内只有 1 张卡）时，前一张卡精确撑到下一张卡进场', () => {
    const cues = [
      { start: 8, end: 9, text: '返工率10%' },
      { start: 30, end: 31, text: '返工率12%' },
      { start: 50, end: 51, text: '返工率15%' },
    ]
    const { html } = buildInsightSections({ cues, durationSec: 60, painTitle: 'T', cta: 'C', brandName: 'B' })
    const clips = [...html.matchAll(/id="(insCard\d+_\d+)"[^>]*data-start="([\d.]+)" data-duration="([\d.]+)"/g)]
      .map((m) => ({ id: m[1], s: +m[2], e: +m[2] + +m[3] }))
    expect(clips.map((c) => c.id)).toEqual(['insCard0_0', 'insCard1_0', 'insCard2_0'])
    expect(clips[0].e).toBeCloseTo(clips[1].s, 5) // 第一张卡撑到第二张进场，中间无空白
    expect(clips[1].e).toBeCloseTo(clips[2].s, 5) // 第二张卡撑到第三张进场，中间无空白
  })
})

describe('insight 0 张卡片 floor（真实口播用中文数字"三个""几万"，INSIGHT_STAT_RE 只认阿拉伯数字，全部落空）', () => {
  it('cues 全无阿拉伯数字命中时，开场标题撑满到结尾 CTA 进场，intro/outro 之间不留时间缺口', () => {
    const cues = [
      { start: 2, end: 4, text: '我们服务了三个客户' },
      { start: 10, end: 12, text: '一年帮大家省了几万块钱' },
    ]
    const { html } = buildInsightSections({ cues, durationSec: 20, painTitle: 'T', cta: 'C', brandName: 'B' })
    expect(html).not.toContain('class="card"')
    const introMatch = html.match(/id="insight-intro"[^>]*data-start="([\d.]+)" data-duration="([\d.]+)"/)
    const outroMatch = html.match(/id="insight-outro"[^>]*data-start="([\d.]+)" data-duration="([\d.]+)"/)
    expect(introMatch).not.toBeNull()
    expect(outroMatch).not.toBeNull()
    const introEnd = +introMatch![1] + +introMatch![2]
    const outroStart = +outroMatch![1]
    expect(introEnd).toBeCloseTo(outroStart, 5) // 无覆盖缺口
  })
})

describe('buildFlashSections（开场钩子→中段流动字幕→结尾CTA，按真实时长动态铺满）', () => {
  const base = { painTitle: '大标题', sellingPoint: '卖点一句话', cta: '扣1', brandName: 'demo' }

  it('painTitle 出现在开头 data-start="0"', () => {
    const r = buildFlashSections({ cues: [], durationSec: 20, ...base })
    expect(r.html).toContain('data-start="0"')
    expect(r.html).toContain('大标题')
  })

  it('回归：外层 flex 容器（.center，column 方向）与 .tw 解码目标必须是两层不同元素，不能合一层——' +
     '否则解码脚本往 .tw 元素里塞的逐字 <span> 会被当成 flex 子项纵向堆成一条竖线（真渲验证过的视觉 bug）', () => {
    const r = buildFlashSections({ cues: [], durationSec: 20, ...base })
    // 外层 clip 容器（fill pad center）不能同时带 painT/tw：那样 .tw 就是 flex 容器本身
    expect(r.html).not.toMatch(/class="clip fill pad center[^"]*\btw\b[^"]*"/)
    // painT/tw 必须出现在内层独立的 div 上
    expect(r.html).toMatch(/<div class="painT tw">/)
  })

  it('回归：此前 CTA 写死在 8-12s 收尾，长视频（60s）后段空转——现在 CTA 必须跟着 durationSec 走到结尾附近', () => {
    const r = buildFlashSections({ cues: [], durationSec: 60, ...base })
    // ctaDur = clamp(60*0.12=7.2, 2.5, 4) = 4；cta 应在 56s 起，而不是停在旧版的 8s
    expect(r.html).toContain('data-start="56"')
    expect(r.html).not.toMatch(/id="s3"[^>]*data-start="8"/)
  })

  it('短时长（20s）下 hook/cta 按比例算，不是写死的 4s', () => {
    const r = buildFlashSections({ cues: [], durationSec: 20, ...base })
    // hookDur = clamp(20*0.15=3, 2.5, 4) = 3；ctaDur = clamp(20*0.12=2.4, 2.5, 4) = 2.5
    expect(r.html).toContain('data-duration="3"')
    expect(r.html).toContain('data-start="17.5"')
  })

  it('sellingPoint 作为高亮卡片出现在中段，class 带 highlight 标记', () => {
    const r = buildFlashSections({ cues: [], durationSec: 20, ...base })
    expect(r.html).toContain('卖点一句话')
    expect(r.html).toMatch(/class="[^"]*highlightCard[^"]*"/)
  })

  it('中段 cue 逐条生成流动字幕 clip，data-start 对齐（钳制在中段窗口内）cue 时间', () => {
    // durationSec=20 时高亮卡片窗口是 [8.8, 11.3]（见下一条回归用例），这两句 cue 选在窗口外
    const cues = [{ start: 5, end: 7, text: '第一句话' }, { start: 13, end: 15, text: '第二句话' }]
    const r = buildFlashSections({ cues, durationSec: 20, ...base })
    expect(r.html).toContain('data-start="5"')
    expect(r.html).toContain('第一句话')
    expect(r.html).toContain('data-start="13"')
    expect(r.html).toContain('第二句话')
  })

  it('中段没有任何 cue 落入窗口时不报错，仍正常渲染 hook/cta/sellingPoint', () => {
    const r = buildFlashSections({ cues: [], durationSec: 20, ...base })
    expect(r.html).toContain('大标题')
    expect(r.html).toContain('扣1')
    expect(r.html).toContain('卖点一句话')
  })

  it('回归：高亮卡片时段内的 cue 不再生成流动字幕（此前两者都是满屏居中，同时出现会叠成一坨看不清）', () => {
    // durationSec=20：hookDur=3, ctaDur=2.5, midStart=3, midEnd=17.5
    // highlightStart = 3 + (17.5-3)*0.4 = 8.8, highlightDur = min(2.5, 17.5-8.8) = 2.5 → 高亮窗口 [8.8, 11.3]
    const cues = [
      { start: 5, end: 6, text: '窗口前的正常字幕' },
      { start: 9, end: 10.5, text: '这句正好撞上高亮卡片' },
      { start: 13, end: 14, text: '窗口后的正常字幕' },
    ]
    const r = buildFlashSections({ cues, durationSec: 20, ...base })
    expect(r.html).toContain('窗口前的正常字幕')
    expect(r.html).toContain('窗口后的正常字幕')
    expect(r.html).not.toContain('这句正好撞上高亮卡片')
  })

  it('极短时长（3s）下 hook+cta 按比例压缩不越界，不产生负数时长', () => {
    const r = buildFlashSections({ cues: [], durationSec: 3, ...base })
    expect(r.html).not.toMatch(/data-duration="-/)
    expect(r.html).not.toMatch(/data-start="-/)
  })

  it('accents 含 hook/cta/highlight 的入场动画', () => {
    const r = buildFlashSections({ cues: [], durationSec: 20, ...base })
    expect(r.accents).toContain('tl.from(')
  })
})

describe('buildStorySections（回归：气泡此前全挤在开头2秒内出现，聊天场后段长时间静止不变）', () => {
  const storyBase = { sellingPoint: '卖点', cta: '扣1', brandName: 'demo' }

  it('返回 {html, accents} 而不是裸字符串', () => {
    const bubbles = [{ who: 'them' as const, text: 'A' }, { who: 'me' as const, text: 'B' }]
    const r = buildStorySections({ bubbles, durationSec: 20, ...storyBase })
    expect(typeof r.html).toBe('string')
    expect(typeof r.accents).toBe('string')
  })

  it('6 条气泡、durationSec=61 时，最后一条气泡的入场时间要铺到聊天窗口尾部附近，不再挤在头几秒', () => {
    const bubbles = Array.from({ length: 6 }, (_, i) => ({ who: (i % 2 === 0 ? 'them' : 'me') as const, text: `msg${i}` }))
    const r = buildStorySections({ bubbles, durationSec: 61, ...storyBase })
    // chatDur = 61-6 = 55；step = max(2.5, (55-1)/5) = 10.8；最后一条钳制在 chatDur-1=54
    expect(r.accents).toContain(', 54);')
  })

  it('气泡少、时长短时（3条，durationSec=20）不会挤成负数或重叠到卖点/CTA 段', () => {
    const bubbles = [{ who: 'them' as const, text: 'A' }, { who: 'me' as const, text: 'B' }, { who: 'them' as const, text: 'C' }]
    const r = buildStorySections({ bubbles, durationSec: 20, ...storyBase })
    expect(r.accents).not.toMatch(/, -/)
  })

  it('聊天气泡文本仍会转义（防注入）', () => {
    const bubbles = [{ who: 'them' as const, text: '<script>' }]
    const r = buildStorySections({ bubbles, durationSec: 20, ...storyBase })
    expect(r.html).not.toContain('<script>')
    expect(r.html).toContain('&lt;script&gt;')
  })
})

describe('buildChangelogSections（回归：标题screen固定6s后是一整块静止到底的brand+cta，长视频90%以上画面冻结）', () => {
  const clBase = { label: '本周更新', title: '标题', subtitle: '副标题', cta: '扣1', brandName: 'demo' }

  it('返回 {html, accents}', () => {
    const r = buildChangelogSections({ cues: [], durationSec: 20, ...clBase })
    expect(typeof r.html).toBe('string')
    expect(typeof r.accents).toBe('string')
  })

  it('回归：长视频（61s）下 CTA 必须贴着 durationSec 收尾，不再是固定 6s 后一路静止到底', () => {
    const r = buildChangelogSections({ cues: [], durationSec: 61, ...clBase })
    // titleDur = clamp(61*0.15=9.15, 3, 5) = 5；ctaDur = clamp(61*0.12=7.32, 2.5, 4) = 4；cta 应在 57s 起
    expect(r.html).toContain('data-start="57"')
    expect(r.html).not.toMatch(/data-duration="55"/) // 旧版 s2dur=duration-6 的写法不应再出现
  })

  it('中段 cue 按时间点生成流动内容，data-start 对齐 cue', () => {
    const cues = [{ start: 10, end: 12, text: '这周修的第一个东西' }, { start: 20, end: 22, text: '第二个改动' }]
    const r = buildChangelogSections({ cues, durationSec: 61, ...clBase })
    expect(r.html).toContain('data-start="10"')
    expect(r.html).toContain('这周修的第一个东西')
    expect(r.html).toContain('data-start="20"')
    expect(r.html).toContain('第二个改动')
  })

  it('标题/label/副标题出现在开头', () => {
    const r = buildChangelogSections({ cues: [], durationSec: 20, ...clBase })
    expect(r.html).toContain('data-start="0"')
    expect(r.html).toContain('标题')
    expect(r.html).toContain('副标题')
    expect(r.html).toContain('本周更新')
  })

  it('极短时长不产生负数/越界', () => {
    const r = buildChangelogSections({ cues: [], durationSec: 3, ...clBase })
    expect(r.html).not.toMatch(/data-duration="-/)
    expect(r.html).not.toMatch(/data-start="-/)
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

describe('autoCutPlan 自动卡点方案', () => {
  const grid = { t0: 0, T: 0.5 } // 拍在 0,0.5,1,...
  it('每 cadence 拍一刀，图循环 k%shotCount', () => {
    // duration=30 → 窗口 [6,24)；cadence=4 → beat 12,16,20,...(t0=0 时 beat=时间/0.5)
    const cuts = autoCutPlan(grid, 2, 30, 4)
    expect(cuts[0].beat).toBe(12)          // 6s / 0.5 = 12
    expect(cuts[1].beat).toBe(16)          // +4 拍
    expect(cuts[0].shot).toBe(0); expect(cuts[1].shot).toBe(1); expect(cuts[2].shot).toBe(0) // 循环
    // 都 < 窗口末 24s → beat < 48
    expect(cuts.every((c) => c.beat < 48)).toBe(true)
  })
  it('cadence=2 更密', () => {
    expect(autoCutPlan(grid, 3, 30, 2).length).toBeGreaterThan(autoCutPlan(grid, 3, 30, 4).length)
  })
  it('shotCount<=0 返空', () => {
    expect(autoCutPlan(grid, 0, 30, 4)).toEqual([])
  })
  it('cadence 非法(0/负/NaN) 不死循环——回落步进', () => {
    const grid = { t0: 0, T: 0.5 }
    expect(autoCutPlan(grid, 2, 30, 0).length).toBeGreaterThan(0)      // 0 不能死循环
    expect(autoCutPlan(grid, 2, 30, -4).length).toBeGreaterThan(0)     // 负不能死循环
    expect(autoCutPlan(grid, 2, 30, NaN).length).toBeGreaterThan(0)    // NaN 不能死循环
    // 且非法输入回落到默认步进(4)，与 cadence=4 结果一致
    expect(autoCutPlan(grid, 2, 30, 0)).toEqual(autoCutPlan(grid, 2, 30, 4))
  })
})

describe('planCutTimes 方案→时间', () => {
  const plan = { grid: { t0: 0.5, T: 0.5 }, offsetSec: 0, cuts: [{ beat: 12, shot: 0 }, { beat: 16, shot: 5 }] }
  it('beat+offset+grid 算时间，shot 越界钳制，升序', () => {
    const t = planCutTimes(plan, 3)
    expect(t[0].start).toBeCloseTo(0.5 + 12 * 0.5, 5)   // 6.5
    expect(t[1].start).toBeCloseTo(0.5 + 16 * 0.5, 5)   // 8.5
    expect(t[1].shot).toBe(2)                            // 5 钳到 shotCount-1=2
  })
  it('offsetSec 平移所有刀', () => {
    const t = planCutTimes({ ...plan, offsetSec: 0.2 }, 3)
    expect(t[0].start).toBeCloseTo(6.7, 5)
  })
  it('shotCount<=0 返空', () => {
    expect(planCutTimes(plan, 0)).toEqual([])
  })
})

describe('DECODE_RUNTIME 确定性', () => {
  it('运行时脚本里不含 Math.random（HyperFrames 硬规则：渲染各帧须一致）', () => {
    expect(DECODE_RUNTIME).not.toContain('Math.random')
  })

  it('内联的 mulberry32 同种子产出同序列、不同种子产出不同序列', () => {
    // 把注入进合成产物的那份 mulberry32 原样抠出来跑，确保实现本身正确
    const src = DECODE_RUNTIME.match(/function mulberry32[\s\S]*?\n\s*\}/)
    expect(src, '未能从 DECODE_RUNTIME 中提取 mulberry32').toBeTruthy()
    const mulberry32 = new Function(`${src![0]}; return mulberry32`)() as (seed: number) => () => number

    /** 用给定种子取前 5 个数 */
    const take5 = (seed: number) => { const r = mulberry32(seed); return [r(), r(), r(), r(), r()] }

    expect(take5(42)).toEqual(take5(42))        // 同种子可复现
    expect(take5(42)).not.toEqual(take5(43))    // 不同种子有差异
    expect(take5(42).every((x) => x >= 0 && x < 1)).toBe(true)
  })
})

describe('时间轴元素稳定 id', () => {
  const cues = [{ start: 5, end: 9, text: '返工率 30%' }]
  it('insight 的开场与结尾 clip 都带 id', () => {
    const { html } = buildInsightSections({
      cues, durationSec: 30, painTitle: '标题', cta: '行动', brandName: '品牌',
    })
    const topClips = [...html.matchAll(/<div class="clip"([^>]*)>/g)].map((m) => m[1])
    expect(topClips.length).toBeGreaterThan(0)
    // 控制器裁决：顶层 clip 正则也会命中卡片（既有 insCard{gi}_{idx} 是驼峰+下划线，
    // 不是全小写连字符）——只断言 id 存在且非空，不约束字符集。
    for (const attrs of topClips) expect(attrs).toMatch(/\sid="[^"]+"/)
  })
  it('id 稳定：同样输入两次生成得到完全相同的 id 集合', () => {
    const mk = () => buildInsightSections({
      cues, durationSec: 30, painTitle: '标题', cta: '行动', brandName: '品牌',
    }).html
    const ids = (h: string) => [...h.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
    expect(ids(mk())).toEqual(ids(mk()))
  })
  it('demo 顶层 clip（hook/pain/price/cta）都带 id', () => {
    const { html } = buildDemoSections({
      hookTitle: '钩子', painPoints: ['痛1'], priceAnchor: '¥99', cta: '扣1', brandName: 'demo',
      shots: [{ rel: '01.png', orientation: 'portrait' as const }], durationSec: 30,
    })
    expect(html).toContain('id="demo-hook"')
    expect(html).toContain('id="demo-pain"')
    expect(html).toContain('id="demo-price"')
    expect(html).toContain('id="demo-cta"')
  })
})

describe('相机曲线', () => {
  it('末键落在片长之外，避免片尾收住导致静止', () => {
    const k = buildCameraKeyframes(60)
    expect(k.durationSec).toBeGreaterThan(60)
  })
  it('缩放幅度温和（1 → 1.02~1.10 之间），不至于把画面推爆', () => {
    const k = buildCameraKeyframes(60)
    expect(k.to.scale).toBeGreaterThan(1.01)
    expect(k.to.scale).toBeLessThanOrEqual(1.10)
  })
})

describe('idle 相位错开', () => {
  it('相邻序号的相位不同，避免同屏元素同步呼吸', () => {
    expect(idlePhase(0)).not.toBeCloseTo(idlePhase(1), 5)
  })
  it('同序号恒定（确定性）', () => {
    expect(idlePhase(7)).toBe(idlePhase(7))
  })
})

describe('injectTechFx 相机层注入', () => {
  it('无条件填充 <!--HF_CAM-->，即使不传 bg（story 场景不传 bg）', () => {
    const html = '<!--HF_FXCSS--><!--HF_DECODE--><!--HF_CAM-->'
    const out = injectTechFx(html, { durationSec: 30 })
    expect(out).not.toContain('<!--HF_CAM-->')
    expect(out).toContain('#cam')
  })
  it('相机 GSAP 行按 buildCameraKeyframes 生成', () => {
    const html = '<!--HF_CAM-->'
    const out = injectTechFx(html, { durationSec: 30 })
    const k = buildCameraKeyframes(30)
    expect(out).toContain(`scale: ${k.to.scale}`)
    expect(out).toContain(`duration: ${k.durationSec}`)
  })
})

describe('10 个模板都注入相机层且不残留旧的 #root 缩放', () => {
  const templatesDir = path.resolve(__dirname, '../../../templates/hf')
  const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.html'))

  it('templates/hf 下确实有 10 个模板', () => {
    expect(files.length).toBe(10)
  })

  for (const file of fs.readdirSync(templatesDir).filter((f) => f.endsWith('.html'))) {
    it(`${file}: 含 <!--HF_CAM--> 标记与 #cam 包裹层，不含旧的 #root 缩放`, () => {
      const raw = fs.readFileSync(path.join(templatesDir, file), 'utf8')
      expect(raw).toContain('<!--HF_CAM-->')
      expect(raw).toContain('id="cam"')
      expect(raw).not.toMatch(/tl\.fromTo\("#root"/)

      const filled = raw.replace(/\{\{duration\}\}/g, '30')
      const out = injectTechFx(filled, { durationSec: 30 })
      expect(out).toContain('#cam')
      expect(out).not.toContain('<!--HF_CAM-->')
    })
  }
})
