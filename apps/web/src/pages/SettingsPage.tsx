import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, getBrandKit, putBrandKit, type AutoScoutStatus, type BrandKitView, type Project, type SettingsView } from '../api'

// 可编辑草稿：key 字段留空=不改（占位显示已存打码值）
interface Draft {
  llm_mode: string; llm_key: string; llm_base_url: string
  model_analysis: string; model_copy: string; model_scoring: string
  tts_mode: string; tts_key: string; tts_base_url: string; tts_model: string; tts_voice: string; melo_python: string; cosy_home: string
  github_mode: string; github_token: string
  scout_weight_rebrand: string; scout_weight_buyer: string; scout_weight_visual: string
}
const emptyDraft: Draft = {
  llm_mode: 'mock', llm_key: '', llm_base_url: '', model_analysis: '', model_copy: '', model_scoring: '',
  tts_mode: 'kokoro', tts_key: '', tts_base_url: '', tts_model: '', tts_voice: '', melo_python: '', cosy_home: '', github_mode: 'mock', github_token: '',
  scout_weight_rebrand: '30', scout_weight_buyer: '40', scout_weight_visual: '30',
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-sub">{label}{hint && <span className="ml-1 font-normal text-faint">{hint}</span>}</div>
      {children}
    </label>
  )
}
const inputCls = 'w-full rounded-md border-[1.5px] border-ink bg-card px-2 py-1.5 text-sm'

