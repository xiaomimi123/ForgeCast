/** mock 产品介绍解说词：固定骨架，不读 analysis.md 内容（mock 不编造）。绝不调用 ctx.llm（仓库铁律）。 */
export function mockProductIntroScript(slug: string): string {
  return [
    '# 产品介绍解说词（mock）',
    '',
    `## 开场`,
    `${slug} 是一款面向特定场景的开源工具，本片将带你快速了解它能做什么。`,
    '',
    '## 核心能力',
    '（此处应描述产品的 2-3 个核心功能亮点）',
    '',
    '## 结尾',
    '如果你也有类似需求，欢迎了解更多。',
    '',
    '## 说明',
    '- mock 模式骨架：live 模式会读取 analysis.md 生成真实的产品介绍解说词',
  ].join('\n')
}
