'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const { db, now, getSetting, setSetting, audit, loadEditorState, publish, revoke } = require('./db');
const { seed } = require('./seed');
const T = require('../lib/time');
const S = require('../lib/schedule');
const C = require('../lib/client');

seed();

const app = express();
app.use(express.json({ limit: '4mb' }));

const ADMIN_TOKEN = process.env.PAVILION_ADMIN_TOKEN || 'admin-token';
const ALLOW_SIM = process.env.PAVILION_ALLOW_SIM === '1';
app.locals.simOffset = 0;

function serverNow(req) {
  if (ALLOW_SIM && req && req.get('x-sim-now')) {
    const v = Number(req.get('x-sim-now'));
    if (Number.isFinite(v)) return v;
  }
  return Date.now();
}

function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (key !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// 浏览器直接复用 lib 下的 UMD 模块
app.use('/lib', express.static(path.join(__dirname, '..', 'lib')));
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));
app.get('/', (req, res) => res.redirect('/t/'));
app.use('/t', express.static(path.join(__dirname, '..', 'public', 't')));
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));

// ---------- 设置 ----------
app.get('/api/settings', (req, res) => {
  res.json({
    timezone: getSetting('timezone', 'Asia/Shanghai'),
    welcome_text: getSetting('welcome_text', '欢迎莅临城市展馆'),
    stale_text: getSetting('stale_text', '状态待核实，请以现场公告或工作人员指引为准'),
    max_clock_skew_ms: Number(getSetting('max_clock_skew_ms', 300000)),
    current_publication: getSetting('current_publication', null)
  });
});
app.put('/api/settings', requireAdmin, (req, res) => {
  const allowed = ['timezone', 'welcome_text', 'stale_text', 'max_clock_skew_ms'];
  const changed = [];
  for (const k of allowed) if (req.body[k] != null) { setSetting(k, req.body[k]); changed.push(k); }
  audit('settings.update', 'settings', null, req.get('x-actor'), '修改设置：' + changed.join(','), { fields: changed });
  res.json({ ok: true, changed });
});

// ---------- 背景文件 ----------
app.post('/api/files/background', requireAdmin, (req, res) => {
  const { content, contentType, status } = req.body;
  const st = status === 'failed' ? 'failed' : 'ready';
  if (st === 'ready' && !content) return res.status(400).json({ error: 'ready 状态必须提供 content' });
  const etag = (db.prepare("SELECT COALESCE(MAX(etag),0)+1 e FROM files WHERE kind='background'").get().e);
  db.prepare(`INSERT INTO files(id,kind,content,content_type,status,etag,updated_at)
    VALUES('bg-'||?, 'background', ?, ?, ?, ?, ?)`)
    .run(String(etag), st === 'ready' ? content : null, contentType || 'image/*', st, etag, serverNow(req));
  audit('file.upload', 'file', 'background', req.get('x-actor'),
    st === 'failed' ? ('登记背景文件失败：' + (req.body.reason || '文件不可用')) : '上传新背景文件',
    { etag, status: st });
  res.json({ ok: true, etag, status: st });
});

