import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { imageAssetUrl, listImageAssets, uploadProjectImage, type ImageAssetItem } from '../../../api'
import { OUTLINE, SOLID } from './ui'

/** 选中一份素材后回给调用方的入参——与 `POST media-asset` 的二选一 body 一一对应。 */
export type MediaPick = { assetId: number } | { shotPath: string }

/** 一项素材 → 它的 pick 入参。upload 走 assetId（库内素材行），shot 走项目相对路径。 */
export function pickOf(a: ImageAssetItem): MediaPick | null {
  if (a.kind === 'upload') return typeof a.id === 'number' ? { assetId: a.id } : null
  return { shotPath: a.path }
}

/**
 * 素材选择弹层（设计文档「排版工作台第四期D」§2）：两组缩略图网格（本项目上传图 / demo 截图）
 * + 「上传新图」。
 *
 * **弹层只负责「选哪一份」**，拷进素材包与加层由调用方（EditorPage）做——同一条链路还要
 * `ed.apply` + 自动选中，那些都是编辑态的事，塞进弹层就得把整个 `ed` 传进来。
 * 上传成功也不在这里加层：一样回调 `onPick({assetId})`，两条路（选已有 / 传新图）从此合流，
 * 错误处理与 notice 只有一处。
 */
export default function MediaPicker({ slug, busy, onPick, onClose }: {
  slug: string
  /** 加层链路在途（拷贝/加层）：整个弹层禁用，避免连点加出两层。 */
  busy: boolean
  onPick: (pick: MediaPick, name: string) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = useQuery({
    queryKey: ['image-assets', slug],
    queryFn: () => listImageAssets(slug),
    networkMode: 'always',
  })

  // Esc 关闭（与 Confirm 同一条键盘路径；这里不做完整 focus trap，理由同 useConfirm 的注释）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const items = list.data ?? []
  const uploads = items.filter((a) => a.kind === 'upload')
  const shots = items.filter((a) => a.kind === 'shot')
  const locked = busy || uploading

  async function doUpload(file: File) {
    setError(null)
    setUploading(true)
    try {
      const r = await uploadProjectImage(slug, file)
      // 列表要立刻能看到这张新图（用户取消加层后再来选还是同一个弹层）
      await qc.invalidateQueries({ queryKey: ['image-assets', slug] })
      onPick({ assetId: r.id }, file.name)
    } catch (e) {
      setError(`上传失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setUploading(false)
      // 同一个文件连传两次也要能触发 change：不清空 value 的话第二次选同名文件浏览器不发事件
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center"
      style={{ background: 'rgba(24,26,22,0.45)' }}
      onClick={(e) => { e.stopPropagation(); if (!locked) onClose() }}
    >
      <div
        className="flex max-h-[76vh] w-[560px] flex-col rounded-[var(--fc-r-sm)] bg-[var(--fc-surface)] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center">
          <div className="text-sm font-bold text-[var(--fc-ink)]">选择图片素材</div>
          <span className="ml-2 text-[11px] text-[var(--fc-faint)]">选中即拷进这条视频的素材包并加一层</span>
          <button className={`${OUTLINE} ml-auto !px-2 !py-0.5 !text-xs`} disabled={locked} onClick={onClose}>关闭</button>
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
          {list.isLoading && <p className="text-xs text-[var(--fc-faint)]">读取素材中…</p>}
          {list.isError && (
            <p className="text-xs text-[var(--fc-accent-deep)]">
              素材列表读取失败：{list.error instanceof Error ? list.error.message : String(list.error)}
            </p>
          )}
          {list.isSuccess && (
            <>
              <Group title="本项目上传图" empty="还没有上传过图片——用下面的「上传新图」加一张。">
                {uploads.map((a) => (
                  <Thumb key={`u-${a.id}`} slug={slug} item={a} disabled={locked}
                    onClick={() => { const p = pickOf(a); if (p) onPick(p, a.name) }} />
                ))}
              </Group>
              <Group title="项目截图" empty="这个项目的 shots 目录里没有图。">
                {shots.map((a) => (
                  <Thumb key={`s-${a.path}`} slug={slug} item={a} disabled={locked}
                    onClick={() => { const p = pickOf(a); if (p) onPick(p, a.name) }} />
                ))}
              </Group>
            </>
          )}
        </div>

        {error && <p className="mt-2 text-[11px] leading-relaxed text-[var(--fc-accent-deep)]">{error}</p>}

        <div className="mt-3 flex items-center gap-2 border-t border-[var(--fc-line)] pt-3">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void doUpload(f) }}
          />
          <button className={SOLID} disabled={locked} onClick={() => fileRef.current?.click()}>
            {uploading ? '上传中…' : '上传新图'}
          </button>
          <span className="text-[11px] text-[var(--fc-faint)]">png / jpg / webp / svg，不超过 10MB；上传后直接加层</span>
        </div>
      </div>
    </div>
  )
}

function Group({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-[var(--fc-muted)]">
        {title} <span className="text-[var(--fc-faint)]">· {children.length}</span>
      </div>
      {children.length === 0
        ? <p className="text-[11px] text-[var(--fc-faint)]">{empty}</p>
        : <div className="grid grid-cols-4 gap-2">{children}</div>}
    </div>
  )
}

/** 一格缩略图。图取不到（文件被手工删了）时显示文件名占位而不是破图标。 */
function Thumb({ slug, item, disabled, onClick }: {
  slug: string; item: ImageAssetItem; disabled: boolean; onClick: () => void
}) {
  const [broken, setBroken] = useState(false)
  return (
    <button
      type="button"
      disabled={disabled}
      title={item.name}
      onClick={onClick}
      className="overflow-hidden rounded-[var(--fc-r-sm)] border border-[var(--fc-line)] bg-[var(--fc-bg)] p-1 text-left hover:border-[var(--fc-ink)] disabled:opacity-50"
    >
      <div className="flex h-[72px] items-center justify-center overflow-hidden rounded-[var(--fc-r-xs)] bg-[var(--fc-sunken)]">
        {broken
          ? <span className="px-1 text-center text-[10px] text-[var(--fc-faint)]">图片不可用</span>
          : <img src={imageAssetUrl(slug, item)} alt={item.name}
              className="max-h-full max-w-full object-contain" onError={() => setBroken(true)} />}
      </div>
      <div className="mt-1 truncate text-[10px] text-[var(--fc-muted)]">{item.name}</div>
    </button>
  )
}
