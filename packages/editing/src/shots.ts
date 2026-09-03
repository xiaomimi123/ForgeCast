/**
 * 把「图层列表」折回成剪辑台左栏的分镜列表。派生只读，不改 spec。
 */
import type { Layer, Section, VideoSpec } from '@forgecast/studio'

export interface ShotView {
  sectionId: string
  role: string
  text: string
  startSec: number
  endSec: number
  layerIds: string[]
  rewritable: boolean
}

/**
 * 「重写这段」的支持判定。**必须与 packages/studio/src/rewrite.ts 的 findRewritableTarget 同口径**：
 * section 是纯 text 型（有 text 且无 dialogue/stat/shots），且 from===sectionId && content.kind==='text'
 * 的图层恰好一层。两侧测试用同一组输入数据钉住，改动需两侧同步。
 */
function isRewritable(section: Section, sectionLayers: Layer[]): boolean {
  if (section.text === undefined || section.dialogue || section.stat || section.shots) return false
  return sectionLayers.filter((l) => l.content.kind === 'text').length === 1
}

/**
 * 列表要展示一行文本。**优先取该段唯一文本图层的 content.text**：图层层是渲染真相，
 * `updateLayerText` 按 spec 铁律「改图层不反写语义层」只改图层，此时 section.text 已是旧值，
 * 取它会让左栏分镜列表显示 stale 文案。只有该段没有唯一文本图层（dialogue/stat/shots 段、
 * 或多文本图层拿不准取哪层）时才回落 section 侧内容。
 */
function displayText(section: Section, sectionLayers: Layer[]): string {
  const textLayers = sectionLayers.filter((l) => l.content.kind === 'text')
  if (textLayers.length === 1) {
    const content = textLayers[0].content
    if (content.kind === 'text') return content.text
  }
  if (section.text !== undefined) return section.text
  if (section.items?.length) return section.items.join(' / ')
  if (section.dialogue?.length) return section.dialogue.map((d) => d.text).join(' / ')
  if (section.stat) return `${section.stat.value} ${section.stat.label}`
  if (section.shots?.length) return section.shots.join(' / ')
  return ''
}

export function deriveShots(spec: VideoSpec): ShotView[] {
  const shots: ShotView[] = []
  for (const section of spec.semantic.sections) {
    // from 为 null 的手工图层不属于任何段，自然被这一步排除
    const layers = spec.layers.filter((l) => l.from === section.id)
    if (layers.length === 0) continue // 无图层的段不出现在分镜列表里
    shots.push({
      sectionId: section.id,
      role: section.role,
      text: displayText(section, layers),
      startSec: Math.min(...layers.map((l) => l.start)),
      endSec: Math.max(...layers.map((l) => l.start + l.duration)),
      layerIds: layers.map((l) => l.id),
      rewritable: isRewritable(section, layers),
    })
  }
  return shots
}
