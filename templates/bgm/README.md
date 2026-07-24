# BGM 曲库

放无版权/可商用背景乐（.mp3/.wav/.m4a）。默认按文案 hook 情绪自动匹配、从对应情绪子文件夹随机选曲（见下）；未分情绪子文件夹时回落根目录随机挑。也可 `forgecast video ... --bgm=<文件名不含后缀>` 指定具体曲，`--no-bgm` 关闭。
首次用某曲会分析节拍并缓存 `<曲>.beats.json`（同目录）。
素材来源：Mixkit / Pixabay Music / YouTube Audio Library 等（注意各自授权，商用需确认）。
音频与 .beats.json 均 gitignore，不入库。

## 情绪子文件夹（自动选曲）

按文案 hook 自动匹配情绪、从对应子文件夹随机选曲：

| hook | 子文件夹 | 情绪 |
|---|---|---|
| pain 痛点 | `tense/` | 紧张 / 悬念 |
| sideline 副业 | `upbeat/` | 热血 / 励志 |
| infogap 信息差 | `tech/` | 科技 / 好奇 |
| story 故事 | `warm/` | 温情 |

把曲子丢进对应子文件夹即可；子文件夹缺失或空时回落根目录（= 不分情绪）。
`--mood=<键>` 手动指定情绪，`--bgm=<名>` 指定具体曲（跳过情绪），`--no-bgm` 出无 BGM 干净版。
