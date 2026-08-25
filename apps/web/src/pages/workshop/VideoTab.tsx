import { useQuery } from '@tanstack/react-query'
import { api, type Asset, type BgmList, type CustomTemplate } from '../../api'
import AssetCard from '../../components/AssetCard'

export const VIDEO_TPLS = [
  { value: 'flash', label: 'flash · 文字快闪' },
  { value: 'story', label: 'story · 微信气泡' },
  { value: 'demo', label: 'demo · 产品截图轮播' },
  { value: 'changelog', label: 'changelog · 代码变更' },
  { value: 'insight', label: 'insight · 数据卡片解说' },
]
export const MOODS = [
  { value: '', label: '自动（按钩子情绪）' },
  { value: 'tense', label: '紧张' },
  { value: 'upbeat', label: '热血' },
  { value: 'tech', label: '科技' },
  { value: 'warm', label: '温情' },
]
export const BGS = [
  { value: 'grid', label: '赛博网格' },
  { value: 'aurora', label: '极光' },
  { value: 'matrix', label: '数据雨' },
  { value: 'synth', label: '合成波' },
  { value: 'mesh', label: '深空' },
  { value: 'random', label: '随机' },
  { value: 'none', label: '不加背景' },
]

export interface VideoParams { tpl: string; bgm: string; mood: string; bg: string; captions: boolean; ratio: 'portrait' | 'landscape' }

/** 出视频 tab：渲染参数面板（选文案来源+模板+BGM+情绪+背景+字幕）+ 竖屏成片网格 */
export default function VideoTab({
  selected, vp, setVp, copyAssets, videoFromAsset, setVideoFromAsset, running, onMakeVideo,
  bgmList, videoAssets, slug, onRegenerate,
}: {
  selected: string
  vp: VideoParams
  setVp: (v: VideoParams) => void
  copyAssets: Asset[]
  videoFromAsset: number | null
  setVideoFromAsset: (id: number) => void
  running: boolean
  onMakeVideo: (assetId: number) => void
  bgmList: BgmList | undefined
  videoAssets: Asset[]
  slug: string
  onRegenerate: (feedback: string, asset: Asset) => void
}) {
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<CustomTemplate[]>('/api/templates') })
  const tplOptions = [
    ...VIDEO_TPLS,
    ...(templates.data ?? []).map((t) => ({ value: `custom-${t.id}`, label: `${t.name}（对标拆解 · ${t.aspect_ratio === 'portrait' ? '竖屏' : '横屏'}）` })),
  ]
  const chosenId = videoFromAsset ?? copyAssets[0]?.id ?? null
  return (
    <div className="grid grid-cols-[320px_1fr] gap-6">
      <div className="card-forge h-fit space-y-3 p-4">
        <h3 className="text-sm font-semibold">视频参数</h3>
        <div>
          <label className="text-sm text-sub">文案来源</label>
          <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm"
            value={chosenId ?? ''} onChange={(e) => setVideoFromAsset(Number(e.target.value))}>
            {copyAssets.length === 0 && <option value="">暂无文案，先去「文案」tab 生成</option>}
            {copyAssets.map((a) => <option key={a.id} value={a.id}>#{a.id} · {a.hook}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm text-sub">模板</label>
          <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm"
            value={vp.tpl} onChange={(e) => setVp({ ...vp, tpl: e.target.value })}>
            {tplOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {vp.tpl === 'demo' && <p className="mt-1 text-xs text-faint">需先在项目详情页上传 shots/ 截图</p>}
        </div>
        {(vp.tpl === 'flash' || vp.tpl === 'story' || vp.tpl === 'demo') && (
          <div>
            <label className="text-sm text-sub">画布比例</label>
            <div className="mt-1 flex items-center gap-4 text-sm">
              <label className="flex items-center gap-1">
                <input type="radio" checked={vp.ratio === 'portrait'} onChange={() => setVp({ ...vp, ratio: 'portrait' })} /> 竖屏 9:16
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" checked={vp.ratio === 'landscape'} onChange={() => setVp({ ...vp, ratio: 'landscape' })} /> 横屏 16:9
              </label>
            </div>
          </div>
        )}
        <div>
          <label className="text-sm text-sub">BGM</label>
          <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm"
            value={vp.bgm} onChange={(e) => setVp({ ...vp, bgm: e.target.value })}>
            <option value="">自动（按钩子情绪）</option>
            <option value="none">不加背景乐</option>
            {bgmList?.root.map((f) => <option key={f} value={f}>{f}</option>)}
            {Object.entries(bgmList?.byMood ?? {}).map(([m, files]) => (
              <optgroup key={m} label={m}>
                {files.map((f) => <option key={f} value={f}>{f}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm text-sub">情绪</label>
          <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm"
            value={vp.mood} onChange={(e) => setVp({ ...vp, mood: e.target.value })}>
            {MOODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm text-sub">背景{vp.tpl === 'story' && <span className="text-faint">（story 不显示背景层）</span>}</label>
          <select className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2 text-sm disabled:opacity-50"
            disabled={vp.tpl === 'story'} value={vp.bg} onChange={(e) => setVp({ ...vp, bg: e.target.value })}>
            {BGS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-sub">
          <input type="checkbox" checked={vp.captions} onChange={(e) => setVp({ ...vp, captions: e.target.checked })} />
          烧旁白字幕进视频（默认关，模板大字标题不受影响）
        </label>
        <button className="btn-fire w-full py-2 disabled:opacity-50"
          disabled={!selected || running || chosenId == null}
          onClick={() => chosenId != null && onMakeVideo(chosenId)}>
          {running ? '生成中…' : '生成视频'}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4 2xl:grid-cols-3">
        {videoAssets.length === 0 && <div className="text-faint text-sm">暂无成片，选好文案和参数后点「生成视频」</div>}
        {videoAssets.map((a) => (
          <AssetCard key={a.id} asset={a} slug={slug} onRegenerate={(fb) => onRegenerate(fb, a)} />
        ))}
      </div>
    </div>
  )
}
