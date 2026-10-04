/* 展馆欢迎平台 · 服务 API
 * 职责：排班/节假日/临时事件维护、展区与路线版本、发布版本与设备分组、
 *       实时状态计算、终端数据包下发、导览回执（幂等/晚到容忍）、审计留痕。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const Schedule = require('../public/schedule.js');
const db = require('./db');

const TZ = process.env.VENUE_TZ || 'Asia/Shanghai';
const PUB_DIR = path.join(__dirname, '..', 'public');
const WELCOME = '欢迎来到城市展览馆 · Welcome to the City Exhibition Hall';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.css': 'text/css', '.json': 'application/json; charset=utf-8' };

/* ---------- 工具 ---------- */
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(s);
}
function draftData() {
  return {
    weekly: db.all('SELECT * FROM weekly_rules'),
    holidays: db.all('SELECT * FROM holidays'),
    events: db.all('SELECT * FROM events'),
    zones: db.all('SELECT * FROM zones'),
    routes: db.all('SELECT * FROM routes').map(r => ({
      id: r.id, name: r.name, version: r.version, enabled: r.enabled, zone_refs: JSON.parse(r.zone_refs)
    }))
  };
}
function parseRefs(routeRow) { return Object.assign({}, routeRow, { zone_refs: JSON.parse(routeRow.zone_refs) }); }

/* ---------- 发布 ---------- */
function buildPayload(freshnessMin) {
  const now = Date.now();
  const zones = db.all('SELECT * FROM zones');
  const events = db.all('SELECT * FROM events WHERE end_at > ?', [now]); // 仅进行中/未来事件入包
  const routes = db.all('SELECT * FROM routes').map(parseRefs).map(r => {
    const chk = Schedule.routeAvailable({ zones: zones, events: [] }, r, now, TZ); // 静态校验：版本匹配+启用
    r.available_static = chk.ok ? 1 : 0;
    r.static_reason = chk.ok ? '' : chk.reason;
    return r;
  });
  return {
    tz: TZ, generated_at: now, valid_until: now + freshnessMin * 60000,
    welcome_text: WELCOME,
    bg: { url: '/bg-default.svg', fallback_color: '#1f2a44' },
    weekly: db.all('SELECT * FROM weekly_rules WHERE enabled=1'),
    holidays: db.all('SELECT * FROM holidays'),
    events: events, zones: zones, routes: routes
  };
}
function doPublish(actor, freshnessMin, note) {
  const ver = (db.one('SELECT MAX(version) AS v FROM publications').v || 0) + 1;
  db.run("UPDATE publications SET status='superseded' WHERE status='active'");
  const payload = buildPayload(freshnessMin);
  db.run('INSERT INTO publications(version,payload,valid_from,valid_until,status,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [ver, JSON.stringify(payload), payload.generated_at, payload.valid_until, 'active', note || '', actor, Date.now()]);
  const id = db.one('SELECT last_insert_rowid() AS id').id;
  db.run('UPDATE device_groups SET publication_id=?', [id]); // 全分组滚动到最新发布
  db.audit(actor, 'publish', 'publication', id, { version: ver, valid_until: payload.valid_until, note: note || '' });
  return db.one('SELECT * FROM publications WHERE id=?', [id]);
}

/* ---------- 路由处理 ---------- */
const routes = [];
function route(method, re, fn) { routes.push([method, re, fn]); }

route('GET', /^\/api\/bootstrap$/, (req, res) => {
  json(res, 200, Object.assign(draftData(), {
    tz: TZ,
    publications: db.all('SELECT id,version,valid_from,valid_until,status,note,created_by,created_at,revoked_by,revoked_at,revoke_reason FROM publications ORDER BY id DESC'),
    groups: db.all('SELECT * FROM device_groups'),
    devices: db.all('SELECT * FROM devices'),
    receipts: db.all('SELECT * FROM receipts ORDER BY received_at DESC LIMIT 50'),
    audit: db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100')
  }));
});

/* 实际生效范围：按当前草稿数据逐日解析（管理网页所见即终端所得） */
route('GET', /^\/api\/effective$/, (req, res, m, q) => {
  const from = q.from || Schedule.zonedParts(Date.now(), TZ).date;
  const days = Math.min(+(q.days || 7), 31);
  const data = draftData();
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = Schedule.addDays(from, i);
    out.push({ date: date, segments: Schedule.dayTimeline(data, date, TZ) });
  }
  json(res, 200, { tz: TZ, days: out });
});

