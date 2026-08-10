# 老板后台Pro 换皮改造清单

## 1. 品牌替换
- [ ] Fork 仓库并改名为 `laoban-admin-pro`，移除 remote 指向新 Git 仓库地址
- [ ] 全局替换品牌名（`Ant Design Pro` → `老板后台Pro`）：
  - `README.md`（标题/简介/徽章 alt 文案）
  - `README.zh-CN.md`（标题/简介）
  - `config/defaultSettings.ts`（`title` 字段改为"老板后台Pro"）
  - `config/config.ts`（`document.title`、`manifest` 描述）
  - `package.json`（`name`、`description`、`author` 字段）
- [ ] 替换 Logo / favicon：
  - `config/defaultSettings.ts` 中 `logo` 字段指向新 logo 路径
  - 覆盖 `public/favicon.ico`（若目录树未列出，需在仓库根目录确认并新增）
  - 替换登录页/侧边栏品牌图（依赖 `src/components/RightContent` 或 `src/pages/User/Login` 中引用的 logo 文件，若存在）
- [ ] 替换主题色：
  - `config/defaultSettings.ts` 中 `colorPrimary` 改为自有品牌色（如 `#E60000` 或 `#1B5E20`）
  - 同步更新 `src/global.less` 或 `src/global.tsx` 中 CSS 变量覆盖（若存在）

## 2. 删除项
- [ ] 删除原 GitHub 链接：
  - `README.md` 中的 GitHub 仓库链接、star 徽章链接、demo 在线预览链接
  - `README.zh-CN.md` 中的仓库链接、Issues 入口链接
  - `package.json` 中 `homepage`、`repository`、`bugs` 字段清除或改自有地址
- [ ] 删除捐赠链接：
  - 删除 `.github/FUNDING.yml` 整个文件
  - 删除 `README.md` / `README.zh-CN.md` 中的赞助/捐赠横幅区域
- [ ] 删除英文文档入口：
  - 删除 `docs/cheatsheet.en-US.md` 文件
  - 删除 `README.md` 中的 Language 切换链接（英文/中文切换）
  - `docs/roadmap/` 下仅保留中文 `.zh-CN.md` 文档，删除多余英文版本（若存在）
- [ ] 删除遥测上报与 CI 上报：
  - 删除 `.github/workflows/coverage.yml`、`codecov.yml`（Coverage 上报）
  - 删除 `.github/workflows/antd-cli.yml`、`emoji-helper.yml`、`issue-labeled.yml`（原仓库专属自动化）
  - 检查 `config/config.ts` 中 umi 插件 `analytics` 配置，如有则移除
- [ ] 删除 `cloudflare-worker/` 整个目录（国内用户用不上 mock 服务）
- [ ] 删除 `config/proxy.ts` 中指向 Cloudflare Worker 的代理配置

## 3. 中文化 i18n
- [ ] 全量中文化范围：登录/注册、菜单导航、表格操作列、表单校验提示、通知消息、设置页、Dashboard 所有卡片标题
- [ ] 入口文件：
  - `config/routes.ts`：所有路由 `name` 字段改为中文（如 `dashboard` → `工作台`，`list.table-list` → `表格`）
  - `config/routes.simple.ts`：同步路由中文名
  - `src/app.tsx`（若存在）：全局 `locale` 配置为 `zh-CN`
  - `src/locales/zh-CN/`（若存在）：补全所有缺翻译 key，删除英文 locale 目录或保留但设为 fallback
  - `config/config.ts`：`locale.default` 设为 `zh-CN`，`antd` 组件库语言包跟随
- [ ] 用 `README.zh-CN.md` 内容整体覆盖 `README.md`，确保唯一 README 全中文

## 4. 本土化新增功能
- [ ] 新增功能 1：微信扫码登录 + 企微/钉钉绑定
  - `src/pages/User/Login/index.tsx`（若存在）：新增"微信扫码登录"按钮，调用微信 OAuth2 获取 openid
  - 新增 `src/pages/User/BindAccount/index.tsx`：绑定企业微信/钉钉账号页面
  - 新增 `src/services/wechat.ts`：封装微信/企微/钉钉的登录与绑定 API
  - `config/routes.ts`：在 `User` 路由下增加 `/user/bind` 绑定入口
- [ ] 新增功能 2：一键对接抖音来客/美团商家后台数据看板
  - 新增 `src/pages/Dashboard/Merchant/index.tsx`：展示抖音来客/美团门店数据（订单、核销、评分）
  - 新增 `src/services/merchant.ts`：对接抖音来客/美团开放平台 API（或在后端做数据汇聚）
  - `config/routes.ts`：在 Dashboard 下挂载 `/dashboard/merchant` 菜单，中文名"商户数据看板"

## 5. 部署
- [ ] 静态构建：执行 `npm run build`，产物输出到 `dist/`
- [ ] 部署方案选一（推荐轻量服务器）：
  - 轻量服务器：阿里云/腾讯云轻量 2C2G，安装 Nginx，`dist/` 托管到 `/var/www/html`，配置 SSL 证书
  - Docker：新增 `Dockerfile`（`FROM nginx:alpine` + `COPY dist/ /usr/share/nginx/html`），docker-compose 一键启动
  - Cloudflare Pages（若保留 cloudflare-worker）：修改 `cloudflare-worker/wrangler.toml` 中 `name` 字段，绑定新域名
- [ ] 产出 demo_url：部署完成后提供 `https://demo.xxx.com`，确认可公网访问

## 6. 录屏
- [ ] 新建 `raw/` 目录
- [ ] 使用 OBS 录制 3-5 分钟全流程操作：
  - 登录（含微信扫码演示）→ 工作台 → 商户数据看板 → 表格增删改查 → 表单校验 → 权限切换 → AI 聊天页
- [ ] 输出文件存 `raw/demo.mp4`，同时导出封面图 `raw/cover.png`

## 7. 合规自检
- [ ] 协议合规：
  - 保留 `LICENSE` 文件中的 MIT 版权声明，注明基于 Ant Design Pro (MIT) 二次开发
  - 在 `README.md` 中新增"开源许可"段落，标明原项目来源链接
- [ ] 商标合规：
  - 全局搜索并移除所有"蚂蚁金服""Ant Design Pro"作为产品名的展示（`LICENSE` 中法律声明除外）
  - 删除原项目 favicon、Logo 中可能含有的蚂蚁/ antd 视觉元素
- [ ] 依赖审计：
  - 检查 `package.json` 所有依赖是否为 MIT/Apache-2.0 兼容协议，确认无 GPL/AGPL 传染
  - 确认无原项目官方品牌域名残留（如 `pro.ant.design` / `umijs.org` 跳转）