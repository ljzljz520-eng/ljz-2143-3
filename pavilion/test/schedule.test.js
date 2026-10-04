'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/time');
const S = require('../lib/schedule');

const tz = 'Asia/Shanghai';
const at = (y, m, d, h, mi) => T.wallToUtc(y, m, d, h, mi, tz);

test('常规周历：开放区间与闭区间', () => {
  const sch = { weekly: [{ active: true, weekdays: [1, 2, 3, 4, 5], open: '09:00', close: '18:00' }], holidays: [], temporary: [] };
  assert.equal(S.resolveAt(sch, at(2026, 9, 30, 10, 0), tz).state, 'open');   // 周三 10:00
  assert.equal(S.resolveAt(sch, at(2026, 9, 30, 8, 59), tz).state, 'closed');
  assert.equal(S.resolveAt(sch, at(2026, 10, 3, 12, 0), tz).state, 'closed'); // 周六
});

test('跨午夜开放不能被当天日期切断：周六 19:00–周日 02:00', () => {
  const sch = { weekly: [{ active: true, weekdays: [6], open: '19:00', close: '02:00' }], holidays: [], temporary: [] };
  assert.equal(S.resolveAt(sch, at(2026, 10, 3, 23, 30), tz).state, 'open');  // 周六深夜
  assert.equal(S.resolveAt(sch, at(2026, 10, 4, 0, 30), tz).state, 'open');   // 周日凌晨——属于前夜场次
  assert.equal(S.resolveAt(sch, at(2026, 10, 4, 2, 0), tz).state, 'closed');  // 02:00 结束
  assert.equal(S.resolveAt(sch, at(2026, 10, 4, 1, 59), tz).state, 'open');
  const r = S.statusRange(sch, at(2026, 10, 3, 23, 30), tz, 7);
  assert.equal(r.from, at(2026, 10, 3, 19, 0));
  assert.equal(r.until, at(2026, 10, 4, 2, 0));
});

test('优先级：临时闭馆 > 节假日 > 周历；临时开放可覆盖节假日闭馆', () => {
  const sch = {
    weekly: [{ active: true, weekdays: [0, 1, 2, 3, 4, 5, 6], open: '09:00', close: '18:00' }],
    holidays: [{ active: true, name: '国庆', start_date: '2026-10-01', end_date: '2026-10-03', state: 'closed' }],
    temporary: []
  };
  // 10-01 10:00：周历开放，但节假日闭馆覆盖
  assert.equal(S.resolveAt(sch, at(2026, 10, 1, 10, 0), tz).kind, 'holiday');
  // 加一条临时开放
  sch.temporary.push({ id: 1, active: true, name: '特别开放日', start_ms: at(2026, 10, 1, 9, 0), end_ms: at(2026, 10, 1, 12, 0), state: 'open' });
  assert.equal(S.resolveAt(sch, at(2026, 10, 1, 10, 0), tz).kind, 'temporary_event');
  assert.equal(S.resolveAt(sch, at(2026, 10, 1, 13, 0), tz).kind, 'holiday'); // 临时事件结束后回到节假日
  // 再加临时闭馆（后发布、更晚开始）在 10-11 重叠：临时事件间后者胜
  sch.temporary.push({ id: 2, active: true, name: '抢修', start_ms: at(2026, 10, 1, 10, 30), end_ms: at(2026, 10, 1, 11, 0), state: 'closed' });
  assert.equal(S.resolveAt(sch, at(2026, 10, 1, 10, 45), tz).state, 'closed');
  assert.equal(S.resolveAt(sch, at(2026, 10, 1, 10, 45), tz).rule.id, 2);
});

test('实际生效范围：临时事件被更高优先级压缩时 effective 反映被压缩后的区间', () => {
  const sch = {
    weekly: [], holidays: [],
    temporary: [
      { id: 1, active: true, name: '临时开放', start_ms: at(2026, 10, 10, 9, 0), end_ms: at(2026, 10, 10, 18, 0), state: 'open' },
      { id: 2, active: true, name: '闭馆抢修', start_ms: at(2026, 10, 10, 12, 0), end_ms: at(2026, 10, 10, 14, 0), state: 'closed' }
    ]
  };
  // 中午 13:00 为抢修闭馆，生效范围即抢修区间
  const r1 = S.statusRange(sch, at(2026, 10, 10, 13, 0), tz, 30);
  assert.equal(r1.state, 'closed');
  assert.equal(r1.from, at(2026, 10, 10, 12, 0));
  assert.equal(r1.until, at(2026, 10, 10, 14, 0));
  // 抢修两侧开放被切成两段：10:00 所处段到 12:00 结束
  const r2 = S.statusRange(sch, at(2026, 10, 10, 10, 0), tz, 30);
  assert.equal(r2.from, at(2026, 10, 10, 9, 0));
  assert.equal(r2.until, at(2026, 10, 10, 12, 0));
});

test('时区切换：同一条周历在 America/Los_Angeles 下按本地时间解释', () => {
  const la = 'America/Los_Angeles';
  const sch = { weekly: [{ active: true, weekdays: [5], open: '10:00', close: '11:00' }], holidays: [], temporary: [] };
  const u = T.wallToUtc(2026, 10, 2, 10, 30, la); // 周五（PDT, UTC-7）10:30 = 17:30 UTC
  assert.equal(S.resolveAt(sch, u, la).state, 'open');
  assert.equal(T.localParts(u, la).hh, 10);
  assert.equal(new Date(u).getUTCHours(), 17);
});

test('DST 缺口映射不抛错且为有限值', () => {
  const la = 'America/Los_Angeles';
  const u = T.wallToUtc(2026, 3, 8, 2, 30, la); // 本地 02:30 在 spring-forward 缺口中不存在
  assert.ok(Number.isFinite(u));
});
