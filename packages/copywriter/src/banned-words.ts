/** 广告法 + 平台敏感词（初版清单，随实测迭代）。纯本地字符串匹配。 */
export const BANNED_WORDS = [
  '第一', '最好', '最强', '最佳', '最低价', '全网最',
  '顶级', '国家级', '世界级', '独家', '首选',
  '保证赚钱', '稳赚', '包赚', '躺着不动就赚', '零风险',
  '百分百', '100%有效', '无效退款',
]

export function checkBannedWords(text: string): string[] {
  return BANNED_WORDS.filter((w) => text.includes(w))
}
