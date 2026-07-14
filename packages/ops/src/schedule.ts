import type { CoreCtx } from '@forgecast/core'

const HOOK_CATEGORY: Record<string, 'demo' | 'income'> = {
  pain: 'demo', infogap: 'demo', story: 'income', sideline: 'income',
}
const DAY = 864e5

export interface CalendarView {
  date: string
  publishedToday: number
  remainingToday: number
  inventory: Record<string, number>
  cooldown: Record<string, number> // 钩子 → 还需冷却几天
  mix: { demo: number; income: number; targetDemo: number; targetIncome: number }
  suggestions: Array<{ hook: string; assetId: number; reason: string }>
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

  // 近 7 天已发按类别
  const since = now.getTime() - 7 * DAY
  let demo = 0
  let income = 0
  for (const a of published) {
    if (toMs(a.published_at) >= since) {
      const c = HOOK_CATEGORY[a.hook]
      if (c === 'demo') demo++
      else if (c === 'income') income++
    }
  }
  const recentTotal = demo + income
  const demoUnder = recentTotal === 0 ? true : demo / recentTotal < 0.6

  const eligibleHooks = Object.keys(inventory).filter((h) => inventory[h] > 0 && !(h in cooldown))
  eligibleHooks.sort((x, y) => {
    // 欠缺类别优先（0 排前）
    const pref = (h: string) => {
      const isDemo = HOOK_CATEGORY[h] === 'demo'
      return (demoUnder ? isDemo : !isDemo) ? 0 : 1
    }
    if (pref(x) !== pref(y)) return pref(x) - pref(y)
    return (lastPub[x] ?? 0) - (lastPub[y] ?? 0) // 最久未发优先
  })

  const suggestions = eligibleHooks.slice(0, remainingToday).map((h) => {
    const asset = ctx.db.prepare(
      "SELECT id FROM assets WHERE status = 'approved' AND hook = ? AND type IN ('copy','video') ORDER BY id LIMIT 1",
    ).get(h) as { id: number }
    const last = lastPub[h]
    const when = last ? `上次发布 ${Math.floor((now.getTime() - last) / DAY)} 天前` : '从未发布'
    return { hook: h, assetId: asset.id, reason: `${h} 库存 ${inventory[h]} 条、${when}、${HOOK_CATEGORY[h] ?? '其它'} 类` }
  })

  return {
    date: dayStr,
    publishedToday,
    remainingToday,
    inventory,
    cooldown,
    mix: { demo, income, targetDemo: 0.6, targetIncome: 0.2 },
    suggestions,
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
