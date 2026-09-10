# 素材图层入口（排版工作台第四期 D）设计

> 日期：2026-09-10　状态：设计已确认，待写实施计划
>
> 「可持续复用的特效与排版工作台」四方向收官期：A 画布拖拽（PR #5）→ C 预设与品牌 kit（PR #6）→ B 特效库（PR #7）→ **D 素材图层入口（本期）**。
> 地基大半已有：image/shape 层两端渲染、画布拖/缩、B 期卡片效果均已支持 image/shape——本期核心是「入口」与素材通路。

## 0. 决策记录

| 决策点 | 结论 |
|---|---|
| 图片来源 | 三条全做：本项目上传图（upload 流程扩 MIME）+ 项目已有截图（demo shots）+ 品牌 kit 带 logo |
| 形状范围 | rect/ellipse + 新增 line（分割线/下划线）；颜色描边圆角走 B 期字段零新机制 |
| 素材进包方式 | **拷贝**进素材包 `assets/media/<原名>`（图片小，不走④目录软链复杂度）；值快照——删素材库原文件不影响已出片 |

## 1. 数据与素材通路

- **图片**：剪辑台「加图片」开素材选择弹层（三分组：本项目 `origin='upload'` 图片 / demo 截图 shots / 上传新图）。选中→拷贝进 `assets/media/<原名>`→`content.src` 相对路径——与既有 image 层（demo shots）同通路，渲染端零改动。上传扩展：server MIME 白名单加 png/jpg/webp/svg，体积上限 10MB。
- **形状**：`LayerContent` shape 联合加 `'line'`（水平线，height 即粗细，`bg` 做线色）；两端渲染各补 line case（div 实现）。
- **品牌 kit 加 `logoAssetId?: number`**：设置页 kit 块加 logo 选择（列项目 upload 图片）。生成期 applyBrandKit 内自动加角落 logo 层：id `media-logo`、右上 60px 边距、宽 180px、全程显示、track=当前最大+1。已出片不回刷；剪辑台手动刷 kit 时已有 media-logo 则跳过（幂等）。
- **editing 新纯函数**（零 Node，姿势同 video-ops）：
  - `addImageLayer(spec, src, opts?)` / `addShapeLayer(spec, shape: 'rect'|'ellipse'|'line', opts?)`：id `media-<n>`（沿 cap-manual- 先例）、from:null、track=最大+1（自占新轨）、默认几何居中（图 640 宽；rect/ellipse 400×240；line 600×6）、start:0 duration:全片。
  - `removeMediaLayer(spec, layerId)`：仅 `media-` 前缀可删（含 media-logo），否则 throw——同 removeCaptionLayer 姿势。

## 2. UI 与交互

- **入口**：EditorPage 工具栏「＋素材」菜单（同 C 期「版式」菜单款）：「图片…」开选择弹层（缩略图网格三分组+上传按钮）；「矩形」「圆形」「线条」直接加。
- **加层后**：自动选中、画布立刻可拖/缩（⑤基建）、Inspector 出 B 期效果字段、时间轴新轨可拖 start/duration。一次加层=一步 undo。
- **删除**：ShotList/时间轴对 `media-` 层出显式删除小按钮+in-app confirm（图片无文本，不走「清空即删」）。
- **上传新图**：弹层内走既有 upload 接口；成功自动选中加层。
- 时间轴新轨复用既有 layoutRow 机制，无新机制。

## 3. 边界与测试

- 素材选择器只列本项目素材；引用跨项目素材 400（talk 校验先例）；拷贝失败报错不加层。
- kit logo：重新出片=全新 spec 天然重加（生成态语义）；剪辑台手动刷已有则跳过。
- 测试：editing 三函数全量单测+变异（前缀白名单/track 分配/幂等）；line 两端渲染断言+缺省零变化门禁；server MIME 正反；端到端真渲（图片+线条+logo 上片抽帧）；对照组 HF sha256 逐字节。
- 浏览器走查：加图/加形/拖缩/删/undo/上传新图/kit logo 出片。

## 4. 非目标

图片裁剪/滤镜；SVG 编辑；素材库管理页；视频画中画（另期）；logo 以外的 kit 自动素材；GIF/动图。

## 5. 风险与取舍

- svg 进 Remotion `<Img>`/HF `<img>` 的渲染一致性需真渲验证；风险点在字体内嵌 svg——验收时若不一致则 MIME 白名单去掉 svg 并记偏差。
- `media-<n>` 序号与 C 期角色键 `manual-image#n` 并行不冲突（角色推导按 cssClass/from 优先，media 层 from:null 无 cssClass 落 manual-* 桶——预设/版式对它们按序对位，增删会错位一格，与既有已知风险同款）。
- logo 层 track=最大+1 在层数多的 spec 上可能推高 z 序遮字幕——180px 角落图风险低，真机验收把关。

