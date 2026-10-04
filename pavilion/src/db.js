'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.PAVILION_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.PAVILION_DB || path.join(DATA_DIR, 'pavilion.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 背景等静态资源（content 存 data URL / 纯文本）
CREATE TABLE IF NOT EXISTS files(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- background
  content TEXT,                  -- data URL；可能为 NULL 表示“发布失败/缺失”
  content_type TEXT,
  status TEXT NOT NULL DEFAULT 'ready', -- ready | failed
  etag INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- 展区：编辑层数据。published_version 为导览可用版本快照的来源。
CREATE TABLE IF NOT EXISTS areas(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  floor TEXT DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  published_version INTEGER,
  updated_at INTEGER NOT NULL
);

-- 导览路线；version 与展区发布版本匹配，终端只允许进入可用版本
CREATE TABLE IF NOT EXISTS routes(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  area_ids_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS weekly_rules(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekdays_json TEXT NOT NULL,     -- [1..6?] 0=Sun
  open TEXT NOT NULL,              -- HH:mm
  close TEXT NOT NULL,             -- HH:mm（<= open 表示跨午夜）
  state TEXT NOT NULL DEFAULT 'open',
  name TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS holidays(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,        -- YYYY-MM-DD（展馆时区）
  end_date TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'closed',
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- 临时事件：绝对 UTC 时间。version 为乐观锁，两人同时改时后写者收到冲突。
CREATE TABLE IF NOT EXISTS temporary_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  state TEXT NOT NULL,             -- open | closed
  reason TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT DEFAULT 'admin',
  updated_by TEXT DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 发布版本（不可变快照）。撤销不删行，status='revoked' 并记录原因。
CREATE TABLE IF NOT EXISTS publications(
  version INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'released', -- released | revoked
  snapshot_json TEXT NOT NULL,
  note TEXT DEFAULT '',
  revoke_reason TEXT,
  created_by TEXT DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- 设备分组：发布版本、包新鲜度期限（TTL，毫秒）、允许时钟漂移（毫秒）都绑定到分组
CREATE TABLE IF NOT EXISTS device_groups(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  published_version INTEGER,
  ttl_ms INTEGER NOT NULL DEFAULT 43200000, -- 12h
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices(
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  group_id TEXT REFERENCES device_groups(id),
  last_seen_ms INTEGER,
  last_ip TEXT,
  package_version INTEGER,
  package_received_at INTEGER,
  created_at INTEGER NOT NULL
);

-- 导览进入回执（幂等：同 package_nonce 只受理一次）
CREATE TABLE IF NOT EXISTS receipts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nonce TEXT UNIQUE,
  device_id TEXT,
  route_id TEXT,
  route_version INTEGER,
  package_version INTEGER,
  status TEXT NOT NULL,              -- accepted | rejected
  reject_reason TEXT,
  received_at INTEGER NOT NULL
);

-- 所有发布/撤销/编辑的可追踪原因
CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  actor TEXT DEFAULT 'admin',
  reason TEXT DEFAULT '',
  detail_json TEXT,
  at INTEGER NOT NULL
);
`);

const now = () => Date.now();

function getSetting(key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, String(value), now());
}

function audit(action, entity, entityId, actor, reason, detail) {
  db.prepare(`INSERT INTO audit_logs(action,entity,entity_id,actor,reason,detail_json,at)
    VALUES(?,?,?,?,?,?,?)`).run(action, entity, entityId == null ? null : String(entityId),
    actor || 'admin', reason || '', detail ? JSON.stringify(detail) : null, now());
}

// ---- 读取编辑层全部数据（管理网页“实际生效范围”基于它计算）----
function loadEditorState() {
  return {
    weekly: db.prepare('SELECT * FROM weekly_rules WHERE active=1 ORDER BY position,id').all()
      .map((r) => ({ id: r.id, active: !!r.active, weekdays: JSON.parse(r.weekdays_json), open: r.open, close: r.close, state: r.state, name: r.name })),
    holidays: db.prepare('SELECT * FROM holidays WHERE active=1 ORDER BY start_date,id').all()
      .map((r) => ({ id: r.id, active: !!r.active, name: r.name, start_date: r.start_date, end_date: r.end_date, state: r.state })),
    temporary: db.prepare('SELECT * FROM temporary_events WHERE active=1 ORDER BY start_ms').all()
      .map((r) => ({ id: r.id, active: !!r.active, name: r.name, start_ms: r.start_ms, end_ms: r.end_ms, state: r.state, reason: r.reason, row_version: r.row_version }))
  };
}

function loadReleasedAreasAndRoutes() {
  const areas = db.prepare('SELECT * FROM areas WHERE active=1 ORDER BY position,id').all()
    .map((a) => ({ id: a.id, name: a.name, description: a.description, floor: a.floor, version: a.published_version || a.version }))
    .filter((a) => a.version != null);
  const routes = db.prepare('SELECT * FROM routes WHERE active=1 ORDER BY id').all()
    .map((r) => ({ id: r.id, name: r.name, area_ids: JSON.parse(r.area_ids_json), version: r.version }));
  return { areas, routes };
}

function currentPublicationVersion() {
  const row = db.prepare("SELECT MAX(version) v FROM publications WHERE status='released'").get();
  return row.v || null;
}

// 生成并冻结一份发布快照（导览按钮引用的路线只与快照内展区版本匹配）
function publish(actor, note) {
  const tx = db.transaction(() => {
    const ver = (db.prepare('SELECT COALESCE(MAX(version),0)+1 v FROM publications').get().v);
    const bg = db.prepare("SELECT id,content,content_type,status,etag FROM files WHERE kind='background' ORDER BY updated_at DESC LIMIT 1").get();
    const snapshot = {
      version: ver,
      published_at: now(),
      timezone: getSetting('timezone', 'Asia/Shanghai'),
      welcome_text: getSetting('welcome_text', '欢迎莅临城市展馆'),
      schedule: loadEditorState(),
      ...loadReleasedAreasAndRoutes(),
      background: bg ? {
        file_id: bg.id, etag: bg.etag, content_type: bg.content_type,
        status: bg.status,
        // 失败记录不携带内容：终端必须回退，不能假装背景可用
        content: bg.status === 'ready' ? (bg.content || null) : null
      } : null
    };
    db.prepare(`INSERT INTO publications(version,status,snapshot_json,note,created_by,created_at)
      VALUES(?,?,?,?,?,?)`).run(ver, 'released', JSON.stringify(snapshot), note || '', actor || 'admin', now());
    setSetting('current_publication', ver);
    audit('publish', 'publication', ver, actor, note || '', { version: ver });
    return ver;
  });
  return tx();
}

function revoke(version, actor, reason) {
  const p = db.prepare('SELECT * FROM publications WHERE version=?').get(version);
  if (!p) throw Object.assign(new Error('版本不存在'), { status: 404 });
  if (p.status !== 'released') throw Object.assign(new Error('该版本已被撤销'), { status: 409 });
  if (!reason || !reason.trim()) throw Object.assign(new Error('撤销必须填写可追踪的原因'), { status: 400 });
  db.prepare("UPDATE publications SET status='revoked', revoke_reason=?, revoked_at=? WHERE version=?")
    .run(reason.trim(), now(), version);
  if (String(getSetting('current_publication', '')) === String(version)) {
    const prev = db.prepare("SELECT MAX(version) v FROM publications WHERE status='released' AND version<?").get(version).v;
    if (prev) setSetting('current_publication', prev);
    else db.prepare("DELETE FROM settings WHERE key='current_publication'").run();
  }
  audit('revoke', 'publication', version, actor, reason.trim(), {});
  return true;
}

module.exports = { db, now, getSetting, setSetting, audit, loadEditorState, loadReleasedAreasAndRoutes,
  currentPublicationVersion, publish, revoke, DATA_DIR };
