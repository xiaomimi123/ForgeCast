export const HOOKS = ['sideline', 'infogap', 'story', 'pain'] as const
export type HookType = (typeof HOOKS)[number]

export const HOOK_LABELS: Record<HookType, string> = {
  sideline: '副业型', infogap: '信息差型', story: '接单故事型', pain: '行业痛点型',
}
