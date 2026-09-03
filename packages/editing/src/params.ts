/** 参数抽屉「改动 N 项」的数据源。只比 spec §10 的可改集三项，其余字段的差异一律不算。 */
import type { VideoSpec } from '@forgecast/studio'

export function paramsDiff(
  saved: VideoSpec,
  draft: { bgVariant?: string; bgmSrc?: string | null; mood?: string | null },
): Array<{ key: string; from: unknown; to: unknown }> {
  const out: Array<{ key: string; from: unknown; to: unknown }> = []
  const savedValues: Array<[key: string, from: unknown]> = [
    ['bgVariant', saved.bgVariant],
    ['bgmSrc', saved.audio.bgm?.src ?? null],
    ['mood', saved.audio.bgm?.mood ?? null],
  ]
  for (const [key, from] of savedValues) {
    // draft 里没有这个键 = 用户没编辑过它，不是「改成了 undefined」
    const to = (draft as Record<string, unknown>)[key]
    if (to === undefined) continue
    if (to !== from) out.push({ key, from, to })
  }
  return out
}
