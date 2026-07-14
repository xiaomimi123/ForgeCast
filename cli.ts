#!/usr/bin/env tsx
import { spawn } from 'node:child_process'
import { analyzeProject } from '@forgecast/analyst'
import { createCtx, syncWorkspaceProjects } from '@forgecast/core'
import { generateCopy } from '@forgecast/copywriter'
import { addLead, calendarSuggestions, publishAsset, recordPerf, weeklyReport } from '@forgecast/ops'
import { rebrandPlan } from '@forgecast/rebrand'
import { addRepo, pickCandidate, scoutCandidates } from '@forgecast/scout'
import { generateVideo } from '@forgecast/studio'

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
    case 'analyze': {
      const slug = rest.find((a) => !a.startsWith('--'))
      if (!slug) { console.error('用法: forgecast analyze <slug>'); process.exit(1) }
      const ctx = createCtx()
      const { path: rel } = await analyzeProject(ctx, slug, { onProgress: (m) => console.log(`  ${m}`) })
      console.log(`分析完成: workspace/${rel}`)
      break
    }
    case 'rebrand': {
      const slug = rest.find((a) => !a.startsWith('--'))
      if (!slug) { console.error('用法: forgecast rebrand <slug>'); process.exit(1) }
      const { path: rel } = await rebrandPlan(createCtx(), slug, { onProgress: (m) => console.log(`  ${m}`) })
      console.log(`换皮清单完成: workspace/${rel}`)
      break
    }
    case 'video': {
      const slug = rest.find((a) => !a.startsWith('--'))
      if (!slug) { console.error('用法: forgecast video <slug> --tpl=flash|story|demo [--asset=<id>]'); process.exit(1) }
      const ctx = createCtx()
      const assetArg = arg('asset')
      // tpl 白名单：story/demo 显式放行，其余（含未传）回落 flash
      const tpl = (['story', 'demo'] as const).includes(arg('tpl') as any) ? (arg('tpl') as 'story' | 'demo') : 'flash'
      if (rest.includes('--cut') || arg('cut') !== undefined) {
        console.log('  ⚠ --cut：videocut 预处理占位，本版未实装（需装 videocut-skills + 火山 ASR key），继续常规渲染')
      }
      const { filePath } = await generateVideo(ctx, {
        slug, tpl, assetId: assetArg ? Number(assetArg) : undefined,
        onProgress: (m) => console.log(`  ${m}`),
      })
      console.log(`视频完成: workspace/${filePath}`)
      break
    }
    case 'publish': {
      const id = rest.find((a) => !a.startsWith('--'))
      const platform = arg('platform')
      if (!id || !platform) { console.error('用法: forgecast publish <assetId> --platform=<xhs|douyin> [--url=<link>]'); process.exit(1) }
      publishAsset(createCtx(), Number(id), { platform, url: arg('url') })
      console.log(`已回填发布: 素材 ${id} @ ${platform}`)
      break
    }
    case 'perf': {
      const id = rest.find((a) => !a.startsWith('--'))
      if (!id) { console.error('用法: forgecast perf <assetId> --views=N --likes=N --leads=N'); process.exit(1) }
      recordPerf(createCtx(), Number(id), {
        views: arg('views') ? Number(arg('views')) : undefined,
        likes: arg('likes') ? Number(arg('likes')) : undefined,
        leads: arg('leads') ? Number(arg('leads')) : undefined,
      })
      console.log(`已回填数据: 素材 ${id}`)
      break
    }
    case 'lead': {
      const id = rest.find((a) => !a.startsWith('--'))
      if (!id) { console.error('用法: forgecast lead <assetId> --wechat=<..> [--intent=<..>]'); process.exit(1) }
      const { id: leadId } = addLead(createCtx(), { assetId: Number(id), wechat: arg('wechat'), intent: arg('intent') })
      console.log(`已登记询单 #${leadId}（来源素材 ${id}）`)
      break
    }
    case 'calendar': {
      const v = calendarSuggestions(createCtx())
      console.log(`${v.date}｜今日已发 ${v.publishedToday}，还可发 ${v.remainingToday}`)
      console.log(`库存: ${JSON.stringify(v.inventory)}`)
      console.log(`冷却中: ${JSON.stringify(v.cooldown)}`)
      if (v.suggestions.length) {
        console.log('建议发布:')
        for (const s of v.suggestions) console.log(`  [${s.hook}] 素材 ${s.assetId} — ${s.reason}`)
      } else {
        console.log('（今日无建议：额度用尽或无可发库存）')
      }
      break
    }
    case 'report': {
      const r = weeklyReport(createCtx(), arg('since'))
      console.log(`周报（自 ${r.since}）  钩子 | 发布 | 询单`)
      for (const [hook, s] of Object.entries(r.perHook)) console.log(`  ${hook.padEnd(10)} ${String(s.published).padStart(4)} ${String(s.leads).padStart(6)}`)
      console.log(`  合计: 发布 ${r.totals.published}，询单 ${r.totals.leads}`)
      break
    }
    default:
      console.log(`forgecast <command>
  dev                              启动 API(:4321) + Web(:5173)
  copy <slug> --hook=<型> [--n=N]  生成文案+封面（mock/live 由 .env 决定）
  scout [--topics=..] [--limit=N]  发现开源项目、协议过滤+评分入候选池
  scout --add <repo-url>           手动投喂一个 repo
  pick <owner/repo>                立项：建 workspace + 落源 README/目录树
  analyze <slug>                   生成商业化分析 analysis.md（读 source/README）
  rebrand <slug>                   生成换皮改造清单 rebrand-plan.md（读 analysis）
  video <slug> --tpl=flash         生成 flash 视频（渲染 copy 素材为 15s 竖屏）
  publish <id> --platform=<xhs|douyin>  回填发布（平台/链接）
  perf <id> --views=N --likes=N --leads=N  回填曝光/赞/询单
  lead <id> --wechat=<..>               登记询单（归因到素材）
  calendar                              今日排期建议 + 库存
  report [--since=YYYY-MM-DD]           各钩子转化周报
（knowledge 属后续里程碑项，未实现）`)
  }
}
main()