route('PUT', /^\/api\/weekly\/(\d+)$/, (req, res, m, q, body, actor) => {
  db.run('UPDATE weekly_rules SET open_min=?, close_min=?, label=?, enabled=? WHERE id=?',
    [body.open_min, body.close_min, body.label || '', body.enabled ? 1 : 0, +m[1]]);
  db.audit(actor, 'update', 'weekly_rule', m[1], body);
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/holidays$/, (req, res, m, q, body, actor) => {
  db.run('INSERT INTO holidays(date,name,closed,open_min,close_min) VALUES (?,?,?,?,?)',
    [body.date, body.name, body.closed ? 1 : 0, body.open_min || 0, body.close_min || 0]);
  db.audit(actor, 'create', 'holiday', db.one('SELECT last_insert_rowid() AS id').id, body);
  json(res, 201, { ok: true });
});
route('DELETE', /^\/api\/holidays\/(\d+)$/, (req, res, m, q, body, actor) => {
  db.run('DELETE FROM holidays WHERE id=?', [+m[1]]);
  db.audit(actor, 'delete', 'holiday', m[1], {});
  json(res, 200, { ok: true });
});

/* 临时事件：创建 */
route('POST', /^\/api\/events$/, (req, res, m, q, body, actor) => {
  const now = Date.now();
  db.run('INSERT INTO events(title,kind,zone_id,start_at,end_at,priority,version,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?)',
    [body.title, body.kind, body.zone_id || null, body.start_at, body.end_at, body.priority || 0, actor, actor, now, now]);
  const id = db.one('SELECT last_insert_rowid() AS id').id;
  db.audit(actor, 'create', 'event', id, body);
  json(res, 201, db.one('SELECT * FROM events WHERE id=?', [id]));
});
/* 临时事件：更新（乐观锁 base_version，冲突 409 且留痕） */
route('PUT', /^\/api\/events\/(\d+)$/, (req, res, m, q, body, actor) => {
  const cur = db.one('SELECT * FROM events WHERE id=?', [+m[1]]);
  if (!cur) return json(res, 404, { error: 'not_found' });
  if (body.base_version !== cur.version) {
    db.audit(actor, 'conflict', 'event', m[1],
      { base_version: body.base_version, current_version: cur.version, attempted: body.title });
    return json(res, 409, { error: 'version_conflict', message: '该事件已被他人修改', current: cur });
  }
  db.run('UPDATE events SET title=?,kind=?,zone_id=?,start_at=?,end_at=?,priority=?,version=version+1,updated_by=?,updated_at=? WHERE id=?',
    [body.title, body.kind, body.zone_id || null, body.start_at, body.end_at, body.priority || 0, actor, Date.now(), +m[1]]);
  db.audit(actor, 'update', 'event', m[1], body);
  json(res, 200, db.one('SELECT * FROM events WHERE id=?', [+m[1]]));
});
route('DELETE', /^\/api\/events\/(\d+)$/, (req, res, m, q, body, actor) => {
  db.run('DELETE FROM events WHERE id=?', [+m[1]]);
  db.audit(actor, 'delete', 'event', m[1], {});
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/zones$/, (req, res, m, q, body, actor) => {
  db.run('INSERT INTO zones(name,version,enabled,updated_at) VALUES (?,1,1,?)', [body.name, Date.now()]);
  const id = db.one('SELECT last_insert_rowid() AS id').id;
  db.audit(actor, 'create', 'zone', id, body);
  json(res, 201, db.one('SELECT * FROM zones WHERE id=?', [id]));
});
/* 展区变更会 bump version → 引用旧版本的路线在下次发布时被标记不可用 */
route('PUT', /^\/api\/zones\/(\d+)$/, (req, res, m, q, body, actor) => {
  const cur = db.one('SELECT * FROM zones WHERE id=?', [+m[1]]);
  if (!cur) return json(res, 404, { error: 'not_found' });
  db.run('UPDATE zones SET name=?, enabled=?, version=version+1, updated_at=? WHERE id=?',
    [body.name != null ? body.name : cur.name, body.enabled != null ? (body.enabled ? 1 : 0) : cur.enabled, Date.now(), +m[1]]);
  db.audit(actor, 'update', 'zone', m[1], body);
  json(res, 200, db.one('SELECT * FROM zones WHERE id=?', [+m[1]]));
});

route('POST', /^\/api\/routes$/, (req, res, m, q, body, actor) => {
  const refs = (body.zone_ids || []).map(zid => {
    const z = db.one('SELECT * FROM zones WHERE id=?', [zid]);
    return { zone_id: zid, zone_version: z ? z.version : 0 };
  });
  db.run('INSERT INTO routes(name,version,zone_refs,enabled) VALUES (?,1,?,1)', [body.name, JSON.stringify(refs)]);
  const id = db.one('SELECT last_insert_rowid() AS id').id;
  db.audit(actor, 'create', 'route', id, { name: body.name, refs: refs });
  json(res, 201, parseRefs(db.one('SELECT * FROM routes WHERE id=?', [id])));
});
route('PUT', /^\/api\/routes\/(\d+)$/, (req, res, m, q, body, actor) => {
  const cur = db.one('SELECT * FROM routes WHERE id=?', [+m[1]]);
  if (!cur) return json(res, 404, { error: 'not_found' });
  let refs = JSON.parse(cur.zone_refs);
  if (body.zone_ids) refs = body.zone_ids.map(zid => {
    const z = db.one('SELECT * FROM zones WHERE id=?', [zid]);
    return { zone_id: zid, zone_version: z ? z.version : 0 };
  });
  db.run('UPDATE routes SET name=?, zone_refs=?, enabled=?, version=version+1 WHERE id=?',
    [body.name != null ? body.name : cur.name, JSON.stringify(refs),
     body.enabled != null ? (body.enabled ? 1 : 0) : cur.enabled, +m[1]]);
  db.audit(actor, 'update', 'route', m[1], body);
  json(res, 200, parseRefs(db.one('SELECT * FROM routes WHERE id=?', [+m[1]])));
});

route('POST', /^\/api\/publications$/, (req, res, m, q, body, actor) => {
  const pub = doPublish(actor, +(body.freshness_minutes || 1440), body.note);
  json(res, 201, { id: pub.id, version: pub.version, valid_until: pub.valid_until });
});
/* 撤销必须给出原因，原因入库 + 审计，可追踪 */
route('POST', /^\/api\/publications\/(\d+)\/revoke$/, (req, res, m, q, body, actor) => {
  const p = db.one('SELECT * FROM publications WHERE id=?', [+m[1]]);
  if (!p) return json(res, 404, { error: 'not_found' });
  if (!body.reason || !String(body.reason).trim())
    return json(res, 400, { error: 'reason_required', message: '撤销发布必须填写原因（可追踪要求）' });
  if (p.status === 'revoked') return json(res, 409, { error: 'already_revoked' });
  db.run("UPDATE publications SET status='revoked', revoked_at=?, revoked_by=?, revoke_reason=? WHERE id=?",
    [Date.now(), actor, String(body.reason), +m[1]]);
  const fallback = db.one("SELECT id FROM publications WHERE status='active' ORDER BY version DESC LIMIT 1");
  const groups = db.all('SELECT * FROM device_groups WHERE publication_id=?', [+m[1]]);
  groups.forEach(g => db.run('UPDATE device_groups SET publication_id=? WHERE id=?', [fallback ? fallback.id : null, g.id]));
  db.audit(actor, 'revoke', 'publication', m[1],
    { reason: body.reason, fallback_publication: fallback ? fallback.id : null, affected_groups: groups.map(g => g.id) });
  json(res, 200, { ok: true, fallback_publication: fallback ? fallback.id : null });
});

route('PUT', /^\/api\/groups\/(\d+)$/, (req, res, m, q, body, actor) => {
  db.run('UPDATE device_groups SET publication_id=? WHERE id=?', [body.publication_id, +m[1]]);
  db.audit(actor, 'assign', 'device_group', m[1], { publication_id: body.publication_id });
  json(res, 200, { ok: true });
});

/* 终端数据包（提前下载模式） */
route('GET', /^\/api\/devices\/([^/]+)\/package$/, (req, res, m) => {
  const dev = db.one('SELECT * FROM devices WHERE id=?', [m[1]]);
  if (!dev) return json(res, 404, { error: 'unknown_device' });
  const grp = db.one('SELECT * FROM device_groups WHERE id=?', [dev.group_id]);
  if (!grp || grp.publication_id == null)
    return json(res, 404, { error: 'no_publication', message: '设备组未分配发布版本' });
  const pub = db.one('SELECT * FROM publications WHERE id=?', [grp.publication_id]);
  if (!pub) return json(res, 404, { error: 'no_publication' });
  if (pub.status !== 'active')
    return json(res, 410, { error: 'publication_' + pub.status, reason: pub.revoke_reason || '',
      publication_id: pub.id, version: pub.version });
  json(res, 200, Object.assign({ publication_id: pub.id, version: pub.version }, JSON.parse(pub.payload)));
});

/* 实时状态（服务端实时计算模式，用于对比与在线校验） */
route('GET', /^\/api\/status$/, (req, res, m, q) => {
  const at = q.at ? +q.at : Date.now();
  const data = draftData();
  const st = Schedule.statusAt(data, at, TZ, null);
  let pubInfo = null;
  if (q.device_id) {
    const dev = db.one('SELECT * FROM devices WHERE id=?', [q.device_id]);
    const grp = dev && db.one('SELECT * FROM device_groups WHERE id=?', [dev.group_id]);
    const pub = grp && grp.publication_id != null && db.one('SELECT id,version,status,revoke_reason FROM publications WHERE id=?', [grp.publication_id]);
    if (pub) pubInfo = pub;
  }
  json(res, 200, {
    at: at, tz: TZ, status: st,
    routes: data.routes.map(r => {
      const chk = Schedule.routeAvailable(data, r, at, TZ);
      return { id: r.id, name: r.name, enabled: chk.ok && st.open === true, reason: chk.ok ? '' : chk.reason };
    }),
    publication: pubInfo
  });
});

/* 导览回执：幂等（receipt_id 唯一），晚到不拒绝但标记 late 并留痕 */
route('POST', /^\/api\/receipts$/, (req, res, m, q, body, actor) => {
  const existing = db.one('SELECT * FROM receipts WHERE receipt_id=?', [body.receipt_id]);
  if (existing) return json(res, 200, { receipt: existing, duplicated: true });
  const now = Date.now();
  const pub = db.one('SELECT * FROM publications WHERE id=?', [body.publication_id]);
  let validAtStart = 0, note = [];
  if (pub) {
    const p = JSON.parse(pub.payload);
    const inWindow = pub.valid_from <= body.started_at && body.started_at < pub.valid_until;
    const notRevokedThen = !pub.revoked_at || body.started_at < pub.revoked_at;
    const route = (p.routes || []).find(r => r.id === body.route_id);
    const routeOk = route && Schedule.routeAvailable(p, route, body.started_at, p.tz).ok;
    const venueOpen = Schedule.statusAt(p, body.started_at, p.tz, null).open;
    validAtStart = (inWindow && notRevokedThen && routeOk && venueOpen) ? 1 : 0;
    if (!inWindow) note.push('开始时刻不在发布有效期窗口内');
    if (!notRevokedThen) note.push('开始时刻发布已被撤销');
    if (!routeOk) note.push('开始时路线不可用');
    if (!venueOpen) note.push('开始时场馆未开放');
  } else note.push('发布版本不存在');
  const late = (!pub || pub.status !== 'active' || (now - body.completed_at > 24 * 3600e3) ||
    (pub && body.completed_at > pub.valid_until)) ? 1 : 0;
  if (late) note.push('回执晚到：对应发布已非现行或超出新鲜度');
  db.run('INSERT INTO receipts(receipt_id,route_id,publication_id,device_id,started_at,completed_at,received_at,late,valid_at_start,note) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [body.receipt_id, body.route_id, body.publication_id, body.device_id || '',
     body.started_at, body.completed_at, now, late, validAtStart, note.join('；')]);
  db.audit(actor || body.device_id || 'terminal', late ? 'late_receipt' : 'receipt', 'receipt', body.receipt_id,
    { route_id: body.route_id, publication_id: body.publication_id, late: !!late, valid_at_start: !!validAtStart });
  json(res, 201, { receipt: db.one('SELECT * FROM receipts WHERE receipt_id=?', [body.receipt_id]), duplicated: false });
});
route('GET', /^\/api\/receipts$/, (req, res) => json(res, 200, db.all('SELECT * FROM receipts ORDER BY received_at DESC LIMIT 100')));
route('GET', /^\/api\/audit$/, (req, res) => json(res, 200, db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200')));

/* ---------- 静态文件 ---------- */
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/terminal.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const file = path.join(PUB_DIR, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/* ---------- 启动 ---------- */
async function start(port) {
  await db.init();
  if (!db.one('SELECT id FROM publications LIMIT 1')) {
    doPublish('system', 1440, '初始发布'); // 保证终端开箱可用
  }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const pathname = u.pathname;
    const q = Object.fromEntries(u.searchParams.entries());
    let actor = 'anonymous';
    try { actor = decodeURIComponent(req.headers['x-actor'] || '') || 'anonymous'; } catch (e) {}
    const hit = routes.find(r => r[0] === req.method && r[1].test(pathname));
    if (!hit) return serveStatic(req, res, pathname);
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch (e) { return json(res, 400, { error: 'bad_json' }); }
      try { hit[2](req, res, pathname.match(hit[1]), q, parsed, actor); }
      catch (e) { console.error(e); json(res, 500, { error: 'internal', message: String(e) }); }
    });
  });
  await new Promise(r => server.listen(port, r));
  console.log('展馆欢迎平台已启动: http://localhost:' + port + '  (管理页 /admin · 终端 /terminal.html?device=term-1)');
  return server;
}

if (require.main === module) start(+(process.env.PORT || 8080));
module.exports = { start, doPublish };
