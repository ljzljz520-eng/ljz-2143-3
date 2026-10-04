/* 数据库层：SQLite（sql.js / WASM），文件持久化，写操作防抖落盘 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS weekly_rules(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday INT NOT NULL, open_min INT NOT NULL, close_min INT NOT NULL,
  label TEXT DEFAULT '', enabled INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS holidays(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL, name TEXT NOT NULL, closed INT DEFAULT 0,
  open_min INT, close_min INT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, kind TEXT NOT NULL,           -- 'closed' | 'open'
  zone_id INT,                                       -- NULL = 整馆
  start_at INT NOT NULL, end_at INT NOT NULL,
  priority INT DEFAULT 0,
  version INT DEFAULT 1,                             -- 乐观锁
  created_by TEXT, updated_by TEXT, created_at INT, updated_at INT);
CREATE TABLE IF NOT EXISTS zones(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, version INT DEFAULT 1, enabled INT DEFAULT 1, updated_at INT);
CREATE TABLE IF NOT EXISTS routes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, version INT DEFAULT 1,
  zone_refs TEXT NOT NULL,                           -- JSON [{zone_id, zone_version}]
  enabled INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS publications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INT NOT NULL, payload TEXT NOT NULL,
  valid_from INT NOT NULL, valid_until INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',             -- active | superseded | revoked
  note TEXT DEFAULT '', created_by TEXT, created_at INT,
  revoked_by TEXT, revoked_at INT, revoke_reason TEXT);
CREATE TABLE IF NOT EXISTS device_groups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, publication_id INT);
CREATE TABLE IF NOT EXISTS devices(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, group_id INT);
CREATE TABLE IF NOT EXISTS receipts(
  receipt_id TEXT PRIMARY KEY,                       -- 幂等键
  route_id INT, publication_id INT, device_id TEXT,
  started_at INT, completed_at INT, received_at INT,
  late INT DEFAULT 0, valid_at_start INT DEFAULT 0, note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INT NOT NULL, actor TEXT, action TEXT, entity TEXT, entity_id TEXT, detail TEXT);
`;

let db = null;
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_FILE, Buffer.from(db.export())); } catch (e) { console.error('db save failed', e); }
  }, 50);
}
function saveNow() { clearTimeout(saveTimer); fs.writeFileSync(DB_FILE, Buffer.from(db.export())); }

function run(sql, params) { db.run(sql, params || []); save(); }
function all(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params || []);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function one(sql, params) { return all(sql, params)[0] || null; }

function audit(actor, action, entity, entityId, detail) {
  run('INSERT INTO audit_log(at,actor,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?)',
    [Date.now(), actor || 'system', action, entity, String(entityId), JSON.stringify(detail || {})]);
}

function seed() {
  const weekly = [
    [2, 540, 1020, '周中日场 09:00–17:00'],
    [3, 540, 1020, '周中日场 09:00–17:00'],
    [4, 540, 1020, '周中日场 09:00–17:00'],
    [5, 600, 1560, '周五夜场 10:00–次日02:00'],   // 跨午夜：close_min=1560 > 1440
    [6, 540, 1080, '周末日场 09:00–18:00'],
    [0, 540, 1080, '周末日场 09:00–18:00']
  ];
  weekly.forEach(w => run('INSERT INTO weekly_rules(weekday,open_min,close_min,label) VALUES (?,?,?,?)', w));
  run("INSERT INTO holidays(date,name,closed) VALUES ('2026-01-01','元旦（闭馆）',1)");
  run("INSERT INTO holidays(date,name,closed,open_min,close_min) VALUES ('2026-10-01','国庆节特别场',0,600,960)");
  const now = Date.now();
  ['古代文明厅', '现代艺术厅', '临时特展厅'].forEach(n =>
    run('INSERT INTO zones(name,version,enabled,updated_at) VALUES (?,1,1,?)', [n, now]));
  const refs = JSON.stringify([{ zone_id: 1, zone_version: 1 }, { zone_id: 2, zone_version: 1 }]);
  run('INSERT INTO routes(name,version,zone_refs,enabled) VALUES (?,?,?,1)', ['经典导览（文明厅→艺术厅）', 1, refs]);
  run('INSERT INTO routes(name,version,zone_refs,enabled) VALUES (?,?,?,1)', ['特展导览', 1, JSON.stringify([{ zone_id: 3, zone_version: 1 }])]);
  run('INSERT INTO device_groups(name,publication_id) VALUES (?,NULL)', ['大厅终端组']);
  run('INSERT INTO device_groups(name,publication_id) VALUES (?,NULL)', ['东区终端组']);
  run("INSERT INTO devices(id,name,group_id) VALUES ('term-1','大厅一号终端',1)");
  run("INSERT INTO devices(id,name,group_id) VALUES ('term-2','东区一号终端',2)");
  audit('system', 'seed', 'db', '-', { note: '初始化种子数据' });
}

async function init() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) db = new SQL.Database(fs.readFileSync(DB_FILE));
  else db = new SQL.Database();
  db.run(SCHEMA);
  if (!one('SELECT id FROM weekly_rules LIMIT 1')) seed();
  saveNow();
  return module.exports;
}

module.exports = { init, all, one, run, audit, saveNow, DB_FILE };
