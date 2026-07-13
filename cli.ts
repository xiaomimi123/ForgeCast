#!/usr/bin/env tsx
import { spawn } from 'node:child_process'
import { createCtx, syncWorkspaceProjects } from '@forgecast/core'
import { generateCopy } from '@forgecast/copywriter'

const [cmd, ...rest] = process.argv.slice(2)

function arg(name: string): string | undefined {
  const hit = rest.find((a) => a.startsWith(`--${name}=`))
  return hit?.split('=')[1]
}

async function main() {
  switch (cmd) {
    case 'dev': {
      // API + Web 一键起：子进程各自输出带前缀
      const procs = [
        { name: 'api', p: spawn('pnpm', ['--filter', '@forgecast/server', 'dev'], { stdio: 'pipe' }) },
        { name: 'web', p: spawn('pnpm', ['--filter', 'web', 'dev'], { stdio: 'pipe' }) },
      ]
      for (const { name, p } of procs) {
        p.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`))
        p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`))
        p.on('exit', (code) => { console.log(`[${name}] 退出 ${code}`); process.exit(code ?? 1) })
      }
      break
    }
    case 'copy': {
      const slug = rest.find((a) => !a.startsWith('--'))
      const hook = arg('hook') as any
      if (!slug || !hook) { console.error('用法: forgecast copy <slug> --hook=pain [--n=1]'); process.exit(1) }
      const ctx = createCtx()
      // 与 server 同款 workspace 同步（保证 CLI 单独可用），逻辑来自 core，避免内联重复 SQL
      syncWorkspaceProjects(ctx)
      const out = await generateCopy(ctx, {
        slug, hook, n: Number(arg('n') ?? 1), feedback: arg('feedback'),
        onProgress: (m) => console.log(`  ${m}`),
      })
      console.log(`\n完成 ${out.length} 个素材:`)
      for (const a of out) console.log(`  [${a.type}] workspace/${a.filePath}${a.warnings.length ? ` ⚠ ${a.warnings.join('；')}` : ''}`)
      break
    }
    default:
      console.log(`forgecast <command>
  dev                              启动 API(:4321) + Web(:5173)
  copy <slug> --hook=<型> [--n=N]  生成文案+封面（mock/live 由 .env 决定）
（scout/analyze/rebrand/video/knowledge/calendar 属后续里程碑项，未实现）`)
  }
}
main()
