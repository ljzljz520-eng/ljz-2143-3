(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PavilionTime = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/*
 * 时区工具。
 * 约定：数据库/API 内部一律使用 UTC epoch 毫秒；
 * 周历/节假日这类“挂钟时间”规则在展馆配置的 IANA 时区（如 Asia/Shanghai）中解释。
 */

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(epochMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(epochMs))) p[part.type] = part.value;
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    hh: p.hour === '24' ? 0 : Number(p.hour), mm: Number(p.minute), ss: Number(p.second),
    weekday: WEEKDAYS[p.weekday]
  };
}

// 墙钟时间(本地 y-m-d hh:mm) -> UTC epoch。
// 通过对猜测点前后一天采样，正确处理夏令时缺口（spring-forward）与重叠（fall-back）。
function wallToUtc(y, m, d, hh, mm, tz) {
  const DAY = 86400000;
  const wallFakeUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offsetAt = (u) => u - Date.UTC(...(function () {
    const q = localParts(u, tz);
    return [q.y, q.m - 1, q.d, q.hh, q.mm, q.ss];
  })());
  const candidates = [];
  for (const probe of [wallFakeUtc - DAY, wallFakeUtc, wallFakeUtc + DAY]) {
    const o = offsetAt(probe);
    const u = wallFakeUtc + o;
    const q = localParts(u, tz);
    if (q.y === y && q.m === m && q.d === d && q.hh === hh && q.mm === mm) {
      candidates.push(u);
    }
  }
  if (candidates.length) return Math.min(...candidates); // 重叠时取第一次出现
  // 本地时间落入 DST 缺口：按缺口后的偏移平移（该时刻本地不存在）
  const oAfter = offsetAt(wallFakeUtc + DAY);
  return wallFakeUtc + oAfter;
}

function startOfZonedDay(epochMs, tz) {
  const p = localParts(epochMs, tz);
  return wallToUtc(p.y, p.m, p.d, 0, 0, tz);
}

function addZonedDays(epochMs, tz, n) {
  const p = localParts(epochMs, tz);
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return wallToUtc(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), p.hh, p.mm, tz);
}

function parseHM(s) {
  const [h, mi] = String(s).split(':').map(Number);
  return { h, mi };
}

// 闭馆时刻是否属于“次日”（跨午夜）：close <= open 即跨午夜；'24:00' 视为 00:00 次日。
function closeOnNextDay(openHM, closeHM) {
  const o = parseHM(openHM), c = parseHM(closeHM);
  const om = o.h * 60 + o.mi, cm = c.h * 60 + c.mi;
  return cm <= om;
}

function fmtHM(epochMs, tz) {
  const p = localParts(epochMs, tz);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

function fmtDate(epochMs, tz) {
  const p = localParts(epochMs, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

module.exports = { localParts, wallToUtc, startOfZonedDay, addZonedDays, parseHM, closeOnNextDay, fmtHM, fmtDate, WEEKDAYS };

return { localParts, wallToUtc, startOfZonedDay, addZonedDays, parseHM, closeOnNextDay, fmtHM, fmtDate, WEEKDAYS };
});