## 6. 实现偏差（落地后补记，2026-09-10）

按四个任务的实施与验收如实回填，本节只记**与上文设计不同**的地方。

| # | 设计原文 | 实际落地 | 理由 |
|---|---|---|---|
| 1 | 「加图片」拷进包的端点按 spec_path 反查视频 | 端点带 slug：`POST /api/projects/:slug/videos/:videoId/media-asset` | LIKE 反查脆弱，且会要求「必须已渲过一次」才能加图层——素材包在登记成片行之前就已存在 |
| 2 | `shotPath` 基准 = `shots/` 目录 | 基准放宽到**项目目录**，越界由「realpath + 项目目录前缀」双守卫钉死 | 项目内其他位置的图同样可用；软链穿越有专门用例 |
| 3 | logo 层由 `applyBrandKit` 加 | 由 `injectBrandLogo`（generate.ts）在出片管线里加 | 贴 logo 要读库 + 拷文件，是 Node 行为；`brand-kit.ts` 有「一行 fs/db 都不能有」的纯度门禁 |
| 4 | 形状层加进来即可见 | 加层时**同一次 apply** 补默认底色 `#C13A1B`（`--fc-accent` 同值字面量） | 两端 `.shape` 无基类底色，`bg` 不给就是全透明——加完像「点了没反应」 |
| 5 | 「圆形」＝椭圆 | 圆角规则写成 `.clip:has(> .shape-ellipse){border-radius:50%}`（compositions `base.css` + studio `FX_CSS` 两端各一条） | `LayerStyle.radius` 只接受 px，非正方形只能得到胶囊形；且底色/几何都落在**外层 `.clip`** 上（内层 `.shape-*` 不着色），圆角写内层真渲抽帧验过是无效的（填充率仍 1.000） |
| 6 | §5 风险：svg 渲染一致性存疑，不一致就从 MIME 白名单去掉 | **一致，svg 保留**：真渲抽帧 200×200 青色块填充率 1.000，与 png 同表现 | Chrome Headless 的 `<img>` 直接吃 svg；未验证字体内嵌 svg（非目标） |
| 7 | §3「对照组 HF sha256 逐字节一致」 | 差**一条规则**：`.clip:has(> .shape-ellipse){border-radius:50%}`（连注释 3 行）随 FX_CSS 进了所有 HTML；其余逐字节相同 | 第 5 条那条基类 CSS 是共享样式，天然进每份 HTML；不配素材的项目**渲染结果**不变 |
| 8 | —— | **图片层的 `<img>` 吃 `style.width/height`**：裸 `<img>` 分支拼 `display:block;width:<100%\|auto>;height:<100%\|auto>;object-fit:contain`（compositions `imgFit()` / studio `imgFitAttr()` 两端同值），两维都没设时不写任何内联样式＝自然尺寸旧行为 | 最终审查修复波。**作用域论证：裸 `<img>` 分支 ⟺ 素材层**——demo 截图层在 `lower()` 里恒被写 `phoneWrap`/`wideWrap` 两个 cssClass 之一，永远走不到裸分支；preset 套用剔 cssClass 只发生在素材层上。所以模板既有版式一个像素都不变（两端各一条「phoneWrap/wideWrap 的 img 零内联样式」门禁测试）。真渲抽帧复验：300×120 的 kit logo 设 `width:180` → 实测 180×72（等比 contain，此前是自然尺寸 300×120）；400×100 的图放进 200×200 的层 → 实测 200×50 |
| 9 | —— | `/files/*` MIME 表补 `.svg`/`.gif`，且 **`.svg` 单独加 `content-security-policy: sandbox`** | svg 此前落到 `application/octet-stream`，剪辑台预览里不显示。svg 是可执行文档（顶层导航打开会跑内嵌脚本），故只对这一支加 sandbox；其他类型不加，免得误伤靠脚本跑 GSAP 时间线的 `hf/` 产物页。`<img src="x.svg">` 渲染路径本就不执行脚本，出片/预览显示不受影响 |

### 遗留（backlog，本期不做）

- 撤销「加图片」不会回收已拷进素材包的文件（孤儿文件；重复上传同名会 `-1` 叠加）。
- 删素材不清理引用它的 `brand_kit.logoAssetId`（出片时只记一条 warning，不打断）。设置页已补前端兜底：
  匹配不到时重置下拉并提示「原 logo 素材已删除」，保存即清；库里的存量脏值仍需用户点一次保存才落地。
- upload 文件名未 sanitize 反斜杠（Windows 穿越；沿袭 upload-video 同款）。
- 素材轨最多分 3 道，第 4 层起按比例压扁（最矮 6px）。
- 图片层 `<img>` 不随层框缩放（见上表第 8 条）。