export default function SettingsPage() {
  const qc = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsView>('/api/settings') })
  const [d, setD] = useState<Draft>(emptyDraft)
  const [saved, setSaved] = useState(false)
  const [test, setTest] = useState<string>('')
  const [ttsTest, setTtsTest] = useState<string>('')
  const set = (patch: Partial<Draft>) => { setD((p) => ({ ...p, ...patch })); setSaved(false) }

  // 载入后回填非密字段（mode/baseURL/model）；key 保持空（占位显示打码）
  useEffect(() => {
    const s = settings.data
    if (!s) return
    setD({
      llm_mode: s.llm.mode, llm_key: '', llm_base_url: s.llm.base_url,
      model_analysis: s.llm.models.analysis, model_copy: s.llm.models.copy, model_scoring: s.llm.models.scoring,
      tts_mode: s.tts.mode, tts_key: '', tts_base_url: s.tts.base_url, tts_model: s.tts.model, tts_voice: s.tts.voice, melo_python: s.tts.melo_python, cosy_home: s.tts.cosy_home,
      github_mode: s.github.mode, github_token: '',
      scout_weight_rebrand: String(s.scout.weights.rebrandCost), scout_weight_buyer: String(s.scout.weights.buyerClarity), scout_weight_visual: String(s.scout.weights.visualAppeal),
    })
  }, [settings.data])

  const save = useMutation({
    mutationFn: () => api<SettingsView>('/api/settings', { method: 'PUT', body: JSON.stringify(d) }),
    onSuccess: () => { setSaved(true); setTest(''); setTtsTest(''); qc.invalidateQueries({ queryKey: ['settings'] }) },
    onError: (e) => alert(`保存失败: ${e instanceof Error ? e.message : String(e)}`),
  })
  const runTest = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>('/api/settings/test-llm', { method: 'POST' }),
    onSuccess: (r) => setTest(`${r.ok ? '✅' : '⚠️'} ${r.message}`),
    onError: (e) => setTest(`⚠️ ${e instanceof Error ? e.message : String(e)}`),
  })
  const runTtsTest = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>('/api/settings/test-tts', { method: 'POST' }),
    onSuccess: (r) => setTtsTest(`${r.ok ? '✅' : '⚠️'} ${r.message}`),
    onError: (e) => setTtsTest(`⚠️ ${e instanceof Error ? e.message : String(e)}`),
  })

  const s = settings.data
  if (!s) return <div className="text-faint">加载中…</div>
  const keyPlaceholder = (set_: boolean, masked: string) => (set_ ? `已设置 ${masked}（留空不改）` : '未设置')

  return (
    <div className="max-w-2xl space-y-4">
      {/* 保存按钮固定在顶部：改完任意板块都不用滚到底才能保存——之前吃过这个亏（填了 key 只点了旁边的"测试连接"，其实测的是没保存的旧值） */}
      <div className="sticky top-0 z-10 -mx-6 space-y-1 border-b border-hairline bg-paper px-6 pb-3 pt-1">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">设置</h2>
          <div className="flex items-center gap-3">
            <button className="btn-fire px-4 py-2 text-sm disabled:opacity-50" disabled={save.isPending} onClick={() => save.mutate()}>保存</button>
            {saved && <span className="text-sm text-green-600">已保存，立即生效</span>}
          </div>
        </div>
        <span className="text-xs text-faint">🔒 key 只存本地 db、随服务器绑 127.0.0.1，不上传、不进代码仓库</span>
      </div>

      {/* 降级提示：否则选了 live 保存后模式莫名跳回 mock，无从判断为什么（功能性警示，保留琥珀语义） */}
      {s.mode_notes?.length > 0 && (
        <div className="rounded-lg border-[1.5px] border-amber-600 bg-amber-50 p-3 text-sm text-amber-800">
          {s.mode_notes.map((n) => <div key={n}>⚠ {n}</div>)}
        </div>
      )}

      {/* LLM */}
      <section className="space-y-3 card-forge p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">大模型（文案 / 分析 / 评分）</h3>
          <select className="rounded-md border-[1.5px] border-ink bg-card px-2 py-1 text-sm" value={d.llm_mode} onChange={(e) => set({ llm_mode: e.target.value })}>
            <option value="mock">mock（免 key）</option>
            <option value="live">live（用 key）</option>
          </select>
        </div>
        <Field label="API Key" hint="OpenAI 兼容中转站"><input type="password" className={inputCls} value={d.llm_key} placeholder={keyPlaceholder(s.llm.key_set, s.llm.key_masked)} onChange={(e) => set({ llm_key: e.target.value })} /></Field>
        <Field label="Base URL"><input className={inputCls} value={d.llm_base_url} onChange={(e) => set({ llm_base_url: e.target.value })} /></Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="模型·分析"><input className={inputCls} value={d.model_analysis} onChange={(e) => set({ model_analysis: e.target.value })} /></Field>
          <Field label="模型·文案"><input className={inputCls} value={d.model_copy} onChange={(e) => set({ model_copy: e.target.value })} /></Field>
          <Field label="模型·评分"><input className={inputCls} value={d.model_scoring} onChange={(e) => set({ model_scoring: e.target.value })} /></Field>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-ink px-3 py-1 text-sm disabled:opacity-50" disabled={runTest.isPending} onClick={() => runTest.mutate()}>测试连接</button>
          {test && <span className="text-xs text-sub">{test}</span>}
        </div>
      </section>

      {/* TTS */}
      <section className="space-y-3 card-forge p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">配音 TTS（视频旁白）</h3>
          <select className="rounded-md border-[1.5px] border-ink bg-card px-2 py-1 text-sm" value={d.tts_mode} onChange={(e) => set({ tts_mode: e.target.value })}>
            <option value="kokoro">kokoro（离线，机器味重）</option>
            <option value="melo">melo（离线中文，更自然，需 venv）</option>
            <option value="cosy">cosy（CosyVoice2 克隆，男声/多音色，慢）</option>
            <option value="live">live（接 TTS 服务，用 key）</option>
            <option value="stub">stub（静音占位）</option>
          </select>
        </div>
        <Field label="API Key" hint="MiniMax 等，走 /audio/speech"><input type="password" className={inputCls} value={d.tts_key} placeholder={keyPlaceholder(s.tts.key_set, s.tts.key_masked)} onChange={(e) => set({ tts_key: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Base URL"><input className={inputCls} value={d.tts_base_url} onChange={(e) => set({ tts_base_url: e.target.value })} /></Field>
          <Field label="语音模型 id"><input className={inputCls} value={d.tts_model} onChange={(e) => set({ tts_model: e.target.value })} /></Field>
          <Field label="音色 id" hint="如 MiniMax/火山 的具体音色，留空用 default"><input className={inputCls} value={d.tts_voice} onChange={(e) => set({ tts_voice: e.target.value })} /></Field>
        </div>
        <Field label="MeloTTS venv python" hint="melo 模式用；MeloTTS venv 的 python 绝对路径"><input className={inputCls} value={d.melo_python} onChange={(e) => set({ melo_python: e.target.value })} /></Field>
        <Field label="CosyVoice2 目录" hint="cosy 模式用；含 venv/CosyVoice/model/prompt.wav 的 FORGECAST_COSY_HOME"><input className={inputCls} value={d.cosy_home} onChange={(e) => set({ cosy_home: e.target.value })} /></Field>
        <div className="flex items-center gap-3">
          <button className="btn-ink px-3 py-1 text-sm disabled:opacity-50" disabled={runTtsTest.isPending} onClick={() => runTtsTest.mutate()}>测试连接</button>
          {ttsTest && <span className="text-xs text-sub">{ttsTest}</span>}
        </div>
      </section>

      {/* GitHub */}
      <section className="space-y-3 card-forge p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">GitHub 抓取（scout）</h3>
          <select className="rounded-md border-[1.5px] border-ink bg-card px-2 py-1 text-sm" value={d.github_mode} onChange={(e) => set({ github_mode: e.target.value })}>
            <option value="mock">mock（fixture）</option>
            <option value="live">live（真实 API）</option>
          </select>
        </div>
        <Field label="Personal Access Token" hint="可选，只读公开数据即可，提高限速"><input type="password" className={inputCls} value={d.github_token} placeholder={keyPlaceholder(s.github.token_set, s.github.token_masked)} onChange={(e) => set({ github_token: e.target.value })} /></Field>
      </section>

      {/* 评分权重 */}
      <section className="space-y-3 card-forge p-4">
        <h3 className="font-medium">评分权重（三维各自独立，不要求总和100）</h3>
        <div className="grid grid-cols-3 gap-2">
          <Field label="换皮成本上限"><input type="number" min={0} className={inputCls} value={d.scout_weight_rebrand} onChange={(e) => set({ scout_weight_rebrand: e.target.value })} /></Field>
          <Field label="买家清晰度上限"><input type="number" min={0} className={inputCls} value={d.scout_weight_buyer} onChange={(e) => set({ scout_weight_buyer: e.target.value })} /></Field>
          <Field label="内容可视性上限"><input type="number" min={0} className={inputCls} value={d.scout_weight_visual} onChange={(e) => set({ scout_weight_visual: e.target.value })} /></Field>
        </div>
        <p className="text-xs text-faint">改了权重不会自动重新评分老候选，想让老候选按新权重重评，去「找项目」页点「全部重新评分」。</p>
      </section>

      <AutoScoutSection />

      <BrandKitSection />
    </div>
  )
}

// key 字段留空=不改，与顶部 Draft 同惯例；但这里空字段的语义更强——PUT 前会把空串键整个剔除
// （见 buildPutBody），所以「清空再保存」＝把该字段从 kit 里删掉，回到未设置状态。
interface KitDraft { primaryColor: string; accentColor: string; titleScale: string; ctaText: string }
const emptyKitDraft: KitDraft = { primaryColor: '', accentColor: '', titleScale: '', ctaText: '' }

/** 空字段（含空串）不进 PUT body——服务端整体覆盖存储的 kit，不注入的键就等于清空该字段。 */
function buildPutBody(d: KitDraft): BrandKitView {
  const body: BrandKitView = {}
  if (d.primaryColor.trim()) body.primaryColor = d.primaryColor.trim()
  if (d.accentColor.trim()) body.accentColor = d.accentColor.trim()
  if (d.titleScale.trim()) body.titleScale = Number(d.titleScale)
  if (d.ctaText.trim()) body.ctaText = d.ctaText
  return body
}

/** PUT 400 时后端回 `{error: "..."}`；api() 把整个响应体拼进 Error.message，这里剥出人话部分。 */
function extractErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const jsonStart = raw.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart))
      if (typeof parsed.error === 'string') return parsed.error
    } catch { /* 不是 JSON，走兜底 */ }
  }
  return raw
}

