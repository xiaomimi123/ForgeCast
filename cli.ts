#!/usr/bin/env tsx
import { spawn } from 'node:child_process'
import { createCtx, syncWorkspaceProjects } from '@forgecast/core'
import { generateCopy } from '@forgecast/copywriter'
import { addRepo, pickCandidate, scoutCandidates } from '@forgecast/scout'

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
    case 'scout': {
      const ctx = createCtx()
      // 兼容 --add=<url> 与 --add <url> 两种写法
      const addFlagIdx = rest.indexOf('--add')
      const addUrl = arg('add') ?? (addFlagIdx >= 0 ? rest[addFlagIdx + 1] : undefined)
      const wantsAdd = arg('add') !== undefined || addFlagIdx >= 0
      if (wantsAdd) {
        if (!addUrl || addUrl.startsWith('--')) { console.error('用法: forgecast scout --add=<repo-url>（或 --add <repo-url>）'); process.exit(1) }
        await addRepo(ctx, addUrl)
        console.log(`已投喂: ${addUrl}`)
        break
      }
      const topics = arg('topics')?.split(',').map((s) => s.trim()).filter(Boolean)
      const limit = arg('limit') ? Number(arg('limit')) : undefined
      console.log('抓取评分中（mock/live 由 .env 决定）…')
      const r = await scoutCandidates(ctx, { topics, limit })
      console.log(`发现 ${r.found}，评分 ${r.scored}，协议不过 ${r.rejected}\n`)
      const rows = ctx.db.prepare(
        "SELECT repo, stars, license, score, score_detail FROM candidates WHERE license_ok = 1 ORDER BY score DESC LIMIT 20",
      ).all() as any[]
      console.log('名次  score  stars  license      repo')
      rows.forEach((x, i) => {
        const why = x.score_detail ? JSON.parse(x.score_detail).rationale : ''
        console.log(`${String(i + 1).padStart(2)}   ${String(x.score).padStart(5)}  ${String(x.stars).padStart(6)}  ${(x.license ?? '').padEnd(12)} ${x.repo}  ${why}`)
      })
      break
    }
    case 'pick': {
      const repo = rest.find((a) => !a.startsWith('--'))
      if (!repo) { console.error('用法: forgecast pick <owner/repo>'); process.exit(1) }
      const ctx = createCtx()
      const { slug } = await pickCandidate(ctx, repo)
      console.log(`已立项: ${slug} → workspace/${slug}/source/（可接着 forgecast analyze ${slug}）`)
      break
    }
    default:
      console.log(`forgecast <command>
  dev                              启动 API(:4321) + Web(:5173)
  copy <slug> --hook=<型> [--n=N]  生成文案+封面（mock/live 由 .env 决定）
  scout [--topics=..] [--limit=N]  发现开源项目、协议过滤+评分入候选池
  scout --add <repo-url>           手动投喂一个 repo
  pick <owner/repo>                立项：建 workspace + 落源 README/目录树
（analyze/rebrand/video/knowledge/calendar 属后续里程碑项，未实现）`)
  }
}
main()
