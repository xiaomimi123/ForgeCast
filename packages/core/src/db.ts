import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/** 打开（必要时创建）数据库：WAL + 全量建表，幂等可重跑 */
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
  perf TEXT,
  warnings TEXT
);
CREATE TABLE IF NOT EXISTS knowledge_atoms (
  id INTEGER PRIMARY KEY,
  source TEXT DEFAULT 'dbskill',
  topic TEXT, content TEXT NOT NULL,
  meta TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts USING fts5(content, topic, content='knowledge_atoms', content_rowid='id');
`)
  return db
}
