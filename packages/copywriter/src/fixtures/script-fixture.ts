/** mock 拍摄脚本：把口播脚本原文逐段搬进固定骨架。绝不调用 ctx.llm（仓库铁律）。 */
export function mockShootScript(douyinScript: string): string {
  return [
    '# 拍摄脚本（mock）',
    '',
    '## 开拍前准备',
    '- 手机竖屏 1080×1920，光线充足',
    '- 台词打印或提词器就位',
    '',
    '## 分镜表',
    '',
    douyinScript.trim(),
    '',
    '## 剪辑提示',
    '- mock 模式骨架：live 模式会为每镜补机位/景别/道具/拍摄要点',
  ].join('\n')
}
