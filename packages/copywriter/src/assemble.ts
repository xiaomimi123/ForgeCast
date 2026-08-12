import type { HookType } from '@forgecast/core'
import type { Atom } from './knowledge'

export interface AssembleInput {
  hook: HookType
  hookTemplate: string
  formatSpec: string
  patternsMd?: string
  knowledgeMd: string
  atoms: Atom[]
  analysis: string
  feedback?: string
}

/** 提示词组装，顺序遵循主文档 §5.6：钩子模板 + 知识包(system) + 检索原子 + analysis + 修改意见 */
export function assemblePrompt(i: AssembleInput): { system: string; prompt: string } {
  const atomsBlock = i.atoms.length
    ? i.atoms.map((a, k) => `${k + 1}. ${a.content}`).join('\n')
    : '（无）'
  const system = [
    '你是小红书/抖音内容创作专家，为"基于开源二次开发的产品"写引流内容。真实感优先，广告腔一票否决。',
    i.knowledgeMd,
  ].filter(Boolean).join('\n\n')
  const prompt = [
    `【钩子类型】${i.hook}`,
    i.hookTemplate,
    i.formatSpec,
    i.patternsMd ? `【选题风格参考】\n${i.patternsMd}` : '',
    `【方法论要点】\n${atomsBlock}`,
    `【商业化分析报告】\n${i.analysis}`,
    i.feedback ? `【用户修改意见，必须遵守】\n${i.feedback}` : '',
  ].filter(Boolean).join('\n\n---\n\n')
  return { system, prompt }
}