// ---------- 展区 ----------
function areaRow(a) {
  return { id: a.id, name: a.name, description: a.description, floor: a.floor, position: a.position,
    active: !!a.active, version: a.version, published_version: a.published_version };
}
app.get('/api/areas', (req, res) => res.json(db.prepare('SELECT * FROM areas ORDER BY position,id').all().map(areaRow)));
app.post('/api/areas', requireAdmin, (req, res) => {
  const id = req.body.id || ('a-' + Date.now());
  if (db.prepare('SELECT id FROM areas WHERE id=?').get(id)) return res.status(409).json({ error: 'id 已存在' });
  db.prepare(`INSERT INTO areas(id,name,description,floor,position,active,version,published_version,updated_at)
    VALUES(?,?,?,?,?,1,1,NULL,?)`).run(id, req.body.name || id, req.body.description || '', req.body.floor || '',
    req.body.position || 0, serverNow(req));
  audit('area.create', 'area', id, req.get('x-actor'), req.body.reason || '', { name: req.body.name });
  res.json(areaRow(db.prepare('SELECT * FROM areas WHERE id=?').get(id)));
});
// 编辑草稿：version +1（终端仍只看到 published_version）
app.put('/api/areas/:id', requireAdmin, (req, res) => {
  const a = db.prepare('SELECT * FROM areas WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '展区不存在' });
  db.prepare(`UPDATE areas SET name=COALESCE(?,name), description=COALESCE(?,description),
    floor=COALESCE(?,floor), active=COALESCE(?,active), version=version+1, updated_at=? WHERE id=?`)
    .run(req.body.name ?? null, req.body.description ?? null, req.body.floor ?? null,
      req.body.active == null ? null : (req.body.active ? 1 : 0), serverNow(req), a.id);
  audit('area.edit', 'area', a.id, req.get('x-actor'), req.body.reason || '编辑展区',
    { fromVersion: a.version, toVersion: a.version + 1 });
  res.json(areaRow(db.prepare('SELECT * FROM areas WHERE id=?').get(a.id)));
});
// 发布该展区：published_version := version（对下次整体发布生效）
app.post('/api/areas/:id/release', requireAdmin, (req, res) => {
  const a = db.prepare('SELECT * FROM areas WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: '展区不存在' });
  db.prepare('UPDATE areas SET published_version=version, updated_at=? WHERE id=?').run(serverNow(req), a.id);
  audit('area.release', 'area', a.id, req.get('x-actor'), req.body.reason || '展区版本转为可用', { published: a.version + 1 });
  res.json(areaRow(db.prepare('SELECT * FROM areas WHERE id=?').get(a.id)));
});

// ---------- 路线 ----------
function routeRow(r) {
  return { id: r.id, name: r.name, area_ids: JSON.parse(r.area_ids_json), version: r.version, active: !!r.active };
}
app.get('/api/routes', (req, res) => res.json(db.prepare('SELECT * FROM routes ORDER BY id').all().map(routeRow)));
app.post('/api/routes', requireAdmin, (req, res) => {
  const id = req.body.id || ('r-' + Date.now());
  db.prepare(`INSERT INTO routes(id,name,area_ids_json,version,active,updated_at) VALUES(?,?,?,1,1,?)`)
    .run(id, req.body.name || id, JSON.stringify(req.body.area_ids || []), serverNow(req));
  audit('route.create', 'route', id, req.get('x-actor'), req.body.reason || '', { name: req.body.name });
  res.json(routeRow(db.prepare('SELECT * FROM routes WHERE id=?').get(id)));
});
app.put('/api/routes/:id', requireAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM routes WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '路线不存在' });
  db.prepare(`UPDATE routes SET name=COALESCE(?,name), area_ids_json=COALESCE(?,area_ids_json),
    version=version+1, active=COALESCE(?,active), updated_at=? WHERE id=?`)
    .run(req.body.name ?? null, req.body.area_ids ? JSON.stringify(req.body.area_ids) : null,
      req.body.active == null ? null : (req.body.active ? 1 : 0), serverNow(req), r.id);
  audit('route.edit', 'route', r.id, req.get('x-actor'), req.body.reason || '编辑路线',
    { fromVersion: r.version, toVersion: r.version + 1 });
  res.json(routeRow(db.prepare('SELECT * FROM routes WHERE id=?').get(r.id)));
});

// ---------- 常规周历 / 节假日 ----------
app.get('/api/schedule/weekly', (req, res) =>
  res.json(db.prepare('SELECT * FROM weekly_rules ORDER BY position,id').all()
    .map((r) => ({ ...r, weekdays: JSON.parse(r.weekdays_json), weekdays_json: undefined, active: !!r.active }))));
