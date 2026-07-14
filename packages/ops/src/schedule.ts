import type { CoreCtx } from '@forgecast/core'

type Category = 'demo' | 'income' | 'process'
// 内容配比三类（开发文档 §5.2）：产品演示 60% / 收入接单 20% / 开发过程碎片 20%
const HOOK_CATEGORY: Record<string, Category> = {
  pain: 'demo', infogap: 'demo', story: 'income', sideline: 'income', process: 'process',
}
const TARGET: Record<Category, number> = { demo: 0.6, income: 0.2, process: 0.2 }
const CATEGORY_LABEL: Record<Category, string> = { demo: '产品演示', income: '收入/接单', process: '开发过程碎片' }
const DAY = 864e5

function category(hook: string | null): Category | null {
  return hook ? (HOOK_CATEGORY[hook] ?? null) : null
}

export interface CalendarView {
  date: string
  publishedToday: number
  remainingToday: number
  inventory: Record<string, number>
  cooldown: Record<string, number> // 钩子 → 还需冷却几天
  mix: { demo: number; income: number; process: number; targetDemo: number; targetIncome: number; targetProcess: number }
  suggestions: Array<{ hook: string; assetId: number; reason: string }>
  gaps: string[] // 配比缺口提示：低于目标且无库存的类别（"缺哪类提示补哪类"）
}

// sqlite datetime('now') 形如 'YYYY-MM-DD HH:MM:SS'（UTC）→ 毫秒
function toMs(s: string | null): number {
  if (!s) return Number.NaN
  return Date.parse(s.replace(' ', 'T') + 'Z')
}

/** 排期建议：≤2条/天、同钩子≥3天、配比欠缺类别优先（纯函数，now 可注入） */
export function calendarSuggestions(ctx: CoreCtx, now: Date = new Date()): CalendarView {
  const dayStr = now.toISOString().slice(0, 10)
  const published = ctx.db.prepare(
    "SELECT id, hook, published_at FROM assets WHERE status = 'published' AND published_at IS NOT NULL AND type IN ('copy','video')",
  ).all() as Array<{ id: number; hook: string; published_at: string }>
  const publishedToday = published.filter((a) => (a.published_at ?? '').slice(0, 10) === dayStr).length
  const remainingToday = Math.max(0, 2 - publishedToday)

  const approved = ctx.db.prepare(
    "SELECT id, hook FROM assets WHERE status = 'approved' AND type IN ('copy','video')",
  ).all() as Array<{ id: number; hook: string }>
  const inventory: Record<string, number> = {}
  for (const a of approved) inventory[a.hook ?? 'unknown'] = (inventory[a.hook ?? 'unknown'] ?? 0) + 1

  const lastPub: Record<string, number> = {}
  for (const a of published) {
    const t = toMs(a.published_at)
    if (!Number.isNaN(t) && (lastPub[a.hook] === undefined || t > lastPub[a.hook])) lastPub[a.hook] = t
  }
  const cooldown: Record<string, number> = {}
  for (const [hook, t] of Object.entries(lastPub)) {
    const days = (now.getTime() - t) / DAY
    if (days < 3) cooldown[hook] = Math.ceil(3 - days)
  }

  // 近 7 天已发按三类计数
  const since = now.getTime() - 7 * DAY
  const recent: Record<Category, number> = { demo: 0, income: 0, process: 0 }
  for (const a of published) {
    if (toMs(a.published_at) >= since) {
      const c = category(a.hook)
      if (c) recent[c]++
    }
  }
  const recentTotal = recent.demo + recent.income + recent.process
  const share = (c: Category) => (recentTotal === 0 ? 0 : recent[c] / recentTotal)
  const deficit = (c: Category) => TARGET[c] - share(c) // >0 = 低于目标

  const eligibleHooks = Object.keys(inventory).filter((h) => inventory[h] > 0 && !(h in cooldown))
  eligibleHooks.sort((x, y) => {
    const cx = category(x)
    const cy = category(y)
    const dx = cx ? deficit(cx) : -1
    const dy = cy ? deficit(cy) : -1
    if (dx !== dy) return dy - dx // 缺口大的类别优先
    return (lastPub[x] ?? 0) - (lastPub[y] ?? 0) // 最久未发优先
  })

  const suggestions = eligibleHooks.slice(0, remainingToday).map((h) => {
    const asset = ctx.db.prepare(
      "SELECT id FROM assets WHERE status = 'approved' AND hook = ? AND type IN ('copy','video') ORDER BY id LIMIT 1",
    ).get(h) as { id: number }
    const last = lastPub[h]
    const when = last ? `上次发布 ${Math.floor((now.getTime() - last) / DAY)} 天前` : '从未发布'
    const c = category(h)
    return { hook: h, assetId: asset.id, reason: `${h} 库存 ${inventory[h]} 条、${when}、${c ? CATEGORY_LABEL[c] : '其它'} 类` }
  })

  // 配比缺口：低于目标且该类别无审核通过库存 → 提示补哪类（process 需人工录屏 + clip add 登记）
  const invByCat: Record<Category, number> = { demo: 0, income: 0, process: 0 }
  for (const [h, n] of Object.entries(inventory)) {
    const c = category(h)
    if (c) invByCat[c] += n
  }
  const gaps: string[] = []
  for (const c of ['demo', 'income', 'process'] as Category[]) {
    if (deficit(c) > 0 && invByCat[c] === 0) {
      const tail = c === 'process' ? '：去录一条 Claude Code 过程碎片并 forgecast clip add 登记' : '，去补该类素材'
      gaps.push(`${CATEGORY_LABEL[c]} 占比 ${Math.round(share(c) * 100)}% < 目标 ${Math.round(TARGET[c] * 100)}%、无库存${tail}`)
    }
  }

  return {
    date: dayStr,
    publishedToday,
    remainingToday,
    inventory,
    cooldown,
    mix: {
      demo: recent.demo, income: recent.income, process: recent.process,
      targetDemo: 0.6, targetIncome: 0.2, targetProcess: 0.2,
    },
    suggestions,
    gaps,
  }
}

export interface WeeklyReport {
  since: string
  perHook: Record<string, { published: number; leads: number }>
  totals: { published: number; leads: number }
}

/** 各钩子转化周报：发布数 + 询单数（since 默认 7 天前 ISO 日期） */
export function weeklyReport(ctx: CoreCtx, since?: string): WeeklyReport {
  const sinceStr = since ?? new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10)
  const perHook: Record<string, { published: number; leads: number }> = {}
  const bump = (hook: string | null, k: 'published' | 'leads') => {
    const key = hook ?? 'unknown'
    perHook[key] = perHook[key] ?? { published: 0, leads: 0 }
    perHook[key][k]++
  }
  const pub = ctx.db.prepare(
    "SELECT hook FROM assets WHERE status = 'published' AND date(published_at) >= date(?) AND type IN ('copy','video')",
  ).all(sinceStr) as Array<{ hook: string }>
  for (const a of pub) bump(a.hook, 'published')
  const leadRows = ctx.db.prepare(`
    SELECT a.hook AS hook FROM leads l JOIN assets a ON a.id = l.asset_id
    WHERE date(l.created_at) >= date(?)
  `).all(sinceStr) as Array<{ hook: string }>
  for (const l of leadRows) bump(l.hook, 'leads')
  const totals = Object.values(perHook).reduce(
    (acc, v) => ({ published: acc.published + v.published, leads: acc.leads + v.leads }),
    { published: 0, leads: 0 },
  )
  return { since: sinceStr, perHook, totals }
}
