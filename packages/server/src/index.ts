import { serve } from '@hono/node-server'
import { createCtx, syncWorkspaceProjects } from '@forgecast/core'
import { createApp } from './app'
import { createTaskQueue } from './tasks'

const ctx = createCtx()
syncWorkspaceProjects(ctx)
const queue = createTaskQueue()
const app = createApp(ctx, queue)
// 容器内须绑 0.0.0.0（否则 compose 端口映射到不了）；安全靠 compose `127.0.0.1:4321:4321` host 侧只 localhost
const hostname = process.env.FORGECAST_HOST ?? '127.0.0.1'
serve({ fetch: app.fetch, port: 4321, hostname }, (info) => {
  console.log(`[forgecast] 已启动 http://${hostname}:${info.port}（LLM 模式: ${ctx.config.llm.mode}）`)
})
