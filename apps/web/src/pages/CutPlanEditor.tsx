import { useEffect, useState } from 'react'
import { api } from '../api'

type Cut = { beat: number; shot: number }
type Plan = { bgm: string; grid: { t0: number; T: number; bpm: number; strongBeats: number[]; duration: number }; cadence: number; offsetSec: number; cuts: Cut[]; shots?: { rel: string }[] }

function cutTime(p: Plan, c: Cut) { return p.grid.t0 + p.offsetSec + c.beat * p.grid.T }
// api() 失败抛 "400: {\"error\":\"...\"}"，抽出后端的 error 文案，避免把原始状态码+JSON 串直接显给用户
function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const i = m.indexOf('{')
  if (i >= 0) { try { const j = JSON.parse(m.slice(i)); if (j?.error) return j.error } catch { /* 非 JSON，原样 */ } }
  return m
}

export default function CutPlanEditor({ slug }: { slug: string }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  // 挂载时载入已保存方案（否则保存后重开页面会丢，且再点分析会重置）
  useEffect(() => {
    api<Plan | null>(`/api/projects/${slug}/cutplan`).then((p) => { if (p) { setPlan(p); setMsg('已载入保存的方案') } }).catch(() => {})
  }, [slug])

  async function analyze() {
    setBusy(true); setMsg('分析节拍中…')
    try {
      const p = await api<Plan>(`/api/projects/${slug}/cutplan/analyze`, { method: 'POST', body: '{}' })
      setPlan(p); setMsg(`已分析：${p.grid.bpm.toFixed(1)} BPM，${p.cuts.length} 刀`)
    } catch (e) { setMsg('⚠ ' + errMsg(e)) } // 后端错误（无 librosa/无截图/无曲）经 api() 抛出，走这里
    setBusy(false)
  }
  // 改 cadence：本地重算 cuts（窗口 [6, duration-6]）
  function setCadence(cad: number) {
    if (!plan) return
    const { t0, T, duration } = plan.grid
    const carStart = 6, carEnd = Math.max(7, duration - 6)
    const nStart = Math.max(0, Math.ceil((carStart - t0) / T - 1e-9))
    const cuts: Cut[] = []; let k = 0
    for (let n = nStart; t0 + n * T < carEnd; n += cad) { cuts.push({ beat: n, shot: k % (plan.shots?.length || 1) }); k++ }
    setPlan({ ...plan, cadence: cad, cuts })
  }
  function nudge(i: number, dir: 1 | -1) {
    if (!plan) return
    const cuts = plan.cuts.map((c) => ({ ...c }))
    const next = cuts[i].beat + dir
    const lo = i > 0 ? cuts[i - 1].beat + 1 : 0
    const hi = i < cuts.length - 1 ? cuts[i + 1].beat - 1 : Number.MAX_SAFE_INTEGER
    cuts[i].beat = Math.max(lo, Math.min(hi, next)) // 钳制不越邻刀
    setPlan({ ...plan, cuts })
  }
  function setShot(i: number, shot: number) {
    if (!plan) return
    const cuts = plan.cuts.map((c, j) => (j === i ? { ...c, shot } : c)); setPlan({ ...plan, cuts })
  }
  async function save() {
    if (!plan) return
    setBusy(true)
    try { await api(`/api/projects/${slug}/cutplan`, { method: 'PUT', body: JSON.stringify({ plan }) }); setMsg('已保存，生成视频时按此方案') }
    catch (e) { setMsg('⚠ 保存失败：' + errMsg(e)) }
    setBusy(false)
  }
  async function clear() {
    setBusy(true)
    try { await api(`/api/projects/${slug}/cutplan`, { method: 'DELETE' }); setPlan(null); setMsg('已清除，恢复自动卡点') }
    catch (e) { setMsg('⚠ ' + errMsg(e)) }
    setBusy(false)
  }

  return (
    <section className="space-y-3 rounded-lg border bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">卡点编辑（demo）</h3>
        <button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={busy} onClick={analyze}>{plan ? '重新分析' : '分析卡点'}</button>
      </div>
      {msg && <div className="text-xs text-neutral-600">{msg}</div>}
      {plan && (
        <>
          <div className="text-xs text-neutral-500">曲子：{plan.bgm}</div>
          {/* busy（分析/保存/清除在途）时禁用细控件，避免请求返回后 setPlan 覆盖掉这期间的本地编辑 */}
          <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label>每几拍切
                <select className="ml-1 rounded border px-2 py-1" value={plan.cadence} onChange={(e) => setCadence(Number(e.target.value))}>
                  <option value={2}>2 拍</option><option value={4}>4 拍</option><option value={8}>8 拍</option>
                </select>
              </label>
              <label className="flex items-center gap-2">整体偏移 {plan.offsetSec.toFixed(2)}s
                <input type="range" min={-0.3} max={0.3} step={0.02} value={plan.offsetSec} onChange={(e) => setPlan({ ...plan, offsetSec: Number(e.target.value) })} />
              </label>
            </div>
            {/* 节拍刻度条：每刀落点按时间比例定位 */}
            <div className="relative h-8 rounded bg-neutral-100">
              {plan.cuts.map((c, i) => (
                <div key={i} title={`#${i + 1} ${cutTime(plan, c).toFixed(2)}s 图${c.shot + 1}`}
                  className="absolute top-0 h-8 w-0.5 bg-blue-500"
                  style={{ left: `${(cutTime(plan, c) / plan.grid.duration) * 100}%` }} />
              ))}
            </div>
            {/* 卡点列表 */}
            <div className="max-h-72 space-y-1 overflow-auto text-sm">
              {plan.cuts.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-8 text-neutral-400">#{i + 1}</span>
                  <span className="w-16 tabular-nums">{cutTime(plan, c).toFixed(2)}s</span>
                  <select className="rounded border px-1 py-0.5" value={c.shot} onChange={(e) => setShot(i, Number(e.target.value))}>
                    {(plan.shots || []).map((s, si) => <option key={si} value={si}>图{si + 1}</option>)}
                  </select>
                  <button className="rounded border px-2" onClick={() => nudge(i, -1)}>←</button>
                  <button className="rounded border px-2" onClick={() => nudge(i, 1)}>→</button>
                </div>
              ))}
            </div>
          </fieldset>
          <div className="flex gap-2">
            <button className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white disabled:opacity-50" disabled={busy} onClick={save}>保存方案</button>
            <button className="rounded border px-4 py-1.5 text-sm disabled:opacity-50" disabled={busy} onClick={clear}>清除(回自动)</button>
          </div>
        </>
      )}
    </section>
  )
}
