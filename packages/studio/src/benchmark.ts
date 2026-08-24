import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)
const FFPROBE_TIMEOUT_MS = 30_000
const FFMPEG_TIMEOUT_MS = 60_000

export const MIN_SEGMENTS = 2
export const MAX_SEGMENTS = 8
export const DEFAULT_DURATION_SEC = 15
const SCENE_THRESHOLD = 0.4

export interface PacingSegment { start: number; end: number }
export interface Pacing { durationSec: number; segments: PacingSegment[] }
export interface BenchmarkDeps {
  probe?: (videoPath: string) => Promise<number | null>
  detect?: (videoPath: string) => Promise<number[]>
}

/** ffprobe 读时长（秒）；失败/坏文件一律返 null（fail-soft，绝不抛错，同 review.ts 的 probeDuration）。 */
export async function probeBenchmarkDuration(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await pExecFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath],
      { timeout: FFPROBE_TIMEOUT_MS },
    )
    const v = Number(stdout.trim())
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

/** ffmpeg 场景切换检测，解析 showinfo 的 pts_time 拿切镜时间点；失败/无输出返回空数组（fail-soft）。 */
export async function detectSceneCuts(videoPath: string): Promise<number[]> {
  try {
    const { stderr } = await pExecFile(
      'ffmpeg',
      ['-i', videoPath, '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, '-f', 'null', '-'],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    )
    const matches = stderr.matchAll(/pts_time:(\d+\.?\d*)/g)
    return Array.from(matches, (m) => Number(m[1])).filter((n) => Number.isFinite(n))
  } catch {
    return []
  }
}

function evenSplit(durationSec: number, n: number): PacingSegment[] {
  const step = durationSec / n
  return Array.from({ length: n }, (_, i) => ({ start: i * step, end: i === n - 1 ? durationSec : (i + 1) * step }))
}

/**
 * 拆解对标视频节奏：ffprobe 时长 + ffmpeg 场景检测切镜时间点 → 连续分段。
 * 全程 fail-soft，绝不抛错：探测失败/检测不到切镜/切镜过密，均有对应回退规则。
 */
export async function analyzeBenchmark(videoPath: string, deps: BenchmarkDeps = {}): Promise<Pacing> {
  const probe = deps.probe ?? probeBenchmarkDuration
  const detect = deps.detect ?? detectSceneCuts
  let durationSec: number
  try {
    durationSec = (await probe(videoPath)) ?? DEFAULT_DURATION_SEC
  } catch {
    durationSec = DEFAULT_DURATION_SEC
  }

  let cuts: number[] = []
  try {
    cuts = (await detect(videoPath)).filter((t) => t > 0 && t < durationSec).sort((a, b) => a - b)
  } catch {
    cuts = []
  }

  const boundaries = [0, ...cuts, durationSec]
  let segments: PacingSegment[] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (boundaries[i + 1] - boundaries[i] > 0.1) segments.push({ start: boundaries[i], end: boundaries[i + 1] })
  }

  if (segments.length < MIN_SEGMENTS) {
    segments = evenSplit(durationSec, 3)
  } else if (segments.length > MAX_SEGMENTS) {
    const step = segments.length / MAX_SEGMENTS
    const picked = Array.from({ length: MAX_SEGMENTS }, (_, i) => segments[Math.min(segments.length - 1, Math.floor(i * step))])
    segments = picked.map((seg, i) => ({ start: seg.start, end: i < picked.length - 1 ? picked[i + 1].start : durationSec }))
  }

  return { durationSec, segments }
}
