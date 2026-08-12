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
CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts USING fts5(content, topic, content='knowledge_atoms', content_rowid='id');
`)
  // 迁移：给 P1 建的旧 assets 表补 published_url（新库已含，此为兼容旧库）
  ensureColumn(db, 'assets', 'published_url', 'TEXT')
  // 迁移：给候选表补 GitHub 仓库简介列（新库已含，此为兼容旧库）
  ensureColumn(db, 'candidates', 'description', 'TEXT')
  // 迁移：候选详情/产品说明书缓存列（新库已含，此为兼容旧库）
  ensureColumn(db, 'candidates', 'intro_detail', 'TEXT')
  // 迁移：候选收藏标记（scout UPSERT 不含此列，每日自动抓取不会覆盖收藏）
  ensureColumn(db, 'candidates', 'favorite', 'INTEGER DEFAULT 0')
  return db
}
