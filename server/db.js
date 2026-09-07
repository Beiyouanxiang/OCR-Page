import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
const DB_FILE = path.join(DATA_DIR, 'ocr.db')

function ensureMode(dir, file) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600)
  } catch (err) {
    console.warn('[db] 无法设置文件权限:', err.message)
  }
}

ensureMode(DATA_DIR, DB_FILE)

const db = new Database(DB_FILE)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// 初始化表结构
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ocr_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT,
    source_image TEXT NOT NULL,        -- 用于版面标注的原图（缩放到 MAX_STORE 后的 data URI）
    image_width INTEGER,
    image_height INTEGER,
    markdown TEXT NOT NULL,
    layout_json TEXT NOT NULL DEFAULT '[]',
    tokens_total INTEGER,
    elapsed_ms INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ocr_history_user_created
    ON ocr_history(user_id, created_at DESC);
`)

ensureMode(DATA_DIR, DB_FILE)

// ---------- 用户 ----------
export function createUser(username, passwordHash) {
  const now = Date.now()
  const stmt = db.prepare(
    'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'
  )
  const info = stmt.run(username, passwordHash, now)
  return { id: info.lastInsertRowid, username, created_at: now }
}

export function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username)
}

export function findUserById(id) {
  return db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id)
}

// ---------- OCR 历史 ----------
export function saveHistory(userId, record) {
  const stmt = db.prepare(
    `INSERT INTO ocr_history
      (user_id, title, source_image, image_width, image_height, markdown, layout_json, tokens_total, elapsed_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const info = stmt.run(
    userId,
    record.title || '',
    record.source_image,
    record.image_width || 0,
    record.image_height || 0,
    record.markdown,
    record.layout_json,
    record.tokens_total || 0,
    record.elapsed_ms || 0,
    Date.now()
  )
  return info.lastInsertRowid
}

export function getHistoryList(userId, limit = 100) {
  return db
    .prepare(
      `SELECT id, title, source_image, image_width, image_height, tokens_total, elapsed_ms, created_at
       FROM ocr_history
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(userId, limit)
}

export function getHistoryById(userId, id) {
  return db
    .prepare(
      `SELECT id, title, source_image, image_width, image_height, markdown, layout_json, tokens_total, elapsed_ms, created_at
       FROM ocr_history
       WHERE user_id = ? AND id = ?`
    )
    .get(userId, id)
}

export function deleteHistory(userId, id) {
  const info = db
    .prepare('DELETE FROM ocr_history WHERE user_id = ? AND id = ?')
    .run(userId, id)
  return info.changes > 0
}

export default db
