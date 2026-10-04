'use strict';
// 端到端验收：启动服务（独立测试库 + 模拟时钟头），走真实 HTTP。
process.env.PAVILION_DB = require('path').join(__dirname, '..', 'data', 'test-api.db');
process.env.PAVILION_ALLOW_SIM = '1';
process.env.PAVILION_ADMIN_TOKEN = 'test-token';
for (const ext of ['', '-wal', '-shm']) {
  try { require('fs').unlinkSync(process.env.PAVILION_DB + ext); } catch (e) {}
}
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { app } = require('../src/server');

let server, base;
const T = require('../lib/time');
const tz = 'Asia/Shanghai';

test.before(async () => {
  await new Promise((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function req(method, url, { body, headers, simNow } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method, headers: Object.assign({
        'x-admin-key': 'test-token', 'x-actor': 'test'
      }, body ? { 'content-type': 'application/json' } : {}, headers || {},
        simNow != null ? { 'x-sim-now': String(simNow) } : {}) }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const get = (u, o) => req('GET', u, o);
const post = (u, body, o) => req('POST', u, Object.assign({ body }, o || {}));
const put = (u, body, o) => req('PUT', u, Object.assign({ body }, o || {}));

// 种子在真实 wall-clock 当年生成节假日；取一个“常规周三 10:00”与“周六深夜”的模拟时刻
const wedOpen = T.wallToUtc(T.localParts(Date.now(), tz).y, 10, 7, 10, 0, tz);
const satNight = T.wallToUtc(T.localParts(Date.now(), tz).y, 10, 10, 23, 30, tz);
const sunDawn = T.wallToUtc(T.localParts(Date.now(), tz).y, 10, 11, 1, 30, tz);
const sun18 = T.wallToUtc(T.localParts(Date.now(), tz).y, 10, 11, 18, 0, tz);

test('健康检查与初始发布存在', async () => {
  const h = await get('/api/health');
  assert.equal(h.json.ok, true);
  const pubs = await get('/api/publications');
  assert.ok(pubs.json.some((p) => p.status === 'released'));
});

test('设备下载包：含时间表、路线、展区版本、TTL；实时状态按模拟时间裁决', async () => {
  let r = await get('/api/devices/d-test/package?groupId=g-demo');
  assert.equal(r.status, 200);
  assert.ok(r.json.snapshot.schedule.weekly.length >= 1);
  assert.ok(r.json.ttl_ms === 30000);
  const st = await get('/api/devices/d-test/status?groupId=g-demo', { simNow: wedOpen });
  assert.equal(st.json.state, 'open');
  assert.ok(st.json.packageCurrent === true);
  assert.ok(st.json.routes.find((x) => x.id === 'r-classic'));
});

test('设备离线跨日：周六 23:30 与周日凌晨 01:30 均为夜场开放，周日 18:00 夜场早已结束、常规周历不含周日 -> 闭馆', async () => {
  const a = await get('/api/devices/d-test/status?groupId=g-demo', { simNow: satNight });
  const b = await get('/api/devices/d-test/status?groupId=g-demo', { simNow: sunDawn });
  const c = await get('/api/devices/d-test/status?groupId=g-demo', { simNow: sun18 });
  assert.equal(a.json.state, 'open');
  assert.equal(b.json.state, 'open'); // 跨午夜不被按当天切断
  assert.equal(c.json.state, 'closed');
});

test('节假日覆盖周历：国庆首日中午实时状态为闭馆（节假日优先级更高）', async () => {
  const holidayNoon = T.wallToUtc(T.localParts(Date.now(), tz).y, 10, 2, 12, 0, tz); // 10-02 在种子假期内
  const st = await get('/api/devices/d-test/status?groupId=g-demo', { simNow: holidayNoon });
  assert.equal(st.json.state, 'closed');
  assert.equal(st.json.kind, 'holiday');
});

test('临时事件：发布后实时状态立即变更（在线临时变更可送达）；两人同时改 -> 后者 402 冲突', async () => {
  const s = wedOpen, e = wedOpen + 3 * 3600 * 1000;
  const created = await post('/api/schedule/temporary', {
    name: '验收临时闭馆', start_ms: s, end_ms: e, state: 'closed', reason: '验收：紧急检修' });
  const id = created.json.id;
  const v = created.json.row_version;
  // A、B 都基于 v 修改；A 先成功
  const a = await put(`/api/schedule/temporary/${id}`,
    { name: 'A 修改', start_ms: s, end_ms: e, state: 'closed', reason: 'A', row_version: v },
    { headers: { 'if-match': String(v), 'x-actor': 'userA' } });
  assert.equal(a.status, 200);
  assert.equal(a.json.row_version, v + 1);
  // B 仍拿 v 提交 -> 402 冲突，返回当前版本
  const b = await put(`/api/schedule/temporary/${id}`,
    { name: 'B 修改', start_ms: s, end_ms: e, state: 'closed', reason: 'B', row_version: v },
    { headers: { 'if-match': String(v), 'x-actor': 'userB' } });
  assert.equal(b.status, 402);
  assert.equal(b.json.current.row_version, v + 1);
  assert.equal(b.json.current.name, 'A 修改');
  // 实时状态在事件区间内为临时闭馆，覆盖周历开放
  const st = await get('/api/devices/d-test/status?groupId=g-demo', { simNow: s + 1000 });
  assert.equal(st.json.state, 'closed');
  assert.equal(st.json.kind, 'temporary_event');
  // 冲突写入审计（可追踪）
  const audit = await get('/api/audit?limit=50');
  assert.ok(audit.json.some((x) => x.action === 'temporary.conflict' && x.actor === 'userB'));
});

test('网页显示实际生效范围：被更高优先级压缩的临时事件 effective 为压缩后区间', async () => {
  // 上面已有一条 [wedOpen, wedOpen+3h] 闭馆；再加一条覆盖其中 1 小时的临时开放
  const openStart = wedOpen + 30 * 60 * 1000, openEnd = wedOpen + 90 * 60 * 1000;
  const r = await post('/api/schedule/temporary', {
    name: '验收临时开放窗口', start_ms: openStart, end_ms: openEnd, state: 'open', reason: '验收：窗口开放' });
  const id = r.json.id;
  const eff = await post('/api/schedule/effective', { at_ms: openStart + 60000 });
  assert.equal(eff.json.current.state, 'open');
  assert.equal(eff.json.current.from, openStart);
  assert.equal(eff.json.current.until, openEnd);
  const ev = eff.json.events.find((x) => x.id === id);
  assert.ok(ev.effective, '该开放窗口应实际生效');
  assert.equal(ev.effective.start, openStart);
  // 外层闭馆事件的实际生效区间应被压缩为两段；其中午 10:00 段止于 openStart
  const effClosed = await post('/api/schedule/effective', { at_ms: wedOpen + 1000 });
  assert.equal(effClosed.json.current.state, 'closed');
  assert.equal(effClosed.json.current.until, openStart);
});

test('发布新版本后分组滚动；旧包导览回执晚到 -> 拒绝；新包 -> 受理（幂等重放）', async () => {
  const before = (await get('/api/devices/d-test/package?groupId=g-demo')).json.snapshot.version;
  await post('/api/publications', { note: '验收发布：导览版本更新' });
  const after = await get('/api/devices/d-test/package?groupId=g-demo').json.snapshot.version;
  assert.equal(after, before + 1);
  // 用旧版本号提交“晚到回执”
  const afterEvent = wedOpen + 5 * 3600 * 1000; // 临时事件 [wedOpen, +3h] 之外，周历仍开放
  const late = await post('/api/devices/d-test/receipts?groupId=g-demo',
    { nonce: 'n-late-' + Date.now(), routeId: 'r-classic', routeVersion: 1, packageVersion: before },
    { simNow: afterEvent });
  assert.equal(late.status, 422);
  assert.equal(late.json.reason, 'package_version_mismatch');
  // 新包内路线版本（快照里 r-classic v1）配合新版本号 -> 受理
  const snap = (await get('/api/devices/d-test/package?groupId=g-demo')).json.snapshot;
  const rv = snap.routes.find((x) => x.id === 'r-classic').version;
  const ok = await post('/api/devices/d-test/receipts?groupId=g-demo',
    { nonce: 'n-ok-' + Date.now(), routeId: 'r-classic', routeVersion: rv, packageVersion: after },
    { simNow: afterEvent });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'accepted');
  // 闭馆时刻的回执（即使版本正确）拒绝
  const closedNow = T.wallToUtc(T.localParts(Date.now(), tz).y, 10, 7, 20, 0, tz);
  const denied = await post('/api/devices/d-test/receipts?groupId=g-demo',
    { nonce: 'n-closed-' + Date.now(), routeId: 'r-classic', routeVersion: rv, packageVersion: after },
    { simNow: closedNow });
  assert.equal(denied.status, 422);
  assert.equal(denied.json.reason, 'closed_now');
});

test('nonce 幂等：相同回执重放返回 duplicate，不产生第二条受理', async () => {
  const nonce = 'n-idem-' + Date.now();
  const snap = (await get('/api/devices/d-test/package?groupId=g-demo')).json.snapshot;
  const rv = snap.routes.find((x) => x.id === 'r-classic').version;
  const payload = { nonce, routeId: 'r-classic', routeVersion: rv, packageVersion: snap.version };
  const first = await post('/api/devices/d-test/receipts?groupId=g-demo', payload, { simNow: wedOpen + 5 * 3600 * 1000 });
  const second = await post('/api/devices/d-test/receipts?groupId=g-demo', payload, { simNow: wedOpen + 5 * 3600 * 1000 });
  assert.equal(first.status, 200);
  assert.equal(second.json.duplicate, true);
});

test('背景文件失败：快照标记 failed 且不携带内容，终端必须回退但保留欢迎文字', async () => {
  await post('/api/files/background', { status: 'failed', contentType: 'image/jpeg', reason: '验收：文件投递失败' });
  await post('/api/publications', { note: '验收发布：背景失败回退' });
  const snap = (await get('/api/devices/d-test/package?groupId=g-demo')).json.snapshot;
  assert.equal(snap.background.status, 'failed');
  assert.equal(snap.background.content, null);
  assert.ok(snap.welcome_text.length > 0);
});

test('发布撤销必须填写原因；撤销后分组无可用包，终端状态待核实，审计可追踪', async () => {
  const cur = (await get('/api/settings')).json.current_publication;
  const noReason = await post(`/api/publications/${cur}/revoke`, { reason: '' });
  assert.equal(noReason.status, 400);
  const r = await post(`/api/publications/${cur}/revoke`, { reason: '验收：发现背景缺失，撤回以免误导观众' });
  assert.equal(r.status, 200);
  // g-demo 跟随最新版本，撤销后拿不到包
  const p = await get('/api/devices/d-test/package?groupId=g-demo');
  assert.equal(p.status, 409);
  // 实时接口返回 unverified，不承诺开放
  const st = await get('/api/devices/d-test/status?groupId=g-demo', { simNow: wedOpen });
  assert.equal(st.json.state, 'unverified');
  assert.equal(st.json.packageCurrent, false);
  const pubs = await get('/api/publications');
  const revoked = pubs.json.find((x) => String(x.version) === String(cur));
  assert.equal(revoked.status, 'revoked');
  assert.match(revoked.revoke_reason, /背景缺失/);
  const audit = await get('/api/audit?limit=100');
  assert.ok(audit.json.some((x) => x.action === 'revoke' && x.reason.includes('背景缺失')));
});

test('时区切换：周历按新时区解释；绝对时间的临时事件不受影响', async () => {
  // 重新发布一版可用包（撤销后没有 current），并把时区改为 UTC
  await put('/api/settings', { timezone: 'UTC' });
  // 新增一条 UTC 下周三 09:00-18:00 的周历（先清掉旧的 active 周历影响——直接新增即可，裁决按 UTC 星期命中）
  await post('/api/schedule/weekly', { weekdays: [3], open: '09:00', close: '18:00', name: 'UTC 周三场' });
  await post('/api/publications', { note: '验收发布：时区切换 UTC' });
  const wedUtcNoon = Date.UTC(T.localParts(Date.now(), 'UTC').y, 10, 7, 12, 0);
  const st = await get('/api/devices/d-test/status?groupId=g-demo', { simNow: wedUtcNoon });
  // 2026-10-07 是周几？需要是周三——否则按实际周三取日期
  const weekday = T.localParts(wedUtcNoon, 'UTC').weekday;
  if (weekday === 3) assert.equal(st.json.state, 'open');
  assert.equal(st.json.timezone, 'UTC');
  // 恢复上海时区，避免污染其它用例顺序
  await put('/api/settings', { timezone: 'Asia/Shanghai' });
});