app.post('/api/schedule/weekly', requireAdmin, (req, res) => {
  const info = db.prepare(`INSERT INTO weekly_rules(weekdays_json,open,close,state,name,active,position,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(JSON.stringify(req.body.weekdays || []), req.body.open, req.body.close,
    req.body.state || 'open', req.body.name || '', req.body.active === false ? 0 : 1,
    req.body.position || 0, serverNow(req));
  audit('weekly.create', 'weekly_rule', info.lastInsertRowid, req.get('x-actor'), req.body.reason || '新增周历', req.body);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/schedule/weekly/:id', requireAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM weekly_rules WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '规则不存在' });
  db.prepare(`UPDATE weekly_rules SET weekdays_json=COALESCE(?,weekdays_json), open=COALESCE(?,open),
    close=COALESCE(?,close), name=COALESCE(?,name), active=COALESCE(?,active), updated_at=? WHERE id=?`)
    .run(req.body.weekdays ? JSON.stringify(req.body.weekdays) : null, req.body.open ?? null, req.body.close ?? null,
      req.body.name ?? null, req.body.active == null ? null : (req.body.active ? 1 : 0), serverNow(req), r.id);
  audit('weekly.edit', 'weekly_rule', r.id, req.get('x-actor'), req.body.reason || '修改周历', {});
  res.json({ ok: true });
});
app.delete('/api/schedule/weekly/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE weekly_rules SET active=0, updated_at=? WHERE id=?').run(serverNow(req), req.params.id);
  audit('weekly.delete', 'weekly_rule', req.params.id, req.get('x-actor'), req.body.reason || '删除周历', {});
  res.json({ ok: true });
});

app.get('/api/schedule/holidays', (req, res) =>
  res.json(db.prepare('SELECT * FROM holidays ORDER BY start_date,id').all().map((h) => ({ ...h, active: !!h.active }))));
app.post('/api/schedule/holidays', requireAdmin, (req, res) => {
  const info = db.prepare(`INSERT INTO holidays(name,start_date,end_date,state,active,position,updated_at)
    VALUES(?,?,?,?,1,?,?)`).run(req.body.name, req.body.start_date, req.body.end_date,
    req.body.state || 'closed', req.body.position || 0, serverNow(req));
  audit('holiday.create', 'holiday', info.lastInsertRowid, req.get('x-actor'), req.body.reason || '新增节假日安排', req.body);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/schedule/holidays/:id', requireAdmin, (req, res) => {
  db.prepare(`UPDATE holidays SET name=COALESCE(?,name), start_date=COALESCE(?,start_date),
    end_date=COALESCE(?,end_date), state=COALESCE(?,state), updated_at=? WHERE id=?`)
    .run(req.body.name ?? null, req.body.start_date ?? null, req.body.end_date ?? null,
      req.body.state ?? null, serverNow(req), req.params.id);
  audit('holiday.edit', 'holiday', req.params.id, req.get('x-actor'), req.body.reason || '修改节假日安排', {});
  res.json({ ok: true });
});
app.delete('/api/schedule/holidays/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE holidays SET active=0, updated_at=? WHERE id=?').run(serverNow(req), req.params.id);
  audit('holiday.delete', 'holiday', req.params.id, req.get('x-actor'), req.body.reason || '删除节假日安排', {});
  res.json({ ok: true });
});

// ---------- 临时事件（乐观锁：row_version）----------
app.get('/api/schedule/temporary', (req, res) =>
  res.json(db.prepare('SELECT * FROM temporary_events ORDER BY start_ms,id').all()));
app.post('/api/schedule/temporary', requireAdmin, (req, res) => {
  const b = req.body;
  if (!(b.end_ms > b.start_ms)) return res.status(400).json({ error: '结束必须晚于开始' });
  const t = serverNow(req);
  const info = db.prepare(`INSERT INTO temporary_events(name,start_ms,end_ms,state,reason,active,row_version,
    created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,1,1,?,?,?,?)`)
    .run(b.name || '临时事件', b.start_ms, b.end_ms, b.state === 'open' ? 'open' : 'closed', b.reason || '',
      req.get('x-actor') || 'admin', req.get('x-actor') || 'admin', t, t);
  audit('temporary.create', 'temporary_event', info.lastInsertRowid, req.get('x-actor'),
    b.reason || '新增临时事件', { state: b.state, start_ms: b.start_ms, end_ms: b.end_ms });
  res.json(db.prepare('SELECT * FROM temporary_events WHERE id=?').get(info.lastInsertRowid));
});
app.put('/api/schedule/temporary/:id', requireAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM temporary_events WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '事件不存在' });
  const expected = Number(req.get('if-match') ?? req.body.row_version);
  if (!Number.isFinite(expected) || expected !== r.row_version) {
    audit('temporary.conflict', 'temporary_event', r.id, req.get('x-actor'),
      '并发修改冲突：客户端版本 ' + expected + '，库中版本 ' + r.row_version, {});
    return res.status(402, 'Conflict').json({ error: '版本冲突，已有人先行修改', current: r });
  }
  const b = req.body, t = serverNow(req);
  const start = b.start_ms ?? r.start_ms, end = b.end_ms ?? r.end_ms;
  if (!(end > start)) return res.status(400).json({ error: '结束必须晚于开始' });
  db.prepare(`UPDATE temporary_events SET name=COALESCE(?,name), start_ms=?, end_ms=?, state=COALESCE(?,state),
    reason=COALESCE(?,reason), row_version=row_version+1, updated_by=?, updated_at=? WHERE id=?`)
    .run(b.name ?? null, start, end, b.state ?? null, b.reason ?? null, req.get('x-actor') || 'admin', t, r.id);
  audit('temporary.edit', 'temporary_event', r.id, req.get('x-actor'),
    b.reason || req.get('x-edit-reason') || '修改临时事件',
    { fromVersion: r.row_version, toVersion: r.row_version + 1 });
  res.json(db.prepare('SELECT * FROM temporary_events WHERE id=?').get(r.id));
});
app.delete('/api/schedule/temporary/:id', requireAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM temporary_events WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '事件不存在' });
  db.prepare('UPDATE temporary_events SET active=0, row_version=row_version+1, updated_at=? WHERE id=?')
    .run(serverNow(req), req.params.id);
  audit('temporary.delete', 'temporary_event', req.params.id, req.get('x-actor'), req.body?.reason || '取消临时事件', {});
  res.json({ ok: true });
});

// ---------- 管理网页：编辑层排期的实际生效范围预览 ----------
// 网页上必须能看到每条安排“实际生效范围”，而不是只看它自己填写的名义区间。
app.post('/api/schedule/effective', (req, res) => {
  const tz = getSetting('timezone', 'Asia/Shanghai');
  const at = req.body.at_ms ? Number(req.body.at_ms) : serverNow(req);
  const sch = loadEditorState();
  const current = S.statusRange(sch, at, tz, 90);
  const tzLabel = tz;
  const events = sch.temporary.map((ev) => {
    const mid = (ev.start_ms + ev.end_ms) / 2;
    const range = S.statusRange(sch, mid, tz, 90);
    const dominated = range.kind === 'temporary_event' && range.rule && range.rule.id === ev.id;
    return {
      id: ev.id, name: ev.name, state: ev.state, reason: ev.reason,
      nominal: { start: ev.start_ms, end: ev.end_ms },
      effective: dominated ? { start: range.from, end: range.until } : null,
      effective_note: dominated ? null : '被更高优先级/更晚开始的临时事件覆盖，名义时间内实际不生效'
    };
  });
  res.json({ timezone: tzLabel, at, current, events });
});

// ---------- 发布版本 ----------
app.get('/api/publications', (req, res) =>
  res.json(db.prepare('SELECT version,status,note,revoke_reason,created_by,created_at,revoked_at FROM publications ORDER BY version DESC').all()));
app.get('/api/publications/:version', (req, res) => {
  const p = db.prepare('SELECT * FROM publications WHERE version=?').get(req.params.version);
  if (!p) return res.status(404).json({ error: '版本不存在' });
  res.json({ ...p, snapshot: JSON.parse(p.snapshot_json), snapshot_json: undefined });
});
app.post('/api/publications', requireAdmin, (req, res) => {
  const ver = publish(req.get('x-actor') || 'admin', req.body.note || '');
  // 新版本发布后，各设备分组滚动到新版本（终端下次同步即收到新包）
  db.prepare('UPDATE device_groups SET published_version=?, updated_at=? WHERE published_version IS NOT NULL OR 1=1')
    .run(ver, serverNow(req));
  res.json({ version: ver });
});
app.post('/api/publications/:version/revoke', requireAdmin, (req, res) => {
  try {
    revoke(Number(req.params.version), req.get('x-actor') || 'admin', req.body.reason || '');
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  // 指向被撤销版本的分组回到无可用版本（终端不再拿到包，只保留欢迎与基本导航）
  db.prepare('UPDATE device_groups SET published_version=NULL, updated_at=? WHERE published_version=?')
    .run(serverNow(req), Number(req.params.version));
  res.json({ ok: true });
});

// ---------- 设备分组 ----------
function groupRow(g) { return { ...g, ttl_ms: Number(g.ttl_ms) }; }
app.get('/api/groups', (req, res) => res.json(db.prepare('SELECT * FROM device_groups ORDER BY id').all().map(groupRow)));
app.post('/api/groups', requireAdmin, (req, res) => {
  const id = req.body.id || ('g-' + Date.now());
  db.prepare('INSERT INTO device_groups(id,name,published_version,ttl_ms,updated_at) VALUES(?,?,?,?,?)')
    .run(id, req.body.name || id, req.body.published_version ?? null, req.body.ttl_ms || 12 * 3600 * 1000, serverNow(req));
  audit('group.create', 'device_group', id, req.get('x-actor'), req.body.reason || '创建设备分组', {});
  res.json(groupRow(db.prepare('SELECT * FROM device_groups WHERE id=?').get(id)));
});
app.put('/api/groups/:id', requireAdmin, (req, res) => {
  const g = db.prepare('SELECT * FROM device_groups WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: '分组不存在' });
  db.prepare(`UPDATE device_groups SET name=COALESCE(?,name), ttl_ms=COALESCE(?,ttl_ms),
    published_version=?, updated_at=? WHERE id=?`)
    .run(req.body.name ?? null, req.body.ttl_ms ?? null,
      req.body.published_version === undefined ? g.published_version : (req.body.published_version ?? null),
      serverNow(req), g.id);
  audit('group.edit', 'device_group', g.id, req.get('x-actor'), req.body.reason || '修改设备分组',
    { ttl_ms: req.body.ttl_ms, published_version: req.body.published_version });
  res.json(groupRow(db.prepare('SELECT * FROM device_groups WHERE id=?').get(g.id)));
});

// ---------- 设备 / 包 / 实时状态 / 回执 ----------
function getDevice(id, req) {
  let d = db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  if (!d) {
    db.prepare('INSERT INTO devices(id,name,group_id,created_at) VALUES(?,?,NULL,?)').run(id, id, serverNow(req));
    d = db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  }
  return d;
}
function heartbeat(d, groupId, req) {
  db.prepare('UPDATE devices SET last_seen_ms=?, last_ip=?, group_id=COALESCE(?,group_id) WHERE id=?')
    .run(serverNow(req), req.ip, groupId || null, d.id);
}
function groupPublication(groupId) {
  const g = groupId && db.prepare('SELECT * FROM device_groups WHERE id=?').get(groupId);
  if (!g) return { group: null, publication: null };
  const p = g.published_version != null ? db.prepare('SELECT * FROM publications WHERE version=?').get(g.published_version) : null;
  if (!p || p.status !== 'released') return { group: g, publication: null };
  return { group: g, publication: p };
}

// 提前下载带时间表的包
app.get('/api/devices/:id/package', (req, res) => {
  const d = getDevice(req.params.id, req);
  heartbeat(d, req.query.groupId, req);
  const { group, publication } = groupPublication(d.group_id || req.query.groupId);
  if (!group) return res.status(409).json({ error: 'device_not_in_group', message: '设备尚未分组' });
  if (!publication) {
    audit('package.denied', 'device', d.id, 'device', '无可用发布版本（可能已撤销）', { group: group.id });
    return res.status(409).json({ error: 'no_publication', message: '当前没有可用发布版本（可能已撤销）' });
  }
  const snap = JSON.parse(publication.snapshot_json);
  const t = serverNow(req);
  db.prepare('UPDATE devices SET package_version=?, package_received_at=? WHERE id=?').run(publication.version, t, d.id);
  res.json({
    server_now: t,
    group_id: group.id,
    ttl_ms: Number(group.ttl_ms),
    max_clock_skew_ms: Number(getSetting('max_clock_skew_ms', 300000)),
    downloaded_server_ms: t,
    snapshot: snap
  });
});

// 服务端实时计算开放状态（在线权威）
app.get('/api/devices/:id/status', (req, res) => {
  const d = getDevice(req.params.id, req);
  heartbeat(d, req.query.groupId, req);
  const { group, publication } = groupPublication(d.group_id || req.query.groupId);
  if (!group) return res.status(409).json({ error: 'device_not_in_group' });
  const t = serverNow(req);
  const tz = getSetting('timezone', 'Asia/Shanghai');
  const base = {
    server_now: t, timezone: tz,
    welcome_text: getSetting('welcome_text', '欢迎莅临展馆'),
    stale_text: getSetting('stale_text', '状态待核实'),
    group_id: group.id, group_version: group.published_version,
    device_package_version: d.package_version
  };
  if (!publication) {
    return res.json({ ...base, state: 'unverified', kind: 'no_publication',
      note: '当前没有可用发布版本，状态待核实', packageCurrent: false,
      from: null, until: null, routes: [], backgroundEtag: null });
  }
  const snap = JSON.parse(publication.snapshot_json);
  // 在线实时路径：排期以服务端“当前编辑层”为准（临时变更即时可送达）；
  // 路线/展区/背景仍以已发布快照为准（导览必须与展区可用版本匹配）。
  const range = S.statusRange(loadEditorState(), t, tz, 90);
  const pkgCurrent = d.package_version === publication.version;
  res.json({
    ...base,
    state: range.state, kind: range.kind, note: range.note, from: range.from, until: range.until,
    packageCurrent: pkgCurrent,
    backgroundEtag: snap.background ? snap.background.etag : null,
    routes: snap.routes.map((r) => ({ id: r.id, version: r.version }))
  });
});

// 导览进入回执（旧导览回执晚到也在此被挡住；nonce 幂等）
app.post('/api/devices/:id/receipts', (req, res) => {
  const d = getDevice(req.params.id, req);
  heartbeat(d, req.query.groupId, req);
  const b = req.body || {};
  if (b.nonce != null) {
    const prev = db.prepare('SELECT * FROM receipts WHERE nonce=?').get(b.nonce);
    if (prev) {
      if (prev.device_id === d.id && prev.route_id === b.routeId &&
          prev.route_version === b.routeVersion && prev.package_version === b.packageVersion) {
        return res.json({ duplicate: true, status: prev.status, reject_reason: prev.reject_reason });
      }
      return res.status(409).json({ error: 'nonce 已被不同回执占用' });
    }
  }
  const { group, publication } = groupPublication(d.group_id || req.query.groupId);
  const tz = getSetting('timezone', 'Asia/Shanghai');
  // 实时裁决同样使用当前编辑层排期（刚发布的临时闭馆立即生效）
  const state = publication ? S.resolveAt(loadEditorState(), serverNow(req), tz).state : 'unverified';
  const snap = publication ? JSON.parse(publication.snapshot_json) : null;
  const verdict = C.evaluateReceipt({
    state,
    groupPublishedVersion: group ? group.published_version : null,
    releasedVersionOf(routeId) {
      const r = snap && snap.routes.find((x) => x.id === routeId);
      return r ? r.version : null;
    }
  }, { routeId: b.routeId, routeVersion: b.routeVersion, packageVersion: b.packageVersion });
  db.prepare(`INSERT INTO receipts(nonce,device_id,route_id,route_version,package_version,status,reject_reason,received_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(b.nonce || null, d.id, b.routeId || null,
    b.routeVersion ?? null, b.packageVersion ?? null, verdict.accept ? 'accepted' : 'rejected',
    verdict.reason, serverNow(req));
  audit(verdict.accept ? 'receipt.accept' : 'receipt.reject', 'device', d.id, 'device',
    verdict.message || '导览进入', { route: b.routeId, route_version: b.routeVersion, package_version: b.packageVersion, reason: verdict.reason });
  res.status(verdict.accept ? 200 : 422).json({ status: verdict.accept ? 'accepted' : 'rejected', reason: verdict.reason, message: verdict.message });
});

app.get('/api/devices', (req, res) =>
  res.json(db.prepare('SELECT id,name,group_id,last_seen_ms,last_ip,package_version,package_received_at FROM devices ORDER BY id').all()));

// ---------- 审计 ----------
app.get('/api/audit', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit));
});

// 健康检查（含模拟时钟状态，便于验收）
app.get('/api/health', (req, res) => res.json({ ok: true, now: serverNow(req), sim: ALLOW_SIM }));

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => console.log(`pavilion listening on http://localhost:${port}  (admin: /admin, terminal: /t/)`));
}
module.exports = { app };
