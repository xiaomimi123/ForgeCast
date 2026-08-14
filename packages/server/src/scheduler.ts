import type Database from 'better-sqlite3'
import { getAllSettings, setSettings, type CoreCtx } from '@forgecast/core'
import { cleanupCandidates, scoutCandidates } from '@forgecast/scout'

type ScoutFn = (ctx: CoreCtx, opts: { onlyNew: boolean }) => Promise<{ found: number; scored: number; rejected: number; added: number }>
type CleanupFn = (ctx: CoreCtx, opts: { threshold?: number }) => Promise<{ rescored: number; dismissed: number }>

export interface AutoScoutCfg { enabled: boolean; time: string; lastRunDate: string }

/** 本地时区 YYYY-MM-DD（sv-SE 格式恰好是 ISO 日期样式） */
export function localDate(d: Date): string {
  return d.toLocaleDateString('sv-SE')
}

export function readAutoScoutCfg(db: Database.Database): AutoScoutCfg {
  const s = getAllSettings(db)
  return {
    enabled: (s.auto_scout ?? 'on') !== 'off',
    // 小时 0-23、分钟 0-59；越界（如 25:00 / 12:99）会让 setHours 滚到次日导致永不触发，需回落默认值
    time: /^([01]?\d|2[0-3]):[0-5]\d$/.test(s.auto_scout_time ?? '') ? s.auto_scout_time! : '08:00',
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

/** 跑一次每日抓取（onlyNew）+ 低分候选自动清理。失败也把 last_run 标为今天——整天每分钟重试只会连续打限流，次日再试。
 *  清理阶段单独 try/catch：清理失败不能掩盖抓取本身的成功结果，last_result 里 found/added 等字段始终保留，
 *  清理失败只追加 cleanupError。 */
export async function runAutoScout(
  ctx: CoreCtx,
  scout: ScoutFn = scoutCandidates,
  cleanup: CleanupFn = cleanupCandidates,
): Promise<void> {
  const started = new Date()
  try {
    const r = await scout(ctx, { onlyNew: true })
    let cleanupResult: { rescored: number; dismissed: number } | { cleanupError: string }
    try {
      cleanupResult = await cleanup(ctx, { threshold: 50 })
    } catch (err) {
      cleanupResult = { cleanupError: err instanceof Error ? err.message : String(err) }
    }
    setSettings(ctx.db, {
      auto_scout_last_run: localDate(started),
      auto_scout_last_result: JSON.stringify({ at: started.toISOString(), ...r, ...cleanupResult }),
    })
    console.log(`[forgecast] 每日自动抓取完成：发现 ${r.found}，新增 ${r.added}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setSettings(ctx.db, {
      auto_scout_last_run: localDate(started),
      auto_scout_last_result: JSON.stringify({ at: started.toISOString(), error: msg }),
    })
    console.error(`[forgecast] ⚠ 每日自动抓取失败：${msg}（明天自动重试）`)
  }
}

/** 启动调度：立即判定一次（补跑）+ 每 intervalMs 判定。返回停止函数。 */
export function startAutoScout(ctx: CoreCtx, opts: { intervalMs?: number; scout?: ScoutFn } = {}): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    // 整个 tick 体包一层 try/catch：readAutoScoutCfg（DB 读取）和 runAutoScout 失败分支里的
    // setSettings 都可能抛错，任一处抛出都会变成 unhandled rejection，Node 22 默认直接崩掉整个进程。
    // 每 60s 一次 interval，这里必须兜住，绝不向外抛。
    try {
      if (!shouldAutoScout(new Date(), readAutoScoutCfg(ctx.db))) return
      running = true
      try { await runAutoScout(ctx, opts.scout) } finally { running = false }
    } catch (err) {
      console.error('[forgecast] ⚠ 自动抓取调度异常:', err)
    }
  }
  void tick()
  const timer = setInterval(() => { void tick() }, opts.intervalMs ?? 60_000)
  timer.unref?.()
  return () => clearInterval(timer)
}
