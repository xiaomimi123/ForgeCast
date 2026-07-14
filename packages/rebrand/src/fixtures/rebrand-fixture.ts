/** 离线 mock 换皮清单：固定 7 段可执行 checklist，slug 填标题。不调 LLM。 */
export function mockRebrand(slug: string, analysis: string, tree: string): string {
  const firstDirs = tree.split('\n').filter((l) => l.trim()).slice(0, 3).join('、') || '（源目录树未提供）'
  return `# ${slug} 换皮改造清单

## 1. 品牌替换
- fork 源码，全局替换品牌名为「${slug}」（含 package.json name、README、页面标题）
- 换 Logo / favicon / 主题色（改品牌变量或主题配置文件）
- 重点目录（据目录树）：${firstDirs}

## 2. 删除项
- 移除原项目 GitHub 链接、Star/捐赠入口
- 移除英文文档入口与官网外链
- 关闭遥测/埋点上报（如有 analytics/telemetry 配置）

## 3. 中文化 i18n
- 界面文案全量中文化；若无 i18n 框架，先接一层
- 默认语言设为 zh-CN，日期/货币本地化

## 4. 本土化新增功能
- 按 analysis.md 建议新增 1-2 个本土化功能（如微信登录、对接抖店/微信客服）
- 优先做买家最认的那一个，先跑通再打磨

## 5. 部署
- 轻量服务器 Docker 部署（或 Cloudflare Pages/Workers），产出可访问 demo_url
- 配好数据库/环境变量，确认外网可打开

## 6. 录屏
- OBS 录制 3-5 分钟全流程操作（登录→核心功能→出效果），存 raw/
- 后续所有视频从这条素材切片复用

## 7. 合规自检
- 确认源项目协议可商用、无 GPL 传染（依赖树也过一遍）
- 无原作者商标/Logo 残留，无捐赠/官网外链残留

（离线 mock 清单，live 模式据 analysis.md 与目录树生成更具体路径）
`
}
