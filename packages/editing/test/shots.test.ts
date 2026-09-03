import { describe, expect, it } from 'vitest'
import type { VideoSpec } from '@forgecast/studio'
// 值导入（不是 import type）：这条跨包断言是两份 rewritable 判定之间唯一的真钉子。
// no-node-deps 守卫只扫 src/，测试里的值导入不违规；@forgecast/studio 已是 devDependency。
import { findRewritableTarget } from '@forgecast/studio'
import { deriveShots } from '../src/shots'
import { updateLayerText } from '../src/ops'
import { baseSpec, captionLayer, textLayer } from './fixtures'

describe('deriveShots', () => {
  it('按 sections 顺序输出；时间取 min start / max end；layerIds 齐全', () => {
    const spec = baseSpec({
      semantic: {
        hook: null, sourceAssetId: null,
        sections: [
          { id: 'sec-b', role: 'body', text: 'B' },
          { id: 'sec-a', role: 'hook', text: 'A' },
        ],
      },
      layers: [
        textLayer({ id: 'a1', from: 'sec-a', start: 1, duration: 2, content: { kind: 'text', text: 'A' } }),   // [1,3)
        textLayer({ id: 'b1', from: 'sec-b', start: 6, duration: 1, content: { kind: 'text', text: 'B' } }),   // [6,7)
        captionLayer({ id: 'b2', from: 'sec-b', start: 4, duration: 1 }), // [4,5)
      ],
    })
    const shots = deriveShots(spec)
    expect(shots.map((s) => s.sectionId)).toEqual(['sec-b', 'sec-a']) // 顺序=sections 顺序，不是时间顺序
    expect(shots[0]).toMatchObject({ role: 'body', text: 'B', startSec: 4, endSec: 7, layerIds: ['b1', 'b2'] })
    expect(shots[1]).toMatchObject({ role: 'hook', text: 'A', startSec: 1, endSec: 3, layerIds: ['a1'] })
  })

  it('无图层的段跳过', () => {
    const spec = baseSpec({
      semantic: {
        hook: null, sourceAssetId: null,
        sections: [{ id: 'sec-hook', role: 'hook', text: 'A' }, { id: 'sec-empty', role: 'body', text: '空' }],
      },
      layers: [textLayer({ from: 'sec-hook' })],
    })
    expect(deriveShots(spec).map((s) => s.sectionId)).toEqual(['sec-hook'])
  })

  it('from 为 null 的手工图层不归入任何段', () => {
    const spec = baseSpec({
      semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-hook', role: 'hook', text: 'A' }] },
      layers: [textLayer({ from: 'sec-hook' }), textLayer({ id: 'manual', from: null, start: 9, duration: 2 })],
    })
    const shots = deriveShots(spec)
    expect(shots).toHaveLength(1)
    expect(shots[0].layerIds).toEqual(['l-hook'])
    expect(shots[0].endSec).toBe(3)
  })

  // 判定与 packages/studio/src/rewrite.ts 的 findRewritableTarget 同口径：
  // text 段（有 text 且无 dialogue/stat/shots）且 from===sectionId && content.kind==='text' 的图层恰一层。
  // 下面三态的输入数据抄自 packages/studio/test/rewrite.test.ts，两侧用同一组数据，任一侧口径漂移都会红。
  describe('rewritable 三态（与 studio findRewritableTarget 同口径）', () => {
    it('text 段 + 单文本图层（同段还有 caption 图层不影响）→ true', () => {
      const shots = deriveShots(baseSpec())
      expect(shots.find((s) => s.sectionId === 'sec-hook')!.rewritable).toBe(true)
    })

    it('dialogue 段 → false', () => {
      const spec = baseSpec({
        semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-d', role: 'body', dialogue: [{ who: 'them', text: 'hi' }] }] },
        layers: [textLayer({ from: 'sec-d' })],
      })
      expect(deriveShots(spec)[0].rewritable).toBe(false)
    })

    it('stat / shots 段 → false', () => {
      const statSpec = baseSpec({
        semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-s', role: 'stat', stat: { value: '10x', label: 'x' } }] },
        layers: [textLayer({ from: 'sec-s' })],
      })
      expect(deriveShots(statSpec)[0].rewritable).toBe(false)
      const shotsSpec = baseSpec({
        semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-sh', role: 'demo', shots: ['a.png'] }] },
        layers: [textLayer({ from: 'sec-sh' })],
      })
      expect(deriveShots(shotsSpec)[0].rewritable).toBe(false)
    })

    it('text 段但文本图层两层 → false', () => {
      const spec = baseSpec({
        semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-hook', role: 'hook', text: '原文案' }] },
        layers: [textLayer({ id: 'l1' }), textLayer({ id: 'l2' })],
      })
      expect(deriveShots(spec)[0].rewritable).toBe(false)
    })

    it('段只有 caption 图层（零文本图层）→ false', () => {
      const spec = baseSpec({
        semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-hook', role: 'hook', text: '原文案' }] },
        layers: [captionLayer()],
      })
      expect(deriveShots(spec)[0].rewritable).toBe(false)
    })
  })

  describe('rewritable 与 studio findRewritableTarget 交叉断言（真钉子）', () => {
    /** studio 侧判定：不抛 = 支持重写。两份实现任何一侧漂移，下面的等值断言就红。 */
    const studioSaysRewritable = (spec: VideoSpec, sectionId: string): boolean => {
      try {
        findRewritableTarget(spec, sectionId)
        return true
      } catch {
        return false
      }
    }

    const cases: Array<[name: string, spec: VideoSpec, sectionId: string]> = [
      ['text 段 + 单文本图层', baseSpec(), 'sec-hook'],
      [
        'dialogue 段',
        baseSpec({
          semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-d', role: 'body', dialogue: [{ who: 'them', text: 'hi' }] }] },
          layers: [textLayer({ from: 'sec-d' })],
        }),
        'sec-d',
      ],
      [
        'text 段 + 双文本图层',
        baseSpec({
          semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-hook', role: 'hook', text: '原文案' }] },
          layers: [textLayer({ id: 'l1' }), textLayer({ id: 'l2' })],
        }),
        'sec-hook',
      ],
      [
        'stat 段',
        baseSpec({
          semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-s', role: 'stat', stat: { value: '10x', label: 'x' } }] },
          layers: [textLayer({ from: 'sec-s' })],
        }),
        'sec-s',
      ],
      [
        '段内零文本图层（只有 caption）',
        baseSpec({
          semantic: { hook: null, sourceAssetId: null, sections: [{ id: 'sec-hook', role: 'hook', text: '原文案' }] },
          layers: [captionLayer()],
        }),
        'sec-hook',
      ],
    ]

    for (const [name, spec, sectionId] of cases) {
      it(`${name}：editing 的 rewritable === studio 判定`, () => {
        const shot = deriveShots(spec).find((s) => s.sectionId === sectionId)!
        expect(shot.rewritable).toBe(studioSaysRewritable(spec, sectionId))
      })
    }
  })

  describe('text 取图层真相（改图层不反写语义层，列表不能 stale）', () => {
    it('updateLayerText 改字后，deriveShots 的 text 是新值而不是 section.text', () => {
      const spec = baseSpec()
      const out = updateLayerText(spec, 'l-hook', '新文案')
      expect(out.semantic.sections[0].text).toBe('原文案') // 铁律：语义层不被反写
      const shot = deriveShots(out).find((s) => s.sectionId === 'sec-hook')!
      expect(shot.text).toBe('新文案')
    })

    it('dialogue 段（无唯一文本图层来源）仍显示 section 侧内容', () => {
      const spec = baseSpec({
        semantic: {
          hook: null, sourceAssetId: null,
          sections: [{ id: 'sec-d', role: 'body', dialogue: [{ who: 'them', text: '你好' }, { who: 'me', text: '在' }] }],
        },
        layers: [captionLayer({ from: 'sec-d' })],
      })
      expect(deriveShots(spec)[0].text).toBe('你好 / 在')
    })
  })

  it('非 text 段的 text 字段兜底：items / dialogue / stat 有可读文本', () => {
    const spec = baseSpec({
      semantic: {
        hook: null, sourceAssetId: null,
        sections: [
          { id: 'sec-i', role: 'body', items: ['一', '二'] },
          { id: 'sec-d', role: 'body', dialogue: [{ who: 'them', text: '你好' }, { who: 'me', text: '在' }] },
          { id: 'sec-s', role: 'stat', stat: { value: '10x', label: '提速' } },
        ],
      },
      layers: [
        captionLayer({ id: 'i', from: 'sec-i' }), captionLayer({ id: 'd', from: 'sec-d' }), captionLayer({ id: 's', from: 'sec-s' }),
      ],
    })
    const shots = deriveShots(spec)
    expect(shots[0].text).toBe('一 / 二')
    expect(shots[1].text).toBe('你好 / 在')
    expect(shots[2].text).toBe('10x 提速')
  })
})
