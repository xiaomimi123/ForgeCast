import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, createIndustry, deleteIndustry, getBrandKit, imageAssetUrl, listImageAssets, listIndustries, patchIndustry, putBrandKit, regenerateIndustryQueries, type AutoScoutStatus, type BrandKitView, type Industry, type Project, type SettingsView } from '../api'
import { useConfirm } from '../components/ui/Confirm'

// 可编辑草稿：key 字段留空=不改（占位显示已存打码值）
interface Draft {
  llm_mode: string; llm_key: string; llm_base_url: string
  model_analysis: string; model_copy: string; model_scoring: string
  tts_mode: string; tts_key: string; tts_base_url: string; tts_model: string; tts_voice: string; melo_python: string; cosy_home: string
  github_mode: string; github_token: string
  scout_weight_rebrand: string; scout_weight_buyer: string; scout_weight_visual: string; scout_weight_depth: string
}
const emptyDraft: Draft = {
  llm_mode: 'mock', llm_key: '', llm_base_url: '', model_analysis: '', model_copy: '', model_scoring: '',
  tts_mode: 'kokoro', tts_key: '', tts_base_url: '', tts_model: '', tts_voice: '', melo_python: '', cosy_home: '', github_mode: 'mock', github_token: '',
  scout_weight_rebrand: '20', scout_weight_buyer: '30', scout_weight_visual: '20', scout_weight_depth: '30',
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
      scout_weight_rebrand: String(s.scout.weights.rebrandCost), scout_weight_buyer: String(s.scout.weights.buyerClarity), scout_weight_visual: String(s.scout.weights.visualAppeal), scout_weight_depth: String(s.scout.weights.businessDepth),
    })
  }, [settings.data])

  const save = useMutation({
    mutationFn: () => api<SettingsView>('/api/settings', { method: 'PUT', body: JSON.stringify(d) }),
    onSuccess: () => { setSaved(true); setTest(''); setTtsTest(''); qc.invalidateQueries({ queryKey: ['settings'] }) },
    onError: (e) => alert(`保存失败: ${e instanceof Error ? e.message : String(e)}`),
  })
  const [rescoreMsg, setRescoreMsg] = useState('')
  const rescoreAll = useMutation({
    mutationFn: () => api<{ taskId: string }>('/api/candidates/rescore-all', { method: 'POST' }),
    onSuccess: () => setRescoreMsg('已开始，去「找项目」页看进度与日志'),
    onError: (e) => setRescoreMsg(`⚠ ${extractErrorMessage(e)}`),
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

  // 四维合计：空串/非数字按 0 算，提示用（服务端 putWeight 自己也会忽略非法值）
  const weightSum = [d.scout_weight_rebrand, d.scout_weight_buyer, d.scout_weight_visual, d.scout_weight_depth]
    .reduce((sum, v) => sum + (Number.isFinite(Number(v)) ? Number(v) : 0), 0)

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

      {/* 评分权重（四维；合计 100 只是约定，服务端不强制） */}
      <section className="space-y-3 card-forge p-4">
        <h3 className="font-medium">评分权重（四维上限）</h3>
        <div className="grid grid-cols-4 gap-2">
          <Field label="换皮成本上限"><input type="number" min={0} className={inputCls} value={d.scout_weight_rebrand} onChange={(e) => set({ scout_weight_rebrand: e.target.value })} /></Field>
          <Field label="买家清晰度上限"><input type="number" min={0} className={inputCls} value={d.scout_weight_buyer} onChange={(e) => set({ scout_weight_buyer: e.target.value })} /></Field>
          <Field label="内容可视性上限"><input type="number" min={0} className={inputCls} value={d.scout_weight_visual} onChange={(e) => set({ scout_weight_visual: e.target.value })} /></Field>
          <Field label="业务含量上限" hint="低于其 40% 的项目直接不入库"><input type="number" min={0} className={inputCls} value={d.scout_weight_depth} onChange={(e) => set({ scout_weight_depth: e.target.value })} /></Field>
        </div>
        {/* 合计只在默认值上有不变量守护，用户填得出非 100 的组合——这里只提示不拦截（总分上限＝四项之和） */}
        <p className={`text-xs ${weightSum === 100 ? 'text-faint' : 'text-amber-700'}`}>
          四维合计应为 100，当前 {weightSum}{weightSum === 100 ? '' : ' ⚠ 满分不再是 100 分，新旧候选的分数会对不上'}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-ink px-3 py-1 text-sm disabled:opacity-50" disabled={rescoreAll.isPending}
            onClick={() => rescoreAll.mutate()}>{rescoreAll.isPending ? '提交中…' : '按新标准重评候选池'}</button>
          {rescoreMsg && <span className="text-xs text-sub">{rescoreMsg}</span>}
        </div>
        <p className="text-xs text-faint">
          改权重不会自动重评老候选。这个按钮<b className="text-ink">只重评「没真评过」的候选</b>；
          已有旧三维分的候选要按新四维标准重评，得在候选详情里逐个点「重新评分」（批量强制重评的路由还没有，记在 backlog）。
          <b className="text-ink">旧候选是三维评分（没有业务含量维），与新四维分不可直接比较。</b>
        </p>
      </section>

      <IndustrySection />

      <AutoScoutSection />

      <BrandKitSection />
    </div>
  )
}

