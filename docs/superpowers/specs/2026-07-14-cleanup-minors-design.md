# 遗留 Minor 清理 pass 设计

> 把各里程碑 defer 的、真有价值+安全+可验证的 Minor 批量修。跳过 calendar UTC 日(改本地时区会与 UTC 存的 published_at 冲突, 盲改有风险)、404 消息去重(多路由 cosmetic)、client TaskEvent result 缺失(无触发)。

## 修的项
1. **subscribeTask onerror**（apps/web/src/api.ts）：SSE 出错时只静默 close，不通知回调 → 按钮卡"生成中"。改为补发一个终止 error 事件（带 `closed` 守卫防 done 后重复触发）使各按钮(copy/analyze/scout/video)能恢复。本地单用户工具，SSE drop 少见，简单方案即可。
2. **cli.ts dev 孤儿进程**：`forgecast dev` 一个子进程退出 → process.exit，但另一个 server 子进程成孤儿(残留占端口)。退出前先 kill 兄弟进程。
3. **M6 CLI approve**：只能 publish 不能审核。ops 加 `approveAsset(ctx, assetId)`(status='approved', assert 存在) + CLI `forgecast approve <assetId>`。
4. **api.ts headers 浅覆盖**：`fetch(path, {headers:{...}, ...init})` 使 init.headers 覆盖掉默认 content-type。改为 `{...init, headers:{'content-type':'application/json', ...init?.headers}}`。
5. **copywriter generate.ts 双解析**：对同一 raw 调 parseCopyOutput 两次(L60 校验 + renderCovers 块内取 doc)。提前解析一次、复用。
6. **BoardPage 立项按钮**：`c.status !== 'picked'` → `c.status === 'candidate'`(语义更准, 未来加 rejected 态不误显)。

## 验证
- ops `approveAsset` 单测；copywriter/server 既有测试保持全绿；`pnpm -r test` 全绿。
- Web 改动门禁 tsc + build。
- cli dev orphan、subscribeTask onerror 靠代码审查 + 不破坏既有流程(copy/analyze 仍正常)。

## 约束
- 每项最小改动、不改行为语义(除修复本身)；中文注释；commit trailer。
- 不引入新依赖。
