import { serve } from '@hono/node-server'
import { createCtx, syncWorkspaceProjects } from '@forgecast/core'
import { createApp } from './app'
import { createTaskQueue } from './tasks'

const ctx = createCtx()
syncWorkspaceProjects(ctx)
const queue = createTaskQueue()
const app = createApp(ctx, queue)
serve({ fetch: app.fetch, port: 4321, hostname: '127.0.0.1' }, (info) => {
  console.log(`[forgecast] API 已启动 http://127.0.0.1:${info.port}（LLM 模式: ${ctx.config.llm.mode}）`)
})
