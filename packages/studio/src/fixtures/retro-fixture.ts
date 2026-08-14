export interface RetroDraft { verdict: string; keep: string[]; change: string[]; focus: string }

/** mock 复盘：固定总评/保持/改进/最优先。绝不调用 ctx.llm（仓库铁律）。 */
export function mockRetroReport(): RetroDraft {
  return {
    verdict: '结构完整但钩子偏弱（mock 示例）',
    keep: ['录屏演示节奏清晰'],
    change: ['前3秒直接抛痛点', 'CTA 停顿一拍再说'],
    focus: '下一条优先把前3秒钩子改成直给痛点',
  }
}
