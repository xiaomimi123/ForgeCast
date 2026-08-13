import type { Asset } from '../../api'
import AssetCard from '../../components/AssetCard'

export const HOOKS = [
  { value: 'pain', label: '行业痛点型' },
  { value: 'sideline', label: '副业型' },
  { value: 'infogap', label: '信息差型' },
  { value: 'story', label: '接单故事型' },
]

/** 文案 tab：钩子+篇数生成面板 + 文案/封面素材列表（视频素材归「出视频」tab 展示） */
export default function CopyTab({
  selected, hook, setHook, n, setN, running, onGenerate, assets, slug, onRegenerate, onVideo,
}: {
  selected: string
  hook: string
  setHook: (v: string) => void
  n: number
  setN: (v: number) => void
  running: boolean
  onGenerate: () => void
  assets: Asset[]
  slug: string
  onRegenerate: (feedback: string, asset: Asset) => void
  onVideo: (assetId: number) => void
}) {
  const list = assets.filter((a) => a.type !== 'video')
  return (
    <div className="grid grid-cols-[320px_1fr] gap-6">
      <div className="card-forge h-fit space-y-3 p-4">
        <div>
          <label className="text-sm text-sub">钩子类型</label>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {HOOKS.map((h) => (
              <button key={h.value}
                className={`rounded-md border-[1.5px] px-2 py-1.5 text-sm ${hook === h.value ? 'border-fire bg-fire-soft text-fire font-bold' : 'border-hairline bg-transparent text-sub'}`}
                onClick={() => setHook(h.value)}>{h.label}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-sm text-sub">篇数</label>
          <input type="number" min={1} max={5} className="mt-1 w-full rounded-md border-[1.5px] border-ink bg-card p-2"
            value={n} onChange={(e) => setN(Number(e.target.value))} />
        </div>
        <button className="btn-fire w-full py-2 disabled:opacity-50"
          disabled={!selected || running} onClick={onGenerate}>
          {running ? '生成中…' : '生成'}
        </button>
      </div>
      <div className="space-y-4">
        {list.length === 0 && <div className="text-faint text-sm">暂无素材，点左侧「生成」</div>}
        {list.map((a) => (
          <AssetCard key={a.id} asset={a} slug={slug} onRegenerate={(fb) => onRegenerate(fb, a)} onVideo={onVideo} />
        ))}
      </div>
    </div>
  )
}
