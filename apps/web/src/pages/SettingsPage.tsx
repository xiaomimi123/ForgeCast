import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type SettingsView } from '../api'

// 可编辑草稿：key 字段留空=不改（占位显示已存打码值）
interface Draft {
  llm_mode: string; llm_key: string; llm_base_url: string
  model_analysis: string; model_copy: string; model_scoring: string
  tts_mode: string; tts_key: string; tts_base_url: string; tts_model: string; tts_voice: string; melo_python: string; cosy_home: string
  github_mode: string; github_token: string
}
const emptyDraft: Draft = {
  llm_mode: 'mock', llm_key: '', llm_base_url: '', model_analysis: '', model_copy: '', model_scoring: '',
  tts_mode: 'kokoro', tts_key: '', tts_base_url: '', tts_model: '', tts_voice: '', melo_python: '', cosy_home: '', github_mode: 'mock', github_token: '',
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-neutral-600">{label}{hint && <span className="ml-1 font-normal text-neutral-400">{hint}</span>}</div>
      {children}
    </label>
  )
}
const inputCls = 'w-full rounded border px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none'

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
  if (!s) return <div className="text-neutral-400">加载中…</div>
  const keyPlaceholder = (set_: boolean, masked: string) => (set_ ? `已设置 ${masked}（留空不改）` : '未设置')

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">设置</h2>
        <span className="text-xs text-neutral-400">🔒 key 只存本地 db、随服务器绑 127.0.0.1，不上传、不进代码仓库</span>
      </div>

      {/* 降级提示：否则选了 live 保存后模式莫名跳回 mock，无从判断为什么 */}
      {s.mode_notes?.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          {s.mode_notes.map((n) => <div key={n}>⚠ {n}</div>)}
        </div>
      )}

      {/* LLM */}
      <section className="space-y-3 rounded-lg border bg-white p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">大模型（文案 / 分析 / 评分）</h3>
          <select className="rounded border px-2 py-1 text-sm" value={d.llm_mode} onChange={(e) => set({ llm_mode: e.target.value })}>
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
          <button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={runTest.isPending} onClick={() => runTest.mutate()}>测试连接</button>
          {test && <span className="text-xs text-neutral-600">{test}</span>}
        </div>
      </section>

      {/* TTS */}
      <section className="space-y-3 rounded-lg border bg-white p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">配音 TTS（视频旁白）</h3>
          <select className="rounded border px-2 py-1 text-sm" value={d.tts_mode} onChange={(e) => set({ tts_mode: e.target.value })}>
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
          <button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={runTtsTest.isPending} onClick={() => runTtsTest.mutate()}>测试连接</button>
          {ttsTest && <span className="text-xs text-neutral-600">{ttsTest}</span>}
        </div>
      </section>

      {/* GitHub */}
      <section className="space-y-3 rounded-lg border bg-white p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">GitHub 抓取（scout）</h3>
          <select className="rounded border px-2 py-1 text-sm" value={d.github_mode} onChange={(e) => set({ github_mode: e.target.value })}>
            <option value="mock">mock（fixture）</option>
            <option value="live">live（真实 API）</option>
          </select>
        </div>
        <Field label="Personal Access Token" hint="可选，只读公开数据即可，提高限速"><input type="password" className={inputCls} value={d.github_token} placeholder={keyPlaceholder(s.github.token_set, s.github.token_masked)} onChange={(e) => set({ github_token: e.target.value })} /></Field>
      </section>

      <div className="flex items-center gap-3">
        <button className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={save.isPending} onClick={() => save.mutate()}>保存</button>
        {saved && <span className="text-sm text-green-600">已保存，立即生效</span>}
      </div>
    </div>
  )
}