// key 字段留空=不改，与顶部 Draft 同惯例；但这里空字段的语义更强——PUT 前会把空串键整个剔除
// （见 buildPutBody），所以「清空再保存」＝把该字段从 kit 里删掉，回到未设置状态。
// logoAssetId 也走「字符串草稿」：下拉的 value 只能是 string，空串＝不设 logo（PUT 时删键）。
interface KitDraft { primaryColor: string; accentColor: string; titleScale: string; ctaText: string; logoAssetId: string }
const emptyKitDraft: KitDraft = { primaryColor: '', accentColor: '', titleScale: '', ctaText: '', logoAssetId: '' }

/** 空字段（含空串）不进 PUT body——服务端整体覆盖存储的 kit，不注入的键就等于清空该字段。 */
function buildPutBody(d: KitDraft): BrandKitView {
  const body: BrandKitView = {}
  if (d.primaryColor.trim()) body.primaryColor = d.primaryColor.trim()
  if (d.accentColor.trim()) body.accentColor = d.accentColor.trim()
  if (d.titleScale.trim()) body.titleScale = Number(d.titleScale)
  if (d.ctaText.trim()) body.ctaText = d.ctaText
  if (d.logoAssetId.trim()) body.logoAssetId = Number(d.logoAssetId)
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
  // logo 只能选**本项目上传的图片**（服务端 PUT 也按这个口径校验），所以列表里把 shot 那一类滤掉。
  const images = useQuery({
    queryKey: ['image-assets', selected],
    queryFn: () => listImageAssets(selected),
    enabled: !!selected,
  })
  const uploads = (images.data ?? []).filter((a) => a.kind === 'upload' && typeof a.id === 'number')
  const [d, setD] = useState<KitDraft>(emptyKitDraft)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [logoGone, setLogoGone] = useState(false)

  // 载入（或切项目）后回填草稿；titleScale 数字转字符串，未设置的字段留空串。
  // 不在这里 setSaved(false)——save 成功后会 invalidate 查询触发这个 effect 再跑一次，
  // 若在这跟着清掉 saved，"已保存" 提示会跟着刷新一闪而过，用户看不到确认。
  useEffect(() => {
    const k = kit.data
    if (!k) { setD(emptyKitDraft); return }
    setD({
      primaryColor: k.primaryColor ?? '', accentColor: k.accentColor ?? '',
      titleScale: k.titleScale !== undefined ? String(k.titleScale) : '', ctaText: k.ctaText ?? '',
      logoAssetId: k.logoAssetId !== undefined ? String(k.logoAssetId) : '',
    })
  }, [kit.data])

  // 切项目：单独清掉「已保存」提示与错误提示，不依赖 kit.data 那条 effect
  useEffect(() => { setSaved(false); setError(''); setLogoGone(false) }, [selected])

  // 死胡同兜底：kit 里存的 logoAssetId 对应的素材被删了（剪辑台「删除素材」），下拉里没有任何一项
  // 能匹配上——select 的 value 落空会静默显示成第一项「不使用 logo」，用户看不出发生了什么，
  // 保存时又会把这个"看着没变"的值原样写回去。这里显式把草稿归空并挂一句提示：所见即所存，
  // 点保存就等于把这条失效的 logo 从 kit 里清掉。
  // 只在 images 查询**成功**后判断——加载中/失败时 uploads 为空数组，那时候归空会误清。
  useEffect(() => {
    if (!images.isSuccess || !d.logoAssetId) return
    if (uploads.some((a) => String(a.id) === d.logoAssetId)) return
    setLogoGone(true)
    setD((p) => ({ ...p, logoAssetId: '' }))
  }, [images.isSuccess, images.data, d.logoAssetId])

  const set = (patch: Partial<KitDraft>) => { setD((p) => ({ ...p, ...patch })); setSaved(false); setError('') }

  const save = useMutation({
    mutationFn: () => putBrandKit(selected, buildPutBody(d)),
    onSuccess: () => { setSaved(true); setError(''); qc.invalidateQueries({ queryKey: ['brand-kit', selected] }) },
    onError: (e) => { setSaved(false); setError(extractErrorMessage(e)) },
  })

  const logoItem = uploads.find((a) => String(a.id) === d.logoAssetId)
  const logoPreview = logoItem ? imageAssetUrl(selected, logoItem) : ''

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
          <Field label="品牌 logo" hint="出片时贴到画面右上角；选「不使用」＝不贴">
            <div className="flex items-center gap-2">
              {logoPreview && <img src={logoPreview} alt="" className="h-8 w-8 shrink-0 rounded border-[1.5px] border-ink object-contain bg-card" />}
              <select className={inputCls} value={d.logoAssetId} onChange={(e) => set({ logoAssetId: e.target.value })}>
                <option value="">不使用 logo</option>
                {uploads.map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
              </select>
            </div>
            {logoGone && (
              <p className="mt-1 text-xs text-red-600">原 logo 素材已删除，已重置为「不使用 logo」——点保存即从 kit 里清掉，或另选一张。</p>
            )}
            {uploads.length === 0 && (
              <p className="mt-1 text-xs text-faint">本项目还没有上传过图片素材——去剪辑台「＋素材」里上传一张，再回来选。</p>
            )}
          </Field>
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

/** 选品行业块（行业锚定选品）：行业 = 选品的锚。每个行业各自生成一组 GitHub 搜索词并缓存，
 *  「抓取候选」按启用的行业逐个搜。改了名字/备注要重新生成搜索词才会生效（缓存不会自动失效）。 */
function IndustrySection() {
  const qc = useQueryClient()
  const { confirm, element: confirmEl } = useConfirm()
  const industries = useQuery({ queryKey: ['industries'], queryFn: listIndustries })
  const [error, setError] = useState('')
  const [newName, setNewName] = useState('')
  const [newNote, setNewNote] = useState('')
  // 「重新生成」是逐行的：记住正在生成的行业 id，只禁用那一行的按钮
  const [genIds, setGenIds] = useState<Set<number>>(new Set())
  // 刚生成完的词数，落在行上给个即时反馈（列表 refetch 回来后也会显示同一个数）
  const [genMsg, setGenMsg] = useState<Record<number, string>>({})

  const rows = industries.data ?? []
  const refresh = () => qc.invalidateQueries({ queryKey: ['industries'] })
  // 失败一律落这里的内联提示，不用 alert（页面上还有别的块，弹窗会打断填写）
  const run = async (fn: () => Promise<unknown>) => {
    setError('')
    try { await fn(); refresh() } catch (e) { setError(extractErrorMessage(e)) }
  }

  async function add() {
    const name = newName.trim()
    if (!name) return
    await run(async () => {
      await createIndustry({ name, ...(newNote.trim() ? { note: newNote.trim() } : {}) })
      setNewName(''); setNewNote('')
    })
  }
  async function remove(i: Industry) {
    if (!(await confirm({ title: `删除行业「${i.name}」？`, body: '连同它的搜索词缓存一起删。已入库的候选不受影响（只是失去行业归属）。', danger: true }))) return
    await run(() => deleteIndustry(i.id))
  }
  async function regenerate(i: Industry) {
    setError('')
    setGenIds((prev) => new Set(prev).add(i.id))
    try {
      const r = await regenerateIndustryQueries(i.id)
      setGenMsg((prev) => ({ ...prev, [i.id]: `已生成 ${r.keywords.length} 个搜索词` }))
      refresh()
    } catch (e) {
      setError(`「${i.name}」生成搜索词失败：${extractErrorMessage(e)}`)
    } finally {
      setGenIds((prev) => { const next = new Set(prev); next.delete(i.id); return next })
    }
  }

  return (
    <section className="space-y-3 card-forge p-4">
      <h3 className="font-medium">选品行业（「抓取候选」按这些行业搜）</h3>
      <p className="text-xs text-faint">
        每个行业各自生成一组 GitHub 搜索词并缓存。改了名字或备注<b className="text-ink">不会自动重生成</b>——
        要点该行的「重新生成」才会用新词去搜。停用的行业不参与抓取；全停用时回落到内置通用搜索词（选品不会失效）。
      </p>
      {error && <p className="text-sm text-red-600">⚠ {error}</p>}

      <div className="space-y-2">
        {rows.map((i) => (
          <div key={i.id} className="rounded-md border-[1.5px] border-hairline p-2">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={i.enabled} title={i.enabled ? '已启用' : '已停用'}
                onChange={(e) => run(() => patchIndustry(i.id, { enabled: e.target.checked }))} />
              <input className={`${inputCls} flex-1`} defaultValue={i.name} key={`n${i.id}-${i.name}`}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== i.name) run(() => patchIndustry(i.id, { name: v })) }} />
              <button className="rounded-md border-[1.5px] border-ink bg-card px-2 py-1.5 text-xs disabled:opacity-50"
                disabled={genIds.has(i.id)} onClick={() => regenerate(i)}>
                {genIds.has(i.id) ? '生成中…' : '重新生成'}
              </button>
              <button className="rounded-md border-[1.5px] border-red-600 px-2 py-1.5 text-xs text-red-600"
                onClick={() => remove(i)}>删除</button>
            </div>
            <input className={`${inputCls} mt-1`} defaultValue={i.note ?? ''} key={`t${i.id}-${i.note ?? ''}`}
              placeholder="备注：这个行业的老板日常在管什么（喂给大模型生成搜索词）"
              onBlur={(e) => { const v = e.target.value; if (v !== (i.note ?? '')) run(() => patchIndustry(i.id, { note: v || null })) }} />
            <div className="mt-1 text-xs text-faint">
              {i.keywordCount} 个搜索词
              {i.generatedAt ? ` · 生成于 ${new Date(i.generatedAt).toLocaleString()}` : ' · 尚未生成（抓取时会按需现生成）'}
              {genMsg[i.id] && <span className="ml-2 text-green-600">{genMsg[i.id]}</span>}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="text-xs text-faint">一个行业都没有——下面加一个，否则抓取会回落到内置通用搜索词。</p>}
      </div>

      <div className="flex items-center gap-2">
        <input className={`${inputCls} w-40`} value={newName} placeholder="新行业名称"
          onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
        <input className={inputCls} value={newNote} placeholder="备注（可选）"
          onChange={(e) => setNewNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
        <button className="btn-fire shrink-0 px-3 py-1.5 text-sm disabled:opacity-50" disabled={!newName.trim()} onClick={add}>新增</button>
      </div>
      {confirmEl}
    </section>
  )
}
