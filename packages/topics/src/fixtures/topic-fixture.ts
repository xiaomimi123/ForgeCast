import type { HookType } from '@forgecast/core'

export interface TopicPatternDraft {
  hookType: HookType
  titlePatterns: string[]
  emotionType: string
  topicClusters: string[]
  recommendedTopics: string[]
}

/** mock：写死 2 条不同 hook_type 的选题模式，离线可测，绝不走 ctx.llm。 */
export function mockTopicPatterns(): TopicPatternDraft[] {
  return [
    {
      hookType: 'pain',
      titlePatterns: ['做XX的还在手动XX？这个工具直接把效率翻X倍', 'XX还在用原始方式干活，同行早就换了'],
      emotionType: '同行吐槽+效率焦虑',
      topicClusters: ['提效工具安利', '行业老办法吐槽'],
      recommendedTopics: ['接单效率翻倍的3个工具', '同行都在用但我才知道的省时神器'],
    },
    {
      hookType: 'sideline',
      titlePatterns: ['下班后靠这个副业月入XX', '不用离职也能做的XX副业'],
      emotionType: '结果炫耀+身份认同',
      topicClusters: ['副业变现路径', '低门槛技能变现'],
      recommendedTopics: ['程序员下班后的副业清单', '技术人如何靠开源项目变现'],
    },
  ]
}
