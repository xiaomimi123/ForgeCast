import type Database from 'better-sqlite3'

/* 泳道阶段单一真源。前端 apps/web/src/pages/board/StageLanes.tsx 另有一份带中文标签的
   平行声明（web 不依赖 core，是浏览器包），改动此处需同步那边。 */
export const STAGES = ['analysis', 'rebranding', 'producing', 'publishing', 'selling'] as const
export type Stage = (typeof STAGES)[number]

export function isStage(v: unknown): v is Stage {
  return typeof v === 'string' && (STAGES as readonly string[]).includes(v)
}

/**
 * 只前进不后退：目标阶段排名 <= 当前排名则原地不动。
 * 当前 stage 不在枚举内（脏数据）按排名 -1 处理，即任何合法目标都视为推进。
 * 手拖（PATCH /api/projects/:slug body.stage）走另一条路径，不受此函数约束——用户仍可任意移动，包括往回拖。
 */
export function advanceStage(db: Database.Database, projectId: number, target: Stage): void {
  const row = db.prepare('SELECT stage FROM projects WHERE id = ?').get(projectId) as { stage: string } | undefined
  if (!row) return
  const current = (STAGES as readonly string[]).indexOf(row.stage)
  const next = STAGES.indexOf(target)
  if (next <= current) return
  db.prepare('UPDATE projects SET stage = ? WHERE id = ?').run(target, projectId)
}
