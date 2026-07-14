# M5 ④ videocut 剪辑集成（脚手架，未实装）

> 状态：**未实装**。本文档说明集成路径；真实接入需火山引擎 ASR key + 装 videocut-skills 插件。

## 定位（开发文档 §6.4）

填补「原始录屏 → 可用素材」环节，与 Remotion 两层分工：

```
OBS 原始录屏(3-5分钟) → videocut(拆分镜/去废话/ASR字幕/竖屏导出)
                        → 精选片段 → Remotion(模板A 演示段 <OffthreadVideo>) → 成片
```

## 依赖

- 火山引擎「录音文件识别 2.0」API Key（中文 ASR，兼做字幕来源）——需注册开通。
- [Ceeon/videocut-skills](https://github.com/Ceeon/videocut-skills)：Claude Code 剪辑 Skills 包，可商用。

## 集成方式

1. 把 videocut-skills 装入 Claude Code 环境（与 Remotion skill 并存）。
2. `forgecast video <slug> --tpl=demo --cut`：渲染前先用 videocut 对 `workspace/<slug>/raw/` 的录屏做分镜/去废话/竖屏，产物作为模板A 演示段素材（替代直接用整段录屏）。
3. Agent 工作流：Claude Code 读写剪辑决策，人只看预览页、提修改意见、确认。

## 当前实现

- `forgecast video ... --cut` 已识别该标志，但**仅打印占位提示、不改变渲染**（未装插件/无 key 时不阻断）。
- 真实实装待：火山 ASR key + videocut-skills 插件 + `--cut` 调用其分镜产物填入演示段。
