import type { TaskRecord } from './tasks'

/**
 * 内容工位聚合视图：一条内容（文案 + 封面 + 成片 + 渲染进度）收成一个对象。
 *
 * 本模块是**纯函数**：不 import db / fs / config，所有外部读取（assets 行、spec、标题、任务队列）
 * 一律依赖注入。这是它能被表驱动测试整表钉死的前提——状态派生这类映射本仓库已经翻过几次车。
 */

export type ContentStatus = 'script_ready' | 'rendering' | 'review' | 'approved' | 'failed'

/** assets 表行（server 现有 `SELECT * FROM assets` 结果原样） */
export interface AssetRow {
  id: number
  type: string
  hook: string | null
  file_path: string
  status: string | null
  warnings: string | null
  origin?: string | null
  spec_path?: string | null
  [k: string]: unknown
}

export interface ContentItemView {
  id: number
  seq: number
  hook: string | null
  status: ContentStatus
  title: string
  copyAssetId: number
  cover: { assetId: number; url: string } | null
  /** 最新一版渲染成片；`assetIds` 是该文案关联的**全部**版本 id（含最新），删除内容时要整条清掉，否则旧版成孤儿 */
  render: { assetId: number; assetIds: number[]; url: string; specPath: string | null; version: number; status: string } | null
  progress: number | null
  error: string | null
  warnings: string[]
}

export interface BuildContentItemsInput {
  assets: AssetRow[]
  readSpec: (specPath: string) => { semantic?: { sourceAssetId?: number | null } } | null
  tasks: TaskRecord[]
  readTitle: (filePath: string) => string | null
  slug: string
}

const fileUrl = (p: string) => `/files/${p}`
const baseName = (p: string) => p.split('/').pop() ?? p
/** 去掉扩展名的词干：生成代码里 copy/cover 共用同一个 `${hook}-${stamp}-${i}-${rand}` 词干 */
const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, '')

function parseWarnings(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/** 从任务日志里取最后一条 `NN%`；取不到返回 null */
function parseProgress(task: TaskRecord): number | null {
  let last: number | null = null
  for (const e of task.events) {
    const m = /(\d+)%/.exec(e.message ?? '')
    if (m) last = Number(m[1])
  }
  return last
}

/** 标题 fail-soft：注入方抛错或给空串，一律回落文件名（与 readSpec 的 fail-soft 契约对称） */
function readTitleSafe(readTitle: (p: string) => string | null, filePath: string): string {
  let t: string | null = null
  try {
    t = readTitle(filePath)
  } catch {
    t = null
  }
  return t?.trim() || baseName(filePath)
}

export function buildContentItems(input: BuildContentItemsInput): ContentItemView[] {
  const { assets, readSpec, tasks, readTitle, slug } = input

  const copies = assets.filter((a) => a.type === 'copy').sort((a, b) => a.id - b.id)
  const covers = assets.filter((a) => a.type === 'cover')

  // 渲染出来的 video（upload 上传成片不参与内容工位聚合，归成片库），按 sourceAssetId 归组
  const videosByCopy = new Map<number, AssetRow[]>()
  for (const v of assets) {
    if (v.type !== 'video' || v.origin === 'upload') continue
    const specPath = v.spec_path
    if (!specPath) continue // 没有素材包的老视频：不关联，也不炸
    let sourceAssetId: unknown = null
    try {
      sourceAssetId = readSpec(specPath)?.semantic?.sourceAssetId ?? null
    } catch {
      continue // spec 读不到 / 不是 JSON：fail-soft
    }
    if (typeof sourceAssetId !== 'number') continue
    const arr = videosByCopy.get(sourceAssetId) ?? []
    arr.push(v)
    videosByCopy.set(sourceAssetId, arr)
  }

  return copies.map((copy, i): ContentItemView => {
    const coverRow = covers.find((c) => stem(c.file_path) === stem(copy.file_path)) ?? null

    const vids = (videosByCopy.get(copy.id) ?? []).slice().sort((a, b) => a.id - b.id)
    const latest = vids.at(-1) ?? null

    const relatedTasks = tasks.filter(
      (t) => t.meta?.kind === 'video' && t.meta.slug === slug && t.meta.sourceAssetId === copy.id,
    )
    const lastTask = relatedTasks.at(-1) ?? null
    const runningTask = relatedTasks.find((t) => t.status === 'running' || t.status === 'pending') ?? null

    let status: ContentStatus
    let progress: number | null = null
    let error: string | null = null
    if (runningTask) {
      status = 'rendering'
      progress = parseProgress(runningTask)
    } else if (lastTask?.status === 'failed' && !latest) {
      // 失败之后又渲出了关联视频，就按视频算——所以这里要求「其后没有更新的关联 video」
      status = 'failed'
      error = [...lastTask.events].reverse().find((e) => e.type === 'error')?.message ?? null
    } else if (!latest) {
      status = 'script_ready'
    } else if (latest.status === 'approved' || latest.status === 'published') {
      status = 'approved'
    } else {
      status = 'review'
    }

    return {
      id: copy.id,
      seq: i + 1,
      hook: copy.hook ?? null,
      status,
      title: readTitleSafe(readTitle, copy.file_path),
      copyAssetId: copy.id,
      cover: coverRow ? { assetId: coverRow.id, url: fileUrl(coverRow.file_path) } : null,
      render: latest
        ? {
            assetId: latest.id,
            assetIds: vids.map((v) => v.id),
            url: fileUrl(latest.file_path),
            specPath: latest.spec_path ?? null,
            version: vids.length,
            status: latest.status ?? 'draft',
          }
        : null,
      progress,
      error,
      warnings: parseWarnings(copy.warnings),
    }
  })
}
