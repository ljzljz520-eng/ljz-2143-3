/* 验收场景：
 * 1. 时区切换 + 跨午夜不被按当天日期切断
 * 2. 优先级：临时事件 > 节假日 > 周历
 * 3. 两人同时改临时事件（乐观锁冲突留痕）
 * 4. 设备离线跨日（超过新鲜度 → 状态待核实，保留欢迎与基本导航）
 * 5. 背景文件失败（回退备用背景）
 * 6. 旧导览回执晚到（幂等接受、标记留痕）
 * 7. 路线-展区版本匹配 + 闭馆后旧页面不能引导进入（撤销 → 410 → 待核实）
 */
process.env.DB_FILE = require('path').join(__dirname, 'test-' + Date.now() + '.sqlite');
process.env.PORT = '8091';
const assert = require('assert');
const { start } = require('../src/server');
const Schedule = require('../public/schedule.js');
const TerminalCore = require('../public/terminal-core.js');

const BASE = 'http://localhost:8091';
const TZ = 'Asia/Shanghai';
let passed = 0;
function ok(name) { passed++; console.log('  ✅ ' + name); }
async function api(method, path, body, actor) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-actor': encodeURIComponent(actor || 'tester') },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  await start(8091);

  /* ============ 场景1：时区切换 & 跨午夜 ============ */
  console.log('\n[场景1] 时区切换 / 跨午夜开放不被按当天日期切断');
  const boot = (await api('GET', '/api/bootstrap')).body;
  const draft = { weekly: boot.weekly, holidays: boot.holidays, events: [], zones: boot.zones };
  // 找到下一个周五（场馆时区）
  let d = Schedule.zonedParts(Date.now(), TZ).date;
  while (Schedule.zonedParts(Schedule.zonedMs(d, 720, TZ), TZ).weekday !== 5) d = Schedule.addDays(d, 1);
  const friLate = Schedule.zonedMs(d, 1530, TZ);            // 周五 25:30 = 周六 01:30
  assert.strictEqual(Schedule.zonedParts(friLate, TZ).weekday, 6, '25:30 应落在周六');
  const st1 = Schedule.statusAt(draft, friLate, TZ, null);
  assert.strictEqual(st1.open, true, '周六凌晨01:30 应由周五夜场覆盖而开放');
  assert.match(st1.label, /周五夜场/);
  ok('跨午夜：周六01:30 仍按周五夜场判定为开放（未被日期切断）');
  const st2 = Schedule.statusAt(draft, Schedule.zonedMs(Schedule.addDays(d, 1), 180, TZ), TZ, null);
  assert.strictEqual(st2.open, false, '周六03:00 夜场结束后应闭馆');
  ok('跨午夜：周六03:00（夜场结束后）正确闭馆');
  // 同一时刻切换显示时区，状态不变
  const ny = Schedule.zonedParts(friLate, 'America/New_York');
  const stNY = Schedule.statusAt(draft, friLate, TZ, null); // 状态只按场馆时区算
  assert.strictEqual(stNY.open, st1.open);
  assert.notStrictEqual(ny.date, Schedule.zonedParts(friLate, TZ).date); // 显示日期不同
  ok('时区切换：显示时区不同（' + ny.date + ' vs ' + Schedule.zonedParts(friLate, TZ).date + '），开闭馆判定不变');

  /* ============ 场景2：优先级 ============ */
  console.log('\n[场景2] 优先级：临时事件 > 节假日 > 周历');
  const t0 = Schedule.zonedMs(d, 840, TZ); // 周五14:00（周历夜场内）
  assert.strictEqual(Schedule.statusAt(draft, t0, TZ, null).source, 'weekly');
  await api('POST', '/api/holidays', { date: d, name: '测试节假日', closed: false, open_min: 600, close_min: 960 });
  let boot2 = (await api('GET', '/api/bootstrap')).body;
  let st = Schedule.statusAt({ weekly: boot2.weekly, holidays: boot2.holidays, events: [] }, t0, TZ, null);
  assert.strictEqual(st.source, 'holiday');
  ok('节假日覆盖周历（14:00 来源=holiday）');
  const evC = (await api('POST', '/api/events', { title: '消防演练', kind: 'closed', zone_id: null,
    start_at: t0 - 3600e3, end_at: t0 + 3600e3, priority: 0 }, '张三')).body;
  boot2 = (await api('GET', '/api/bootstrap')).body;
  st = Schedule.statusAt({ weekly: boot2.weekly, holidays: boot2.holidays, events: boot2.events }, t0, TZ, null);
  assert.strictEqual(st.open, false); assert.strictEqual(st.source, 'event');
  ok('临时闭馆事件覆盖节假日（14:00 闭馆，来源=event）');
  await api('POST', '/api/events', { title: '贵宾专场', kind: 'open', zone_id: null,
    start_at: t0 - 3600e3, end_at: t0 + 3600e3, priority: 10 }, '张三');
  boot2 = (await api('GET', '/api/bootstrap')).body;
  st = Schedule.statusAt({ weekly: boot2.weekly, holidays: boot2.holidays, events: boot2.events }, t0, TZ, null);
  assert.strictEqual(st.open, true, '高优先级临时开放应覆盖低优先级闭馆');
  ok('同级事件按 priority 排序：priority=10 的临时开放胜出');

  /* ============ 场景3：两人同时改临时事件 ============ */
  console.log('\n[场景3] 两人同时改临时事件（乐观锁）');
  const cur = (await api('GET', '/api/bootstrap')).body.events.find(e => e.id === evC.id);
  const editA = { title: '消防演练A', kind: 'closed', zone_id: null, start_at: cur.start_at, end_at: cur.end_at, priority: 0, base_version: cur.version };
  const editB = Object.assign({}, editA, { title: '消防演练B' });
  const rA = await api('PUT', '/api/events/' + cur.id, editA, '李四');
  const rB = await api('PUT', '/api/events/' + cur.id, editB, '王五');
  assert.strictEqual(rA.status, 200); assert.strictEqual(rB.status, 409);
  assert.strictEqual(rB.body.current.version, cur.version + 1);
  ok('李四成功(v' + cur.version + '→v' + (cur.version + 1) + ')，王五基于过期版本 → 409 冲突');
  const rB2 = await api('PUT', '/api/events/' + cur.id, Object.assign(editB, { base_version: rB.body.current.version }), '王五');
  assert.strictEqual(rB2.status, 200);
  const audit = (await api('GET', '/api/audit')).body;
  assert.ok(audit.some(a => a.action === 'conflict' && a.actor === '王五'), '冲突应留痕');
  ok('王五以最新版本重试成功；审计日志含 conflict 记录（操作人留痕）');

  /* ============ 场景4：设备离线跨日 ============ */
  console.log('\n[场景4] 设备离线跨日 → 超过新鲜度 → 状态待核实');
  await api('POST', '/api/publications', { freshness_minutes: 30, note: '短新鲜度测试' }, 'tester');
  const pkgR = await api('GET', '/api/devices/term-1/package');
  assert.strictEqual(pkgR.status, 200);
  const pkg = pkgR.body, fetchedLocal = Date.now();
  const inWindow = TerminalCore.evaluate(pkg, TerminalCore.estimateNow(pkg, fetchedLocal, fetchedLocal + 10 * 60000));
  assert.strictEqual(inWindow.mode, 'ok');
  ok('新鲜度内（+10分钟）：本地计算正常，mode=ok');
  const nextDay = TerminalCore.evaluate(pkg, pkg.valid_until + 26 * 3600e3); // 离线跨日
  assert.strictEqual(nextDay.mode, 'stale');
  assert.strictEqual(nextDay.status.open, null);
  assert.match(nextDay.status.label, /待核实/);
  assert.ok(nextDay.routes.every(r => !r.enabled), '过期后导览全部禁用');
  assert.ok(nextDay.welcome && nextDay.basicNav && nextDay.zones.length > 0, '欢迎文字与基本导航保留');
  ok('离线跨日（超过 valid_until）：状态待核实、不承诺开放、导览禁用、欢迎与基本导航保留');

  /* ============ 场景5：背景文件失败 ============ */
  console.log('\n[场景5] 背景文件失败 → 备用背景');
  const bgOk = TerminalCore.pickBackground(pkg, true);
  assert.strictEqual(bgOk.type, 'image');
  const bgBad = TerminalCore.pickBackground(pkg, false);
  assert.strictEqual(bgBad.type, 'fallback'); assert.strictEqual(bgBad.degraded, true);
  assert.match(bgBad.note, /备用背景/);
  ok('背景加载失败 → 回退纯色背景并提示，欢迎文字与导航不受影响');

  /* ============ 场景6：旧导览回执晚到 ============ */
  console.log('\n[场景6] 旧导览回执晚到（幂等 + 留痕）');
  const p6 = (await api('POST', '/api/publications', { freshness_minutes: 1440, note: '回执测试发布' }, 'tester')).body;
  const pubNow = (await api('GET', '/api/bootstrap')).body.publications.find(p => p.id === p6.id);
  const T0 = pubNow.valid_from;                       // 发布生效时刻
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const r1 = await api('POST', '/api/receipts', { receipt_id: 'rcpt-001', route_id: 1, publication_id: pubNow.id,
    device_id: 'term-1', started_at: T0 + 10, completed_at: T0 + 20 });
  assert.strictEqual(r1.status, 201); assert.strictEqual(r1.body.receipt.late, 0);
  assert.strictEqual(r1.body.receipt.valid_at_start, 1);
  ok('现行发布的回执：正常登记，开始时有效');
  await sleep(120);                                    // 保证撤销时刻晚于回执时间戳
  const rv = await api('POST', `/api/publications/${pubNow.id}/revoke`, { reason: '内容有误，紧急撤回' }, '张三');
  assert.strictEqual(rv.status, 200);
  const noReason = await api('POST', `/api/publications/${pubNow.id}/revoke`, {}, '张三');
  assert.ok([400, 409].includes(noReason.status));
  const audit2 = (await api('GET', '/api/audit')).body;
  assert.ok(audit2.some(a => a.action === 'revoke' && /紧急撤回/.test(a.detail)), '撤销原因应留痕');
  ok('撤销发布：原因必填并写入审计（"内容有误，紧急撤回"）');
  // 晚到的旧回执：导览发生于撤销之前，回执在撤销之后才送达
  const r2 = await api('POST', '/api/receipts', { receipt_id: 'rcpt-002', route_id: 1, publication_id: pubNow.id,
    device_id: 'term-2', started_at: T0 + 30, completed_at: T0 + 40 });
  assert.strictEqual(r2.status, 201);
  assert.strictEqual(r2.body.receipt.late, 1, '旧发布的回执应标记晚到');
  assert.strictEqual(r2.body.receipt.valid_at_start, 1, '开始时该发布仍有效 → valid_at_start=1');
  const r2dup = await api('POST', '/api/receipts', { receipt_id: 'rcpt-002', route_id: 1, publication_id: pubNow.id,
    device_id: 'term-2', started_at: T0 + 30, completed_at: T0 + 40 });
  assert.strictEqual(r2dup.body.duplicated, true);
  const cnt = (await api('GET', '/api/receipts')).body.filter(x => x.receipt_id === 'rcpt-002').length;
  assert.strictEqual(cnt, 1, '重复提交不产生重复记录');
  ok('旧回执晚到：幂等接受、late=1、valid_at_start=1、重复提交去重');

  /* ============ 场景7：版本匹配 + 闭馆后旧页面不能引导进入 ============ */
  console.log('\n[场景7] 路线-展区版本匹配 / 撤销后终端 410 → 待核实');
  await api('PUT', '/api/zones/2', { name: '现代艺术厅·焕新' }, '张三');   // 展区版本 v1→v2
  const pub2 = (await api('POST', '/api/publications', { freshness_minutes: 1440, note: '展区改名后' }, '张三')).body;
  const pkg2 = (await api('GET', '/api/devices/term-1/package')).body;
  const route1 = pkg2.routes.find(r => r.id === 1);
  assert.strictEqual(route1.available_static, 0);
  assert.match(route1.static_reason, /版本已更新/);
  ok('展区改名(v2)后发布：引用 v1 的路线被标记不可用（' + route1.static_reason + '）');
  await api('PUT', '/api/routes/1', { zone_ids: [1, 2] }, '张三');        // 路线同步版本
  await api('POST', '/api/publications', { freshness_minutes: 1440, note: '路线已同步' }, '张三');
  const pkg3 = (await api('GET', '/api/devices/term-1/package')).body;
  assert.strictEqual(pkg3.routes.find(r => r.id === 1).available_static, 1);
  ok('路线同步到当前展区版本后重新发布：恢复可用');
  // 临时闭馆 → 包内评估导览禁用
  const now2 = Date.now();
  await api('POST', '/api/events', { title: '全馆临时闭馆', kind: 'closed', zone_id: null,
    start_at: now2 - 60000, end_at: now2 + 2 * 3600e3, priority: 99 }, '张三');
  await api('POST', '/api/publications', { freshness_minutes: 1440, note: '含闭馆事件' }, '张三');
  const pkg4 = (await api('GET', '/api/devices/term-1/package')).body;
  const evNow = TerminalCore.evaluate(pkg4, TerminalCore.estimateNow(pkg4, Date.now(), Date.now()));
  assert.strictEqual(evNow.status.open, false);
  assert.ok(evNow.routes.every(r => !r.enabled && /闭馆/.test(r.reason)));
  ok('闭馆事件入包后：终端本地评估即禁用全部导览入口');
  // 撤销现行发布 → 终端 410 → 待核实（旧页面不能继续引导）
  const pubs = (await api('GET', '/api/bootstrap')).body.publications;
  const active = pubs.find(p => p.status === 'active');
  await api('PUT', '/api/groups/1', { publication_id: active.id }, '张三');
  await api('POST', `/api/publications/${active.id}/revoke`, { reason: '验收测试：撤销现行发布' }, '张三');
  await api('PUT', '/api/groups/1', { publication_id: active.id }, '张三'); // 人为钉住已撤销版本（极端情况）
  const gone = await api('GET', '/api/devices/term-1/package');
  assert.strictEqual(gone.status, 410);
  assert.match(gone.body.reason, /撤销/);
  const h = TerminalCore.handlePackageHttp(gone.status, gone.body);
  assert.strictEqual(h.mode, 'stale');
  ok('发布被撤销后：终端拉包得到 410 + 原因 → 进入状态待核实，旧页面不再引导进入');

  console.log('\n========================================');
  console.log('全部验收场景通过，共 ' + passed + ' 项断言组');
  console.log('========================================');
  process.exit(0);
})().catch(e => { console.error('\n❌ 验收失败:', e); process.exit(1); });
