import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/** 若表缺该列则补上（幂等迁移；CREATE TABLE IF NOT EXISTS 不会给已有表补列） */
function ensureColumn(db: Database.Database, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  }
}

/** 打开（必要时创建）数据库：WAL + 全量建表 + 幂等迁移，可重跑 */
export function openDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY,
  repo TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  license TEXT,
  license_ok INTEGER,
  stars INTEGER, last_commit TEXT,
  tech_stack TEXT,
  description TEXT,
  score REAL,
  score_detail TEXT,
  status TEXT DEFAULT 'candidate',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  candidate_id INTEGER REFERENCES candidates(id),
  brand_name TEXT,
  target_buyer TEXT,
  demo_url TEXT,
  price_deploy INTEGER,
  price_custom INTEGER,
  stage TEXT DEFAULT 'analysis'
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  type TEXT NOT NULL,
  hook TEXT,
  file_path TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  published_at TEXT, platform TEXT,
  published_url TEXT,
  perf TEXT,
  warnings TEXT
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER REFERENCES assets(id),
  wechat TEXT, intent TEXT,
  status TEXT DEFAULT 'new',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS knowledge_atoms (
  id INTEGER PRIMARY KEY,
  source TEXT DEFAULT 'dbskill',
  topic TEXT, content TEXT NOT NULL,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS tailor_requests (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  raw_need TEXT NOT NULL,
  lead_id INTEGER REFERENCES leads(id),
  status TEXT DEFAULT 'draft',
  proposal_path TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tailor_capabilities (
  id INTEGER PRIMARY KEY,
  request_id INTEGER REFERENCES tailor_requests(id),
  name TEXT NOT NULL,
  detail TEXT,
  keywords TEXT,
  decision TEXT DEFAULT 'pending',
  chosen_repo TEXT,
  sort INTEGER
);
CREATE TABLE IF NOT EXISTS tailor_wheels (
  id INTEGER PRIMARY KEY,
  capability_id INTEGER REFERENCES tailor_capabilities(id),
  repo TEXT NOT NULL, url TEXT NOT NULL,
  license TEXT, license_ok INTEGER,
  stars INTEGER, last_commit TEXT, description TEXT,
  score REAL, score_detail TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS topic_sources (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT,
  follower_count INTEGER,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(platform, handle)
);
CREATE TABLE IF NOT EXISTS viral_notes (
  id INTEGER PRIMARY KEY,
  source_id INTEGER REFERENCES topic_sources(id),
  platform TEXT NOT NULL,
  note_id TEXT NOT NULL,
  title TEXT NOT NULL,
  play_count INTEGER NOT NULL,
  like_count INTEGER NOT NULL,
  collect_count INTEGER,
  follower_count_at_scrape INTEGER,
  ratio REAL,
  scraped_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  UNIQUE(platform, note_id)
);
CREATE TABLE IF NOT EXISTS topic_patterns (
  id INTEGER PRIMARY KEY,
  hook_type TEXT NOT NULL,
  title_patterns TEXT NOT NULL,
  emotion_type TEXT NOT NULL,
  topic_clusters TEXT NOT NULL,
  recommended_topics TEXT NOT NULL,
  sample_note_ids TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS demand_signals (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  evidence TEXT,
  heat REAL,
  opportunity TEXT,
  status TEXT DEFAULT 'new',
  captured_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source, title)
);
CREATE TABLE IF NOT EXISTS demand_matches (
  id INTEGER PRIMARY KEY,
  signal_id INTEGER REFERENCES demand_signals(id),
  repo TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  license TEXT,
  license_ok INTEGER,
  stars INTEGER,
  last_commit TEXT,
  score REAL,
  score_detail TEXT,
  biz_mode TEXT,
  biz_plan TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS custom_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL,
  segment_count INTEGER NOT NULL,
  style_note TEXT,
  benchmark_path TEXT,
  segments_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts USING fts5(content, topic, content='knowledge_atoms', content_rowid='id');
CREATE TABLE IF NOT EXISTS style_presets (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, layer_kind TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS layout_templates (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, template TEXT NOT NULL,
  ratio TEXT NOT NULL DEFAULT 'portrait', payload TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS industries (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  note TEXT,
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS industry_queries (
  industry_id INTEGER PRIMARY KEY REFERENCES industries(id) ON DELETE CASCADE,
  keywords TEXT NOT NULL,
  model TEXT,
  generated_at TEXT
);
`)
  // 迁移：给 P1 建的旧 assets 表补 published_url（新库已含，此为兼容旧库）
  ensureColumn(db, 'assets', 'published_url', 'TEXT')
  // 迁移：给候选表补 GitHub 仓库简介列（新库已含，此为兼容旧库）
  ensureColumn(db, 'candidates', 'description', 'TEXT')
  // 迁移：候选详情/产品说明书缓存列（新库已含，此为兼容旧库）
  ensureColumn(db, 'candidates', 'intro_detail', 'TEXT')
  // 迁移：候选收藏标记（scout UPSERT 不含此列，每日自动抓取不会覆盖收藏）
  ensureColumn(db, 'candidates', 'favorite', 'INTEGER DEFAULT 0')
  // 迁移：选题库抓取请求排队（新库已含，此为兼容旧库）
  ensureColumn(db, 'topic_sources', 'scrape_requested_at', 'TEXT')
  ensureColumn(db, 'topic_sources', 'last_scraped_at', 'TEXT')
  // 迁移：视频素材来源（rendered 模板渲染 / upload 用户上传成片）与审片报告 JSON（覆盖式，同 perf 先例）
  ensureColumn(db, 'assets', 'origin', "TEXT DEFAULT 'rendered'")
  ensureColumn(db, 'assets', 'review', 'TEXT')
  ensureColumn(db, 'assets', 'retro', 'TEXT')
  // 迁移：候选来源标记（scout 自动抓取/找爆款 / manual 用户手动投喂），前端"自主投喂" tab 靠这个筛
  ensureColumn(db, 'candidates', 'source', "TEXT DEFAULT 'scout'")
  // 迁移：换皮四关验收结果（JSON blob，同 candidates.score_detail 先例），供拆解页待验收/已完成区块读取
  ensureColumn(db, 'projects', 'rebrand_exec_result', 'TEXT')
  // 迁移：视频素材包路径（VideoSpec JSON，workspace 相对路径），供剪辑台定位可编辑的视频
  ensureColumn(db, 'assets', 'spec_path', 'TEXT')
  // 迁移：项目品牌 kit（JSON blob：主色/强调色/标题倍数/CTA 文案），出片时自动套用
  ensureColumn(db, 'projects', 'brand_kit', 'TEXT')
  // 迁移：候选归属行业（可空，行业锚定选品用；新库已含，此为兼容旧库）
  ensureColumn(db, 'candidates', 'industry_id', 'INTEGER')

  // seed 默认行业（INSERT OR IGNORE 按 name 唯一去重，幂等：删一行再 openDb 会补回）
  const defaultIndustries: Array<{ name: string; note: string }> = [
    { name: '资讯媒体', note: '做资讯号的老板要盯热点时效、素材去重、多平台分发排期' },
    { name: '情感社交', note: '做情感号的老板要管私域加粉话术、咨询转化脚本、案例素材合规' },
    { name: '教育培训', note: '做教育培训的老板要管课程排期、招生获客、试听转化、续费催费' },
    { name: '外贸跨境', note: '做外贸的老板要管客户询盘、报价单、物流单据、多币种结算' },
    { name: '本地生活服务', note: '做本地生活服务的老板要管到店预约、核销核销、点评口碑、会员储值' },
    { name: '健康养生', note: '做健康养生的老板要管体验预约、疗程跟进、客户档案、复购提醒' },
    { name: '汽车房产', note: '做汽车房产的老板要管带看预约、客户跟进、合同审批、佣金结算' },
    { name: '餐饮零售', note: '做餐饮零售的老板要管排班库存、进销存对账、会员积分、外卖对接' },
  ]
  const insertIndustry = db.prepare(
    'INSERT OR IGNORE INTO industries (name, note, enabled, sort_order) VALUES (?, ?, 1, ?)',
  )
  defaultIndustries.forEach((ind, i) => insertIndustry.run(ind.name, ind.note, i))

  return db
}
