import type { CandidateFixture } from '../types'

export const candidateFixtures: CandidateFixture[] = [
  {
    repo: 'chatwoot/chatwoot', url: 'https://github.com/chatwoot/chatwoot',
    description: '开源多渠道在线客服平台',
    license: 'MIT', stars: 21000, lastCommit: '2026-06-01T00:00:00Z', topics: ['live-chat', 'crm'],
    readme: 'Chatwoot 是开源的多渠道在线客服平台。React 前端 + Node，自带 Docker 部署。含 dashboard 界面，README 附 screenshot 与 demo 链接，支持 CRM 场景与 chat 收件箱。内置 customer 档案、会话 api 与 database schema/migration。',
    tree: ['app/', 'app/javascript/', 'Dockerfile', 'docker-compose.yml', 'README.md', 'config/'],
  },
  {
    repo: 'invoiceninja/invoiceninja', url: 'https://github.com/invoiceninja/invoiceninja',
    description: '开源发票与报价系统，面向小商户开账单',
    license: 'Apache-2.0', stars: 8000, lastCommit: '2026-05-20T00:00:00Z', topics: ['invoice'],
    readme: 'Invoice Ninja 开源发票与报价系统，面向小商户开账单。含 Docker 部署与 dashboard，README 有 screenshot。',
    tree: ['app/', 'Dockerfile', 'README.md', 'resources/'],
  },
  {
    repo: 'formbricks/formbricks', url: 'https://github.com/formbricks/formbricks',
    description: '开源表单与问卷平台，Next.js 自部署',
    license: 'MIT', stars: 7000, lastCommit: '2026-06-10T00:00:00Z', topics: ['form-builder', 'survey'],
    readme: 'Formbricks 开源表单与问卷（survey）平台，Next.js + React，Docker 一键部署，界面有 preview 与 dashboard。提供提交记录 api 与 database schema。',
    tree: ['apps/', 'Dockerfile', 'README.md', 'packages/'],
  },
  {
    repo: 'twentyhq/twenty', url: 'https://github.com/twentyhq/twenty',
    description: '开源 CRM，React 前端与现代 dashboard',
    license: 'MPL-2.0', stars: 15000, lastCommit: '2026-06-15T00:00:00Z', topics: ['crm'],
    readme: 'Twenty 是开源 CRM，React 前端，现代 UI 与 dashboard，Docker 支持，README 有 demo 与 screenshot。含 customer/order 数据 model 与 REST api。',
    tree: ['packages/', 'Dockerfile', 'README.md'],
  },
  {
    // 模板硬排的**真实感**反例：README 满篇技术栈热词（Authentication / Prisma / API…），
    // 正是"名字像模板、内容也确实是空壳"的典型。词边界没加好时 Author→auth、rapid→api 会让它蒙混过关，
    // 拿技术栈词当业务实证时它还会拿满业务含量分——这条 fixture 就是钉死这两个坑的。
    repo: 'acme/nextjs-saas-starter', url: 'https://github.com/acme/nextjs-saas-starter',
    description: 'A production-ready SaaS starter template',
    license: 'MIT', stars: 3000, lastCommit: '2026-06-02T00:00:00Z', topics: ['boilerplate'],
    readme: 'Ship your SaaS in a weekend. Authentication with NextAuth, Stripe payments, Prisma ORM, Tailwind UI, dark mode, rapid prototyping, capital-efficient. Author: acme. Deploy to Vercel in one click.',
    tree: ['app/', 'README.md'],
  },
  {
    // 业务含量门槛的靶子：名字/描述都正常（模板硬排抓不到它），但 README 里既无业务实体也无数据层——
    // 图标库正是"能拍视频但没法卖给老板"的典型，该在评分后被 businessDepth 门槛挡在库外
    repo: 'lucide-icons/lucide', url: 'https://github.com/lucide-icons/lucide',
    description: '一套好看的开源图标',
    license: 'ISC', stars: 12000, lastCommit: '2026-06-12T00:00:00Z', topics: ['icons'],
    readme: 'Beautiful & consistent icons. Copy and paste the SVG into your project, or install the package. 1500+ icons, tree-shakable.',
    tree: ['icons/', 'README.md'],
  },
  {
    repo: 'copyleftlabs/copyleft-tool', url: 'https://github.com/copyleftlabs/copyleft-tool',
    description: '开源库存管理工具（GPL，用于触发协议 gate）',
    license: 'GPL-3.0', stars: 4000, lastCommit: '2026-04-01T00:00:00Z', topics: ['inventory'],
    readme: 'A copyleft inventory tool. Node backend with docker. (协议不可商用，用于触发 gate)',
    tree: ['src/', 'Dockerfile', 'README.md'],
  },
]