/** 品牌 kit 编辑块（设计文档「排版工作台第二期C」）：按项目维护主色/强调色/标题缩放/CTA 文案，
 *  出片时套用到品牌预设层。项目选择沿用 WorkshopPage 顶部下拉的既有模式（列表第一项默认选中）。 */
function BrandKitSection() {
  const qc = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects') })
  const [slug, setSlug] = useState('')
  const selected = slug || projects.data?.[0]?.slug || ''

  const kit = useQuery({
    queryKey: ['brand-kit', selected],
    queryFn: () => getBrandKit(selected),
    enabled: !!selected,
  })
  const [d, setD] = useState<KitDraft>(emptyKitDraft)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  // 载入（或切项目）后回填草稿；titleScale 数字转字符串，未设置的字段留空串。
  // 不在这里 setSaved(false)——save 成功后会 invalidate 查询触发这个 effect 再跑一次，
  // 若在这跟着清掉 saved，"已保存" 提示会跟着刷新一闪而过，用户看不到确认。
  useEffect(() => {
    const k = kit.data
    if (!k) { setD(emptyKitDraft); return }
    setD({
      primaryColor: k.primaryColor ?? '', accentColor: k.accentColor ?? '',
      titleScale: k.titleScale !== undefined ? String(k.titleScale) : '', ctaText: k.ctaText ?? '',
    })
  }, [kit.data])

  // 切项目：单独清掉「已保存」提示与错误提示，不依赖 kit.data 那条 effect
  useEffect(() => { setSaved(false); setError('') }, [selected])

  const set = (patch: Partial<KitDraft>) => { setD((p) => ({ ...p, ...patch })); setSaved(false); setError('') }

  const save = useMutation({
    mutationFn: () => putBrandKit(selected, buildPutBody(d)),
    onSuccess: () => { setSaved(true); setError(''); qc.invalidateQueries({ queryKey: ['brand-kit', selected] }) },
    onError: (e) => { setSaved(false); setError(extractErrorMessage(e)) },
  })

  return (
    <section className="space-y-3 card-forge p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">品牌 Kit（出片套用）</h3>
        <select className="rounded-md border-[1.5px] border-ink bg-card px-2 py-1 text-sm" value={selected}
          onChange={(e) => setSlug(e.target.value)}>
          {/* || 而非 ??：brand_name 空串会渲染成空白 option（与 ProjectGroups / WorkshopPage 口径统一） */}
          {projects.data?.map((p) => <option key={p.slug} value={p.slug}>{p.brand_name || p.slug}</option>)}
        </select>
      </div>
      {!selected ? (
        <p className="text-xs text-faint">还没有项目，先去「找项目」立项一个。</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="主色" hint="#RRGGBB">
              <div className="flex items-center gap-2">
                <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(d.primaryColor) ? d.primaryColor : '#000000'}
                  onChange={(e) => set({ primaryColor: e.target.value })} className="h-8 w-10 shrink-0 rounded border-[1.5px] border-ink bg-card" />
                <input className={inputCls} value={d.primaryColor} placeholder="#RRGGBB（留空不改）" onChange={(e) => set({ primaryColor: e.target.value })} />
              </div>
            </Field>
            <Field label="强调色" hint="#RRGGBB">
              <div className="flex items-center gap-2">
                <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(d.accentColor) ? d.accentColor : '#000000'}
                  onChange={(e) => set({ accentColor: e.target.value })} className="h-8 w-10 shrink-0 rounded border-[1.5px] border-ink bg-card" />
                <input className={inputCls} value={d.accentColor} placeholder="#RRGGBB（留空不改）" onChange={(e) => set({ accentColor: e.target.value })} />
              </div>
            </Field>
            <Field label="标题缩放" hint="0.5–2，留空不改">
              <input type="number" min={0.5} max={2} step={0.1} className={inputCls} value={d.titleScale}
                onChange={(e) => set({ titleScale: e.target.value })} />
            </Field>
            <Field label="CTA 文案" hint="≤60 字，留空不改">
              <input className={inputCls} value={d.ctaText} onChange={(e) => set({ ctaText: e.target.value })} />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <button className="btn-fire px-4 py-1.5 text-sm disabled:opacity-50" disabled={save.isPending} onClick={() => save.mutate()}>保存</button>
            {saved && <span className="text-sm text-green-600">已保存</span>}
            {error && <span className="text-sm text-red-600">⚠ {error}</span>}
          </div>
        </>
      )}
    </section>
  )
}

