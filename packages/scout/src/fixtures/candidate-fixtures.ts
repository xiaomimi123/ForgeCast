import type { CandidateFixture } from '../types'

export const candidateFixtures: CandidateFixture[] = [
  {
    repo: 'chatwoot/chatwoot', url: 'https://github.com/chatwoot/chatwoot',
    description: '开源多渠道在线客服平台',
    license: 'MIT', stars: 21000, lastCommit: '2026-06-01T00:00:00Z', topics: ['live-chat', 'crm'],
    readme: 'Chatwoot 是开源的多渠道在线客服平台。React 前端 + Node，自带 Docker 部署。含 dashboard 界面，README 附 screenshot 与 demo 链接，支持 CRM 场景与 chat 收件箱。',
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
    readme: 'Formbricks 开源表单与问卷（survey）平台，Next.js + React，Docker 一键部署，界面有 preview 与 dashboard。',
    tree: ['apps/', 'Dockerfile', 'README.md', 'packages/'],
  },
  {
    repo: 'twentyhq/twenty', url: 'https://github.com/twentyhq/twenty',
    description: '开源 CRM，React 前端与现代 dashboard',
    license: 'MPL-2.0', stars: 15000, lastCommit: '2026-06-15T00:00:00Z', topics: ['crm'],
    readme: 'Twenty 是开源 CRM，React 前端，现代 UI 与 dashboard，Docker 支持，README 有 demo 与 screenshot。',
    tree: ['packages/', 'Dockerfile', 'README.md'],
  },
  {
    repo: 'gpl-example/copyleft-tool', url: 'https://github.com/gpl-example/copyleft-tool',
    description: '开源库存管理工具（GPL，用于触发协议 gate）',
    license: 'GPL-3.0', stars: 4000, lastCommit: '2026-04-01T00:00:00Z', topics: ['inventory'],
    readme: 'A copyleft inventory tool. Node backend with docker. (协议不可商用，用于触发 gate)',
    tree: ['src/', 'Dockerfile', 'README.md'],
  },
]
