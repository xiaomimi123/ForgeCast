# Ant Design Pro 换皮改造清单

## 1. 品牌替换
- fork 源码 → 全局替换品牌名/Logo/favicon/主题色：
  - 品牌名：全局搜索 `Ant Design Pro` / `Ant Design` → 替换为「掌柜云」（备选：生意罗盘 / 店管家Pro）
  - 入口文件：`README.md`、`README.zh-CN.md`、`docs/cheatsheet.zh-CN.md`
  - 页面标题与描述：`config/config.ts`（`title`、`description`、`favicon` 字段）
  - 默认设置：`config/defaultSettings.ts`（`title`、`logo`、`primaryColor` 主题色）
  - 路由配置：`config/routes.ts`（`name` 字段中所有品牌相关命名）
  - favicon/logo：`public` 目录（如有 `favicon.png`、`logo.svg` 等，按目录树定位实际文件）
  - 登录页、顶栏、侧边栏等组件内文案：全局搜索 `antd pro` / `Ant Design Pro` / `ProLayout` 并替换

## 2. 删除项
- 原 GitHub 链接、捐赠链接、英文文档入口、遥测上报：
  - GitHub 仓库链接与徽章：`README.md`、`README.zh-CN.md`
  - 英文文档入口：删除 `docs/cheatsheet.en-US.md`，并在路由/菜单中移除所有 `en-US` 切换入口（`config/routes.ts`、`config/config.ts` 中的 locale 配置）
  - 捐赠链接：`.github/FUNDING.yml`（删除整个文件）
  - 遥测上报：全局搜索 `analytics`、`track`、`gtag`、`baidu`、`统计` 等关键词；重点检查 `src` 目录下的埋点组件、`config/config.ts` 中的 `scripts` 配置项；如有 `rc-footer` 或 `ProLayout` 自带的版权/反馈链接一并移除
  - 原作者商标/版权相关：`LICENSE` 中保留 MIT 版权声明，但删除其中非必要的作者商标字样（如 `Ant Design` 名称在 UI 上的展示）；删除页面底部 `Powered by Ant Design Pro` 等标识（在 `src/components` 或 `src/layouts` 中全局搜索定位）

## 3. 中文化 i18n
- 界面全量中文化的范围与入口文件：
  - 入口文件：`src/locales/zh-CN.ts`（或 `src/locales/zh-CN/` 目录）——确保所有菜单、按钮、提示语均已中文化
  - 默认语言设置为中文：`config/config.ts` 中 `locale: { default: 'zh-CN' }`
  - 删除英文语言包：移除 `src/locales/en-US.ts`（或 `en-US` 目录），并在 `config/config.ts` 中禁用 `en-US`
  - 路由/菜单中英文残留：`config/routes.ts` 中所有 `name` 字段配套 `locale` 文案需在 `src/locales/zh-CN` 中有对应翻译
  - 组件默认文案（如分页、表格空状态、表单校验提示）：全局搜索 `en-US` 相关词条，统一替换为中文
  - 日期/金额格式：在 `src/utils` 或 `config/defaultSettings.ts` 中设置 `dayjs.locale('zh-cn')`、货币符号 `¥`

## 4. 本土化新增功能
- 新增微信扫码登录 + 手机短信验证码：
  - 在 `src/pages/User/Login` 页面扩展登录方式，调用微信开放平台或企微扫码接口
  - 在 `src/services/user.ts`（或对应 API 定义）增加 `loginByWechat`、`loginBySms` 方法
  - 后端在 `cloudflare-worker/src/routes/user.ts` 中增加微信/sms 登录路由，并接入云厂商短信服务
- 新增订单/库存同步对接（抖店/美团/拼多多 + Excel 导入导出 + 小票打印）：
  - 在 `config/routes.ts` 中新增「订单同步」「库存管理」「小票打印」页面路由
  - 在 `src/services/` 下新增 `order-sync.ts`、`inventory.ts`、`print.ts` 等 API 模块
  - 前端页面新增：`src/pages/OrderSync`、`src/pages/Inventory`、`src/pages/Print`（参考现有 `List` 表格页模板改写）
  - 后端在 `cloudflare-worker/src/routes/` 中新增 `order-sync.ts`、`inventory.ts`，对接第三方开放平台 API
  - Excel 导入导出：使用 `xlsx` 库，在订单/商品/客户列表页增加导入导出按钮
  - 小票打印：接入浏览器打印或蓝牙小票机 SDK，在收银/订单详情页增加打印按钮

## 5. 部署
- 部署到 Cloudflare Pages/Workers（项目已自带 `cloudflare-worker`）：
  - 修改 `cloudflare-worker/wrangler.toml` 中的 `name`、`account_id`、`route` 等配置为自有域名/账号
  - 前端构建：执行 `npm run build`，将 `dist` 目录部署到 Cloudflare Pages（或在 `wrangler.toml` 中配置静态资源托管）
  - 后端 API 即为 `cloudflare-worker`，一并部署，并配置 CORS（已在 `src/utils/cors.ts`）
  - 产出 demo_url：例如 `https://zhangguiyun.pages.dev` 或 `https://admin.zhangguiyun.com`
- 备选部署：用 Docker 构建前端镜像 + Nginx 静态托管，后端 API 部署到轻量服务器（可配 `Dockerfile`，按需新增）

## 6. 录屏
- 使用 OBS 录制 3-5 分钟全流程操作：
  - 操作流程：登录（微信扫码/短信）→ 仪表盘查看今日营收/库存预警 → 新增一笔订单 → 调整库存 → 导入导出 Excel → 打印小票 → 权限设置
  - 录制内容需完整覆盖新增的本土化功能，体现「进销存+会员+多门店」场景
  - 视频文件保存至 `raw/` 目录，命名示例：`raw/demo_zhangguiyun_v1.mp4`
  - 若有音频讲解，需先写好口播脚本；无讲解则配字幕/操作高亮

## 7. 合规自检
- 确认无 GPL 传染：本项目为 MIT 协议，无 GPL 依赖；检查 `package.json` 中依赖均为 MIT/Apache-2.0 等宽松协议
- 无原作者商标残留：
  - 全局搜索 `Ant Design Pro`、`Ant Design`、`AntV` 等字样，确保 UI 上不再出现
  - 代码注释中去除 `Powered by Ant Design Pro`、`© 2021 Ant Design` 等版权标识
  - 保留 `LICENSE` 中 MIT 原始版权声明（法律要求），但可在 README 中注明「基于 MIT 项目二次开发」
- 确认自定义品牌名已注册商标风险排查：使用前在商标局官网检索「掌柜云」「店管家Pro」等是否已被注册，必要时改名
- 隐私合规：云端部署需配置用户协议、隐私政策页面；短信登录需获得用户授权；数据存储需加密备份