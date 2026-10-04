'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/time');
const C = require('../lib/client');

const tz = 'Asia/Shanghai';
const now = T.wallToUtc(2026, 10, 7, 10, 0, tz); // 周三 10:00，周历开放
function pkg(over) {
  return Object.assign({
    downloadedServerMs: now,
    ttlMs: 30000,
    maxSkewMs: 300000,
    snapshot: {
      version: 3, timezone: tz, welcome_text: '欢迎测试',
      schedule: {
        weekly: [{ active: true, weekdays: [1, 2, 3, 4, 5], open: '09:00', close: '18:00' }],
        holidays: [], temporary: []
      },
      areas: [{ id: 'a1', name: 'A', version: 3 }, { id: 'a2', name: 'B', version: 3 }],
      routes: [{ id: 'r1', name: 'R', area_ids: ['a1', 'a2'], version: 3 }],
      background: { etag: 9, status: 'ready', content: 'data:x' }
    }
  }, over || {});
}

test('在线：服务端实时结果为权威，开放时导览可用', () => {
  const live = { state: 'open', kind: 'weekly_rule', note: '开放', packageCurrent: true,
    routes: [{ id: 'r1', version: 3 }], routeVersionOk: (id, v) => id === 'r1' && v === 3 };
  const d = C.decide({ nowLocal: now, pkg: pkg(), live, routeId: 'r1' });
  assert.equal(d.source, 'server-realtime');
  assert.equal(d.display, 'open');
  assert.equal(d.guideEnabled, true);
});

test('实时为闭馆：即使离线包算出开放也不引导进入（旧页面不能继续引导）', () => {
  // 服务端因临时闭馆实时返回 closed，包内还是旧时间表
  const live = { state: 'closed', kind: 'temporary_event', note: '临时闭馆：设备检修',
    packageCurrent: true, routes: [{ id: 'r1', version: 3 }],
    routeVersionOk: (id, v) => id === 'r1' && v === 3 };
  const d = C.decide({ nowLocal: now, pkg: pkg(), live, routeId: 'r1' });
  assert.equal(d.guideEnabled, false);
  assert.match(d.guideReason, /非开放/);
});

test('离线：新鲜包本地计算开放，导览可用', () => {
  const d = C.decide({ nowLocal: now + 10000, pkg: pkg(), live: null, routeId: 'r1' });
  assert.equal(d.source, 'offline-package');
  assert.equal(d.display, 'open');
  assert.equal(d.guideEnabled, true);
});

test('离线跨午夜：包能在次日凌晨正确判定前夜场次仍开放（不被按当天切断）', () => {
  const p = pkg();
  p.snapshot.schedule.weekly = [{ active: true, weekdays: [6], open: '19:00', close: '02:00' }];
  p.ttlMs = 12 * 3600 * 1000;
  const satNight = T.wallToUtc(2026, 10, 3, 23, 50, tz);
  p.downloadedServerMs = satNight - 1000;
  const d1 = C.decide({ nowLocal: satNight, pkg: p, live: null });
  const d2 = C.decide({ nowLocal: T.wallToUtc(2026, 10, 4, 1, 30, tz), pkg: p, live: null });
  assert.equal(d1.display, 'open');
  assert.equal(d2.display, 'open'); // 周日凌晨
});

test('超过新鲜度期限：状态待核实，不再承诺开放，导览停用，仅保留欢迎与基本导航', () => {
  const d = C.decide({ nowLocal: now + 31000, pkg: pkg(), live: null, routeId: 'r1' });
  assert.equal(d.source, 'offline-stale');
  assert.equal(d.display, 'unverified');
  assert.equal(d.guideEnabled, false);
  assert.match(d.guideReason, /待核实/);
  assert.equal(d.welcomeText, '欢迎测试'); // 欢迎文字仍保留
  assert.ok(d.warnings.some((w) => w.includes('新鲜度')));
});

test('时钟漂移超容差：时间口径不可信，降级待核实', () => {
  const sync = { skew: 600000, rtt: 5, atLocal: now };
  const d = C.decide({ nowLocal: now, pkg: pkg(), live: null, sync });
  assert.equal(d.display, 'unverified');
  assert.ok(d.warnings.some((w) => w.includes('时钟漂移')));
});

test('校时去抖：RTT 更大的劣估计不覆盖好估计', () => {
  let s = C.estimateSkew(null, now - 2, now, now + 2); // rtt 4
  s = C.estimateSkew(s, now - 20, now + 100, now + 20); // rtt 40, skew 100
  assert.equal(s.skew, 0); // 保留旧估计
});

test('路线必须与展区可用版本匹配：引用缺失展区时按钮禁用', () => {
  const p = pkg();
  p.snapshot.routes = [
    { id: 'r1', name: 'R', area_ids: ['a1', 'a2'], version: 3 },
    { id: 'rBad', name: '坏路线', area_ids: ['a1', 'aGone'], version: 3 }];
  assert.equal(C.routeInPackage(p, 'rBad'), null);
  assert.equal(C.routeInPackage(p, 'r1').id, 'r1');
});

test('在线但包版本落后：导览停用并提示更新（闭馆后旧页面问题的在线侧）', () => {
  const live = { state: 'open', note: '开放', packageCurrent: false,
    routes: [{ id: 'r1', version: 4 }], routeVersionOk: () => false };
  const d = C.decide({ nowLocal: now, pkg: pkg(), live, routeId: 'r1' });
  assert.equal(d.guideEnabled, false);
  assert.match(d.guideReason, /版本/);
});

test('evaluateReceipt：旧导览回执晚到（包版本不符）被拒绝并给出原因', () => {
  const v = C.evaluateReceipt(
    { state: 'open', groupPublishedVersion: 4, releasedVersionOf: () => 3 },
    { routeId: 'r1', routeVersion: 3, packageVersion: 3 });
  assert.equal(v.accept, false);
  assert.equal(v.reason, 'package_version_mismatch');
});

test('evaluateReceipt：闭馆后到达的回执一律拒绝', () => {
  const v = C.evaluateReceipt(
    { state: 'closed', groupPublishedVersion: 3, releasedVersionOf: () => 3 },
    { routeId: 'r1', routeVersion: 3, packageVersion: 3 });
  assert.equal(v.accept, false);
  assert.equal(v.reason, 'closed_now');
});

test('evaluateReceipt：版本全匹配才受理', () => {
  const v = C.evaluateReceipt(
    { state: 'open', groupPublishedVersion: 3, releasedVersionOf: () => 3 },
    { routeId: 'r1', routeVersion: 3, packageVersion: 3 });
  assert.equal(v.accept, true);
});
