import type Database from 'better-sqlite3'
import { getAllSettings, setSettings, type CoreCtx } from '@forgecast/core'
import { scoutCandidates } from '@forgecast/scout'

type ScoutFn = (ctx: CoreCtx, opts: { onlyNew: boolean }) => Promise<{ found: number; scored: number; rejected: number; added: number }>

export interface AutoScoutCfg { enabled: boolean; time: string; lastRunDate: string }

/** 本地时区 YYYY-MM-DD（sv-SE 格式恰好是 ISO 日期样式） */
export function localDate(d: Date): string {
  return d.toLocaleDateString('sv-SE')
}

export function readAutoScoutCfg(db: Database.Database): AutoScoutCfg {
  const s = getAllSettings(db)
  return {
    enabled: (s.auto_scout ?? 'on') !== 'off',
    time: /^\d{1,2}:\d{2}$/.test(s.auto_scout_time ?? '') ? s.auto_scout_time! : '08:00',
    lastRunDate: s.auto_scout_last_run ?? '',
  }
}

/** 今天（本地日期）还没跑 && 已过设定时间 → 该跑。server 启动时也用它判定，天然支持当天补跑。 */
export function shouldAutoScout(now: Date, cfg: AutoScoutCfg): boolean {
  if (!cfg.enabled) return false
  if (cfg.lastRunDate === localDate(now)) return false
  const [h, m] = cfg.time.split(':').map(Number)
  const target = new Date(now)
  target.setHours(h || 0, m || 0, 0, 0)
  return now >= target
}

/** 跑一次每日抓取（onlyNew）。失败也把 last_run 标为今天——整天每分钟重试只会连续打限流，次日再试。 */
export async function runAutoScout(ctx: CoreCtx, scout: ScoutFn = scoutCandidates): Promise<void> {
  const started = new Date()
  try {
    const r = await scout(ctx, { onlyNew: true })
    setSettings(ctx.db, {
      auto_scout_last_run: localDate(started),
      auto_scout_last_result: JSON.stringify({ at: started.toISOString(), ...r }),
    })
    console.log(`[forgecast] 每日自动抓取完成：发现 ${r.found}，新增 ${r.added}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setSettings(ctx.db, {
      auto_scout_last_run: localDate(started),
      auto_scout_last_result: JSON.stringify({ at: started.toISOString(), error: msg }),
    })
    console.log(`[forgecast] ⚠ 每日自动抓取失败：${msg}（明天自动重试）`)
  }
}

/** 启动调度：立即判定一次（补跑）+ 每 intervalMs 判定。返回停止函数。 */
export function startAutoScout(ctx: CoreCtx, opts: { intervalMs?: number; scout?: ScoutFn } = {}): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    if (!shouldAutoScout(new Date(), readAutoScoutCfg(ctx.db))) return
    running = true
    try { await runAutoScout(ctx, opts.scout) } finally { running = false }
  }
  void tick()
  const timer = setInterval(() => { void tick() }, opts.intervalMs ?? 60_000)
  timer.unref?.()
  return () => clearInterval(timer)
}