/** 每日自动抓取设置：读 auto-status，写 PUT /api/settings（auto_scout / auto_scout_time） */
function AutoScoutSection() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['auto-scout'], queryFn: () => api<AutoScoutStatus>('/api/scout/auto-status') })
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [time, setTime] = useState<string | null>(null)
  const en = enabled ?? status.data?.enabled ?? true
  const tm = time ?? status.data?.time ?? '08:00'
  async function save() {
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ auto_scout: en ? 'on' : 'off', auto_scout_time: tm }) })
      qc.invalidateQueries({ queryKey: ['auto-scout'] })
      alert('已保存（server 每分钟检查一次，到点自动抓取；当天错过启动时会补跑）')
    } catch (e) { alert(`保存失败: ${e instanceof Error ? e.message : String(e)}`) }
  }
  return (
    <div className="card-forge p-4 space-y-3">
      <div className="font-semibold">每日自动抓取</div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={en} onChange={(e) => setEnabled(e.target.checked)} />
        每天自动抓取候选（只给新项目评分，不覆盖已有评分）
      </label>
      <label className="flex items-center gap-2 text-sm">
        每日时间
        <input type="time" className="rounded-md border-[1.5px] border-ink bg-card px-2 py-1 text-sm" value={tm} onChange={(e) => setTime(e.target.value)} />
      </label>
      {status.data?.lastRun && (
        <div className="text-xs text-faint">上次运行：{status.data.lastRun}</div>
      )}
      <button className="btn-fire px-4 py-1.5 text-sm" onClick={save}>保存</button>
    </div>
  )
}
