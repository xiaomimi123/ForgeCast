import type { Project } from '../../api'

interface ExecResult {
  status: string
  rounds: number
  reportPath: string
  gates?: { build: boolean; start: boolean; health: boolean; screenshot: boolean }
  screenshotPath?: string
}

/** rebrand_exec_result 是我们自己写入的 JSON，不是 LLM 输出——解析失败按"没跑过"处理即可，不用逐字段兜底。 */
function parseExecResult(raw: string | null): ExecResult | null {
  if (!raw) return null
  try { return JSON.parse(raw) as ExecResult } catch { return null }
}

function GateDot({ label, ok, buildFailed }: { label: string; ok: boolean; buildFailed?: boolean }) {
  const color = buildFailed ? 'bg-fire' : ok ? 'bg-green-600' : 'bg-hairline-strong'
  return <i title={label} className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />
}

/** "拆解"页新增区块：待验收（stage=rebranding 且跑过四关）/ 已完成（stage 更靠后且跑过四关）。
 *  不改 ProjectGroups.tsx 本身，只读同一份 projects 数据换个角度展示。 */
export default function AcceptanceSection({ projects, onOpenProject, onAdvance }: {
  projects: Project[]
  onOpenProject: (slug: string) => void
  onAdvance: (slug: string) => void
}) {
  const withExec = projects
    .map((p) => ({ p, exec: parseExecResult(p.rebrand_exec_result) }))
    .filter((x): x is { p: Project; exec: ExecResult } => x.exec !== null)

  const pending = withExec.filter((x) => x.p.stage === 'rebranding')
  const done = withExec.filter((x) => ['producing', 'publishing', 'selling'].includes(x.p.stage))

  if (withExec.length === 0) return null

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <section className="card p-4">
        <h3 className="mb-2 flex items-center gap-2 font-bold">
          待验收 <span className="stamp pending" style={{ width: 40, height: 40, fontSize: '0.6rem' }}>待验</span>
        </h3>
        {pending.length === 0 && <div className="text-sm text-faint">暂无</div>}
        {pending.map(({ p, exec }) => {
          const buildFailed = exec.status === 'build-failed'
          return (
            <div key={p.slug} className="mb-2 flex items-center gap-3 rounded border border-hairline bg-paper p-3 text-sm">
              <div className="flex gap-1.5" title="构建 / 启动 / 健康检查 / 截图">
                <GateDot label="构建" ok={exec.gates?.build ?? false} buildFailed={buildFailed} />
                <GateDot label="启动" ok={exec.gates?.start ?? false} />
                <GateDot label="健康检查" ok={exec.gates?.health ?? false} />
                <GateDot label="截图" ok={exec.gates?.screenshot ?? false} />
              </div>
              <div className="flex-1">
                <b>{p.brand_name || p.slug}</b>
                <span className="ml-2 text-xs text-faint">{exec.status}（{exec.rounds} 轮）</span>
              </div>
              <button className="btn-ink px-3 py-1 text-xs" onClick={() => onOpenProject(p.slug)}>查看报告</button>
              <button className="btn-fire px-3 py-1 text-xs" onClick={() => onAdvance(p.slug)}>验收通过</button>
            </div>
          )
        })}
      </section>

      <section className="card p-4">
        <h3 className="mb-2 flex items-center gap-2 font-bold">
          已完成 <span className="stamp" style={{ width: 40, height: 40, fontSize: '0.6rem' }}>验讫</span>
        </h3>
        {done.length === 0 && <div className="text-sm text-faint">暂无</div>}
        {done.map(({ p }) => (
          <div key={p.slug} className="mb-2 flex items-center gap-3 rounded border border-hairline bg-paper p-3 text-sm">
            <div className="flex-1">
              <b>{p.brand_name || p.slug}</b>
              <span className="ml-2 text-xs text-faint">workspace/{p.slug}/source-full/</span>
            </div>
            <button className="btn-ink px-3 py-1 text-xs" onClick={() => onOpenProject(p.slug)}>查看报告</button>
            {p.demo_url && <a className="btn-ink px-3 py-1 text-xs" href={p.demo_url} target="_blank" rel="noreferrer">打开演示站</a>}
          </div>
        ))}
      </section>
    </div>
  )
}
