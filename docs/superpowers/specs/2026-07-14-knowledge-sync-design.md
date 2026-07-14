# forgecast knowledge sync（知识原子摄取管线）设计

> 真·未开发的 §5.6 功能。当前 `knowledge_atoms` 表建了却从没填数据 → `searchAtoms` 一直空 → 文案知识只靠 `templates/knowledge/*.md` 整篇拼接。sync 把它变成真的摄取管线。

## 问题
- `knowledge_atoms(id, source DEFAULT 'dbskill', topic, content NOT NULL, meta)` 空表；`atoms_fts` 外部内容 FTS5 未用。
- `searchAtoms` 走 LIKE 但表空 → 返回 []；且 LIMIT 在排序前，命中相关性无序。
- `generate.ts` 把整个 knowledge 目录 md 拼进 system（大语料不可扩展）。

## 方案
### syncKnowledge(ctx, opts?) —— packages/copywriter/src/knowledge.ts
- 读源目录（默认 `ctx.config.paths.templates/knowledge`，`opts.source` 覆盖）下所有 `*.md`。
- 解析为原子：`parseAtoms(md, fileStem)` —— 逐行扫描，遇标题(`#`/`##`…)更新当前 topic；遇 `- `/`* ` 要点或 `1.` 编号项 → 一个原子(topic=当前标题或 fileStem, content=去掉标记的整行文本，跳过空/纯标题行)。
- 幂等替换：事务内 `DELETE FROM knowledge_atoms WHERE source='dbskill'` → 批量 `INSERT (source='dbskill', topic, content)` → `INSERT INTO atoms_fts(atoms_fts) VALUES('rebuild')` 同步 FTS。
- 返回 `{ count, files }`（count=入库原子数，files=读取的 md 文件数，供 CLI 打印）。
- 纯本地文件、不联网；真实 dbskill 语料由用户后续放入目录/`--source`。

### searchAtoms（改进）
- 仍 LIKE 召回，但取回全部命中后**按命中词数排序**（去掉 LIMIT-before-rank），再 slice(limit)。接口/返回类型不变。

### generate.ts 接入（一处）
- 先 `searchAtoms` 得 atoms；`knowledgeMd = atoms.length ? '' : <目录整包 md>`。已同步(有原子)→检索驱动、跳过整包(可扩展)；未同步→回落 P1 整包行为（**默认 db 无原子，现有 15 测试走回落路径不变**）。

### 入口
- CLI：`forgecast knowledge sync [--source=<dir>]`（打印同步条数）、`forgecast knowledge list`（列已入库原子 topic/content 摘要）。纯维护命令，CLI-only，不加 REST。

## 测试（TDD，全 mock/本地）
- `parseAtoms`：标题→topic、要点/编号→原子、跳过空行与纯标题。
- `syncKnowledge`：造临时 md 目录 → 入库条数正确、topic/content 对；**重跑幂等**（条数不翻倍）；FTS rebuild 不报错。
- `searchAtoms`：命中多词的原子排在前；空词返回 []。
- `generate`：sync 后（有原子）prompt 含原子内容且不含整包 dump 标记；未 sync（空原子）走整包 dump（回归现有行为）。

## 范围外
- 真实 dbskill 语料内容（用户提供）；FTS5 MATCH/embedding 检索（诚实原因：中文 2 字词 trigram 形不成三元组、召回差，LIKE 才对短中文正确；真升级需 embedding，属未来）；联网抓取；REST。

## 约束
- 沿用：copywriter main=src/index.ts 无 build；中文注释；TDD；trailer；不破坏 `pnpm -r test` 全绿。
