export interface CopyDoc {
  titles: string[]
  xhsBody: string
  douyinScript: string
  cover: { main: string; sub: string }
  comments: { questions: string[]; replies: string[] }
}

const REQUIRED = ['标题', '小红书正文', '抖音口播脚本', '封面文案', '评论区运营'] as const

function numberedItems(block: string): string[] {
  return block.split('\n')
    .map((l) => l.match(/^\d+[.、]\s*(.+)$/)?.[1]?.trim())
    .filter((s): s is string => !!s)
}

/** 解析 LLM 产物 markdown（mock 与 live 共用）。缺段落抛错，绝不静默出半成品。 */
export function parseCopyOutput(md: string): CopyDoc {
  const sections = new Map<string, string>()
  const parts = md.split(/^## /m).slice(1)
  for (const p of parts) {
    const nl = p.indexOf('\n')
    sections.set(p.slice(0, nl).trim(), p.slice(nl + 1).trim())
  }
  const missing = REQUIRED.filter((k) => !sections.has(k))
  if (missing.length) throw new Error(`产物缺少段落: ${missing.join('、')}`)

  const cover = sections.get('封面文案')!
  const main = cover.match(/主标题[:：]\s*(.+)/)?.[1]?.trim() ?? ''
  const sub = cover.match(/副标题[:：]\s*(.+)/)?.[1]?.trim() ?? ''
  if (!main || !sub) throw new Error('封面文案缺少主标题/副标题')

  const comments = sections.get('评论区运营')!
  const qBlock = comments.split(/### 回复话术/)[0] ?? ''
  const rBlock = comments.split(/### 回复话术/)[1] ?? ''

  return {
    titles: numberedItems(sections.get('标题')!),
    xhsBody: sections.get('小红书正文')!,
    douyinScript: sections.get('抖音口播脚本')!,
    cover: { main, sub },
    comments: { questions: numberedItems(qBlock), replies: numberedItems(rBlock) },
  }
}
