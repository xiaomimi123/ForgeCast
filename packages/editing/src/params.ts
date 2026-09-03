/** 参数抽屉「改动 N 项」的数据源。只比 spec §10 的可改集三项，其余字段的差异一律不算。 */
import type { VideoSpec } from '@forgecast/studio'

export function paramsDiff(
  saved: VideoSpec,
  // mood 回到可改集（P2）：换情绪走服务端 pick-bgm 重选曲 + 重析节拍，不再是只写不读。
  draft: { bgVariant?: string; bgmSrc?: string | null; mood?: string },
  /**
   * `saved.audio.bgm.src` 落盘时是绝对路径，draft.bgmSrc 是曲库相对名（下拉 option 的值）——
   * 两个空间直接比较，「选中当前正在用的那首」也会被误判成改动。
   * 调用方（InspectorPane）已经有 `relOfBgmSrc` 能把绝对路径反解回相对名，这里不重复依赖路径
   * 工具（保持 params.ts 是不碰文件系统/路径格式的纯函数，方便脱离浏览器环境单测），
   * 改成让调用方把归一化后的相对名传进来；不传时退回原始 src（旧调用点/测试未升级时行为不变）。
   */
  savedBgmRel?: string | null,
): Array<{ key: string; from: unknown; to: unknown }> {
  const out: Array<{ key: string; from: unknown; to: unknown }> = []
  const savedBgmSrc = savedBgmRel !== undefined ? savedBgmRel : (saved.audio.bgm?.src ?? null)
  const savedValues: Array<[key: string, from: unknown]> = [
    ['bgVariant', saved.bgVariant],
    ['bgmSrc', savedBgmSrc],
    ['mood', saved.audio.bgm?.mood ?? null],
  ]
  for (const [key, from] of savedValues) {
    // draft 里没有这个键 = 用户没编辑过它，不是「改成了 undefined」
    let to = (draft as Record<string, unknown>)[key]
    if (to === undefined) continue
    // mood 的下拉「自动」选项值是 ''，saved 侧没有 mood 时是 null——两者语义相同（都是
    // 「不指定，服务端按钩子情绪挑」），不归一的话「选了别的情绪又选回自动」圆点清不掉，
    // 用户点重渲会以空 mood 打 pick-bgm，静默换一次曲、重析一次节拍。
    if (key === 'mood' && to === '') to = null
    if (to !== from) out.push({ key, from, to })
  }
  return out
}
