# M5（子块③）— 模板A demo（产品演示型）设计

> M5 studio 第三口：主力视频模板 A（产品演示型）。复用子块②的 TTS/字幕/`renderVideo` 基础设施。
> **验证边界**（用户"搭着不验证"）：演示段需真实 OBS 录屏（raw/），无录屏时回退占位框；stub 全链路可测；真实渲染（含录屏 `<OffthreadVideo>`、真 TTS）待录屏/key，未验证。

## 目标

加 `generateVideo --tpl=demo`：钩子大字 → 痛点逐条 → **真实录屏为底 + 叠加标注/字幕** → 报价锚点对比 → CTA。30-60s。这是账号主力内容形态。

## 范围

**做**：Demo Remotion Composition（5 段，演示段用录屏或占位）；`buildDemoProps(doc)`；`generateVideo` 支持 `tpl='demo'`（找 raw/ 录屏作演示底、TTS、渲 Demo）；Root 注册 Demo；server/CLI tpl 白名单加 demo；vitest 全 stub 覆盖 props/generate。

**不做（本口）**：真实录屏渲染验证（无录屏）；标注框/箭头的精细动效编辑器；BGM；videocut 剪辑(④)；Docker(⑤)。

## 架构（复用子块①②）

`@forgecast/studio` 新增：
```
src/remotion/Demo.tsx    # 模板A：5 段，演示段 <OffthreadVideo src> 或占位
src/props.ts             # 追加 DemoProps + buildDemoProps
src/remotion/Root.tsx    # 注册 Flash+Story+Demo 三个 Composition
src/generate.ts          # tpl='demo' 分支：找录屏 + TTS + 渲 Demo
```
复用：`Subtitles.tsx`、`synthesizeVoice`、`renderVideo(entry, 'Demo', ...)`。

### DemoProps
```ts
interface DemoProps {
  painTitle: string          // 钩子大字（copy 封面主标题）
  painPoints: string[]       // 痛点逐条（analysis 痛点/copy）
  demoVideoSrc?: string      // 录屏(raw/)相对路径；无则占位
  priceAnchor: string        // 报价锚点一句（analysis 定价/兜底）
  cta: string
  brandName: string
  audioSrc?: string; cues?: Cue[]
}
```

### 数据流（demo）
```
generateVideo(slug, {tpl:'demo', assetId?})
  取 copy 素材 → parseCopyOutput → buildDemoProps(doc)
  找 workspace/<slug>/raw/ 下第一个视频文件(.mp4/.mov) → demoVideoSrc（有则用；无则占位）
  synthesizeVoice(doc.douyinScript) → audioSrc/cues
  写 props.json → renderVideo(entry,'Demo',props, mp4, video.mode)
  登记 video 素材
```

## 模板A Demo（Demo.tsx）

Composition `id="Demo"`，1080×1920/30fps，durationInFrames=1800（60s，固定；真实长度对齐待录屏 pass）。5 段 `<Sequence>`：
| 段 | 帧(30fps) | 内容 |
|---|---|---|
| 钩子 | 0-90(0-3s) | painTitle 大字弹入 |
| 痛点 | 90-240(3-8s) | painPoints 逐条弹出 |
| 演示 | 240-1350(8-45s) | `demoVideoSrc` ? `<OffthreadVideo src>` 为底 : 占位框「（演示录屏位）」；顶部可叠 painTitle 小标 |
| 报价锚点 | 1350-1560(45-52s) | priceAnchor 对比样式 |
| CTA | 1560-1800(52-60s) | cta + @brandName 水印 |
底部全程 `<Subtitles cues>`（若有）；`<Audio src={audioSrc}>`（若有）。字体 PingFang（同既有）。

`buildDemoProps(doc, brandName?)`：painTitle=cover.main||titles[0]；painPoints=从 doc.xhsBody/titles 取 2-3 条（模板化，兜底非空）；priceAnchor= 兜底「外面做要几万，我这套成本一顿火锅钱」（copy 里若有报价锚点行则用）；cta 复用 flash 抽取；均兜底不抛错。

## generate 改动

`generateVideo` 的 tpl 联合类型加 `'demo'`。demo 分支：buildDemoProps → 找 raw/ 录屏（`fs.readdirSync(workspace/<slug>/raw)` 取首个 `.mp4/.mov`，相对路径给 demoVideoSrc，无则 undefined）→ synthesizeVoice → props → renderVideo(...,'Demo',...)。flash/story 不变。

## 入口

- CLI：`forgecast video <slug> --tpl=demo`（现有 --tpl 解析放开 demo）。
- REST：`POST /api/projects/:slug/video` body tpl 白名单加 demo（`['flash','story','demo'].includes(body.tpl) ? body.tpl : 'flash'`）。

## 测试（TDD，全 stub）

`packages/studio/test/`：
- `buildDemoProps`：painTitle/painPoints(非空数组)/priceAnchor(非空)/cta/brandName。
- `generateVideo` tpl='demo'（video stub + tts stub）：无 raw 录屏 → props.demoVideoSrc undefined、仍产 props.json+占位 mp4+video 素材；有 raw 视频(造一个) → demoVideoSrc = 相对路径。
- Demo 组件不单测，靠 tsc。
`packages/server/test/video.test.ts`：追加 `{tpl:'demo'}` → video 素材。

真实录屏渲染不验证。

## 全局约束（沿用）

- studio main=src/index.ts 无 build；`@remotion/*` 动态 import；所有测试 stub；产物 workspace/<slug>/videos/ 相对路径；中文注释；TDD；trailer。
- Root.tsx Composition 用 cast 绕 Remotion v4 泛型（同既有）。

## 未决/后续

- 真实录屏渲染验证、演示段标注框/箭头动效、真实时长对齐（待录屏）；videocut(④) 产出的分镜作演示段素材；Docker renderer(⑤)。
