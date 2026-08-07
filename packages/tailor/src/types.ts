export type TailorStatus = 'draft' | 'decomposed' | 'searched' | 'proposed'
export type CapabilityDecision = 'pending' | 'wheel' | 'self_build' | 'dropped'

export interface TailorRequest {
  id: number; title: string; raw_need: string; lead_id: number | null
  status: TailorStatus; proposal_path: string | null; created_at: string
}
export interface TailorWheel {
  id: number; capability_id: number; repo: string; url: string
  license: string | null; license_ok: number
  stars: number; last_commit: string | null; description: string | null
  score: number; score_detail: string
}
/** 能力项视图：keywords 已从 JSON 列解出，wheels 按分数倒序 */
export interface TailorCapabilityView {
  id: number; request_id: number; name: string; detail: string | null
  keywords: string[]; decision: CapabilityDecision; chosen_repo: string | null
  sort: number; wheels: TailorWheel[]
}
export interface TailorRequestDetail { request: TailorRequest; capabilities: TailorCapabilityView[] }
/** LLM/启发式拆解的单项产出 */
export interface DecomposedCapability { name: string; detail: string; keywords: string[] }
