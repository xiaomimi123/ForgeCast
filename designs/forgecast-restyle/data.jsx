// 三版风格稿共用的候选假数据（内容取自真实产品语境，数值为演示用）
const FC_CANDS = [
  { owner: 'chatwoot', name: 'chatwoot', cat: '客服/IM', catShort: '客服', desc: '开源全渠道客服平台，网页/微信/邮件消息聚合工作台', stars: '22.4k', score: 86, license: 'MIT', buyer: '有淘宝/抖店的电商团队老板', pain: '客服分散在五个平台来回切，漏单率高', days: 2, fav: true, isNew: false },
  { owner: 'appsmith', name: 'appsmith', cat: '仪表盘/BI', catShort: 'BI', desc: '拖拽式内部工具与后台面板搭建器，连库即用', stars: '34.1k', score: 82, license: 'Apache-2.0', buyer: '想给工厂做数字看板的厂长', pain: '定制后台开发报价 5 万起，周期两个月', days: 1, fav: false, isNew: true },
  { owner: 'saleor', name: 'saleor', cat: '电商/商城', catShort: '电商', desc: 'Headless 电商内核，API 优先，多端商城随意拼装', stars: '21.0k', score: 79, license: 'BSD-3-Clause', buyer: '想做独立站的外贸工厂老板', pain: 'SaaS 商城月费贵且数据不在自己手里', days: 5, fav: false, isNew: false },
  { owner: 'easyappointments', name: 'easyappointments', cat: '预约/排期', catShort: '预约', desc: '轻量预约排班系统，客户自助订时段，短信提醒', stars: '3.6k', score: 76, license: 'GPL-3.0', buyer: '连锁美容院/口腔诊所店长', pain: '前台手工排班，爽约率 30%', days: 3, fav: false, isNew: true },
  { owner: 'invoiceninja', name: 'invoiceninja', cat: '财务/发票', catShort: '财务', desc: '开票+报价+收款一体，客户门户在线支付', stars: '8.9k', score: 74, license: 'Elastic-2.0', buyer: '接项目的设计/工程小工作室', pain: '月底对账开票要耗掉两个整天', days: 8, fav: true, isNew: false },
  { owner: 'heyform', name: 'heyform', cat: '表单/问卷', catShort: '表单', desc: '对话式表单构建器，转化率比传统问卷高一截', stars: '7.2k', score: 71, license: 'AGPL-3.0', buyer: '做私域运营的品牌操盘手', pain: '问卷星白嫖版带广告，品牌感差', days: 4, fav: false, isNew: false },
  { owner: 'documenso', name: 'documenso', cat: '文档/知识库', catShort: '文档', desc: '开源电子签署，合同在线签，留痕可审计', stars: '9.8k', score: 69, license: 'AGPL-3.0', buyer: '合同量大的中介/人力公司', pain: '打印-签字-扫描一套流程半天没了', days: 6, fav: false, isNew: true },
  { owner: 'twentyhq', name: 'twenty', cat: 'CRM/销售', catShort: 'CRM', desc: '新一代开源 CRM，Notion 手感的客户管理', stars: '25.7k', score: 67, license: 'AGPL-3.0', buyer: '十人以下销售团队的老板', pain: '纷享销客按人头收费，一年小两万', days: 2, fav: false, isNew: false },
]

const FC_NAV = ['找项目', '拆解需求', '做内容', '分发营销', '定制项目', '设置']
const FC_TABS = ['全部', '已收藏', '每日新增']
const FC_CATS = ['全部 (46)', '客服/IM (9)', '仪表盘/BI (8)', '电商/商城 (7)', 'CRM/销售 (6)', '预约/排期 (5)', '表单/问卷 (4)']

Object.assign(window, { FC_CANDS, FC_NAV, FC_TABS, FC_CATS })
