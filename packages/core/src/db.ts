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
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts USING fts5(content, topic, content='knowledge_atoms', content_rowid='id');
`)
  // 迁移：给 P1 建的旧 assets 表补 published_url（新库已含，此为兼容旧库）
  ensureColumn(db, 'assets', 'published_url', 'TEXT')
  ensureColumn(db, 'candidates', 'description', 'TEXT')
  return db
}
