# Gentelella 换皮改造清单

## 1. 品牌替换
- fork 源码 → 将 `Gentelella` 全局替换为 `生意眼`（备选：掌柜宝、勤老板），覆盖以下所有可见文件：
  - `README.md`、`docs/README.md`、`docs/getting-started.md`、`docs/architecture.md`、`docs/app-modules.md`、`docs/pages.md`、`docs/components.md`、`docs/forms.md`、`docs/charts.md`、`docs/faq.md`、`docs/deployment.md`、`docs/project-structure.md`、`docs/migration-v2.md`、`docs/data-adapter.md`、`docs/command-palette.md`、`docs/overlays.md`、`docs/pwa.md`、`AGENTS.md`、`CLAUDE.md`、`.github/copilot-instructions.md`、`changelog.md`
- Logo：`docs/screenshots/dark/*.png` 全部换为带新 Logo + 新品牌名的截图；UI 内 Logo 源文件（fork 后定位 `public/favicon.ico` 或 `src/assets/logo.png`）同步替换
- favicon：替换为生意眼图标（iconfont.cn 免费生成，圆角蓝底白字“眼”）
- 主题色：将主色改为 `#2563EB`（信任蓝），在 `index.html` 或 `src/assets/css/custom.css`（fork 后定位）中全局修改 CSS 变量

## 2. 删除项
- 原 GitHub 链接：
  - `README.md`：仓库地址、Star 徽章、`Fork me` 横幅
  - `CONTRIBUTING.md`：整个文件删除
  - `AGENTS.md`、`CLAUDE.md`：删除 GitHub 与原作者维护信息
- 捐赠链接：`README.md` 中 `Donate`/`Sponsor` 区块
- 英文文档入口：`docs/` 下 `getting-started.md`、`architecture.md`、`faq.md` 等 14 个英文文档，删除或翻译后替换为中文版
- 遥测上报：`.github/workflows/deploy-pages.yml` 及 fork 后 `src/` 中的 analytics/统计脚本代码（全局搜索 `analytics`、`gtag`、`track`）
- 竞品推广与原作者残留：
  - 删除整个 `docs/screenshots/dashboardpack/` 目录（admindek、apex、haze、svelteforge、tailpanel、zenith 共 6 套竞品截图）
  - 全仓库搜索并清除 `Colorlib`、`DashboardPack` 字样

## 3. 中文化 i18n
- 范围：登录页、仪表板导航、表格操作列、表单校验提示、图表 tooltip、设置页、用户管理
- 入口文件：
  - fork 后的 `index.html` 主模板：导航菜单、登录表单、按钮文案
  - `src/` 中 JS/TS 模板字符串：所有 `label`、`message`、`title` 常量改简体中文
  - `docs/README.md`：改为中文文档导航入口，单独保留一份 `docs/README.zh-CN.md`
- 实现方式：直接改模板字符串，不引入 vue-i18n/react-intl 等框架，降低维护成本

## 4. 本土化新增功能
- 微信扫码登录 + 公众号消息提醒（库存预警、订单通知）：
  - 新增 `src/modules/wechat-auth.js`，对接微信开放平台 OAuth 2.0，扫码回调后写入 token
  - 对接公众号模板消息：库存低于阈值时 push“库存不足”，订单状态变更时 push“发货通知”
- 对接抖音/拼多多/淘宝订单：
  - 新增 `src/modules/order-sync.js`，参考 `docs/data-adapter.md` 的 adapter 模式
  - 定时拉取平台订单 → 自动生成本地订单 → 扣减库存 → 回传发货状态（首期先接抖音，跑通后扩展）
- 可选：语音记账（Web Speech API 识别“进 20 箱可乐，每箱 30 元”自动生成单据），低优先级

## 5. 部署
- 方案：Cloudflare Pages（免费版）
  1. 移植 `.github/workflows/deploy-pages.yml` 的构建逻辑为 Cloudflare Pages 构建配置
  2. 构建命令：`npm run build` 或 `npx vite build`（fork 后按 `package.json` 确认），若源码无需构建则直接发布 `docs/` 目录
  3. 输出目录：`dist/`（或 `docs/`）
  4. 项目名绑定：`shengyiyan.pages.dev`
- 产出 demo_url：`https://shengyiyan.pages.dev`

## 6. 录屏
- OBS 录制 3-5 分钟全流程操作，存储至 `raw/`：
  - 0:00–0:30 品牌登录页 + 微信扫码
  - 0:30–1:30 进销存核心：新建商品 → 入库 → 销售出库
  - 1:30–2:30 库存预警 + 抖音订单自动拉取
  - 2:30–3:30 销售趋势 Dashboard（ECharts）
  - 3:30–4:30 客户管理 + 报价单生成
  - 4:30–5:00 设置页（多门店、员工子账号）
- 输出：`raw/shengyiyan-demo.mp4`（1080p）

## 7. 合规自检
- 无 GPL 传染：`LICENSE.txt` 为 MIT，但需检查 fork 后 `src/` 与 `vendor/` 内第三方库（ECharts=Apache-2.0、Leaflet=BSD-2-Clause 等），确保各库版权声明保留
- 无原作者商标残留：全仓库搜索 `Colorlib`、`Gentelella`、`DashboardPack` 并清除
- MIT 协议合规：`LICENSE.txt` 保留原 `Copyright (c) 2020 Colorlib`，新增一行 `Copyright (c) 2025 生意眼团队`
- 新增 `THIRD_PARTY_NOTICES.md` 列明所有第三方库许可证