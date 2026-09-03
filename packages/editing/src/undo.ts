/** 剪辑台的撤销栈。VideoSpec 本身按不可变方式更新，历史只存引用，不做深拷贝。 */
import type { VideoSpec } from '@forgecast/studio'

export interface History { past: VideoSpec[]; present: VideoSpec; future: VideoSpec[] }

/** 默认上限：一次剪辑会话攒 50 步足够，再多是白占内存（每步一整份 spec 引用树）。 */
export const DEFAULT_CAP = 50

export function init(spec: VideoSpec): History {
  return { past: [], present: spec, future: [] }
}

/** 提交一次新状态：present 入 past（超 cap 丢最旧），future 清空（撤销后又改 = 重开分支）。 */
export function push(h: History, next: VideoSpec, cap = DEFAULT_CAP): History {
  const past = [...h.past, h.present]
  return { past: past.slice(Math.max(0, past.length - cap)), present: next, future: [] }
}

/** past 空时原样返回（同一引用），调用方据此禁用按钮，不用 try/catch。 */
export function undo(h: History): History {
  if (h.past.length === 0) return h
  const past = h.past.slice(0, -1)
  return { past, present: h.past[h.past.length - 1], future: [h.present, ...h.future] }
}

export function redo(h: History): History {
  if (h.future.length === 0) return h
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }
}
