'use strict';
/*
 * 排期引擎（纯逻辑，可同时运行于 Node 与浏览器）。
 *
 * 三类规则在某一时刻裁决，命中最高优先级者生效，绝不按“当天日期”简单切断：
 *   1) temporary_event 临时事件（开/闭馆，最高）
 *   2) holiday        节假日安排（整段覆盖，可开可闭）
 *   3) weekly_rule    常规周历（含跨午夜，向前后延伸覆盖）
 *   都未命中 => closed（未排开放）
 *
 * interval: { start: epochMs, end: epochMs, state: 'open'|'closed', kind, rule, note }
 * 约定 end 为“结束瞬间”：开放区间 [start, end)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const T = require('./time');
    module.exports = factory(T);
  } else {
    root.PavilionSchedule = factory(root.PavilionTime);
  }
})(typeof self !== 'undefined' ? self : this, function (T) {
  const DAY = 86400000, HOUR = 3600000;
  const PRIORITY = { temporary_event: 3, holiday: 2, weekly_rule: 1 };

  // ---- 展开常规周历（含跨午夜）----
  function expandWeekly(rules, fromMs, toMs, tz) {
    const out = [];
    const start = T.startOfZonedDay(fromMs - 2 * DAY, tz);
    const endLimit = toMs + 2 * DAY;
    for (let day = start; day < endLimit; day = T.addZonedDays(day, tz, 1)) {
      const wd = T.localParts(day, tz).weekday;
      for (const r of rules) {
        if (!r.active) continue;
        if (r.weekdays && !r.weekdays.includes(wd)) continue;
        const { h: oh, mi: om } = T.parseHM(r.open);
        const { h: ch, mi: cm } = T.parseHM(r.close);
        let closeDay = day;
        if (T.closeOnNextDay(r.open, r.close)) closeDay = T.addZonedDays(day, tz, 1);
        const s = T.wallToUtc(T.localParts(day, tz).y, T.localParts(day, tz).m, T.localParts(day, tz).d, oh, om, tz);
        const e = T.wallToUtc(T.localParts(closeDay, tz).y, T.localParts(closeDay, tz).m, T.localParts(closeDay, tz).d, ch, cm, tz);
        if (e > fromMs && s < toMs) {
          out.push({ start: s, end: e, state: r.state || 'open', kind: 'weekly_rule', rule: r,
            note: r.name || ('常规开放 ' + T.fmtHM(s, tz) + '–' + T.fmtHM(e, tz) + (T.closeOnNextDay(r.open, r.close) ? '（跨午夜）' : '')) });
        }
      }
    }
    return out;
  }

  // ---- 展开节假日（按本地日期，闭区间日期范围）----
  function expandHolidays(rules, fromMs, toMs, tz) {
    const out = [];
    for (const r of rules) {
      if (!r.active) continue;
      const [y1, m1, d1] = r.start_date.split('-').map(Number);
      const [y2, m2, d2] = r.end_date.split('-').map(Number);
      let day = T.wallToUtc(y1, m1, d1, 0, 0, tz);
      const last = T.wallToUtc(y2, m2, d2, 0, 0, tz);
      for (; day <= last; day = T.addZonedDays(day, tz, 1)) {
        const p = T.localParts(day, tz);
        const s = T.wallToUtc(p.y, p.m, p.d, 0, 0, tz);
        const e = T.addZonedDays(s, tz, 1);
        if (e > fromMs && s < toMs) {
          out.push({ start: s, end: e, state: r.state || 'closed', kind: 'holiday', rule: r,
            note: (r.name || '节假日') + '（' + (r.state === 'open' ? '按节假日安排开放' : '闭馆') + '）' });
        }
      }
    }
    return out;
  }

  // ---- 展开临时事件（绝对 UTC 起止）----
  function expandTemporary(events, fromMs, toMs) {
    const out = [];
    for (const r of events) {
      if (!r.active) continue;
      const s = Number(r.start_ms), e = Number(r.end_ms);
      if (e > fromMs && s < toMs) {
        out.push({ start: s, end: e, state: r.state, kind: 'temporary_event', rule: r,
          note: (r.name || '临时事件') + '（' + (r.state === 'open' ? '临时开放' : '临时闭馆') + (r.reason ? '：' + r.reason : '') + '）' });
      }
    }
    return out;
  }

  function expandAll(schedule, fromMs, toMs, tz) {
    return []
      .concat(expandWeekly(schedule.weekly || [], fromMs, toMs, tz))
      .concat(expandHolidays(schedule.holidays || [], fromMs, toMs, tz))
      .concat(expandTemporary(schedule.temporary || [], fromMs, toMs));
  }

  function winnerAt(intervals, at) {
    let win = null;
    for (const iv of intervals) {
      if (at >= iv.start && at < iv.end) {
        if (!win || PRIORITY[iv.kind] > PRIORITY[win.kind] ||
            (PRIORITY[iv.kind] === PRIORITY[win.kind] && iv.start > win.start)) win = iv;
      }
    }
    return win;
  }

  function resolveAt(schedule, at, tz) {
    const w = winnerAt(expandAll(schedule, at - HOUR, at + HOUR, tz), at);
    if (w) return { state: w.state, kind: w.kind, note: w.note, interval: { start: w.start, end: w.end }, rule: w.rule };
    return { state: 'closed', kind: 'default', note: '未排开放时段', interval: null, rule: null };
  }

  // 从 at 起（默认向前 60 天）枚举状态边界，找当前状态的实际生效范围。
  // 同优先级但更晚开始的临时事件也会终止当前状态（后发布者覆盖）。
  function statusRange(schedule, at, tz, horizonDays) {
    horizonDays = horizonDays || 60;
    const lo = at - horizonDays * DAY, hi = at + horizonDays * DAY;
    const ivs = expandAll(schedule, lo, hi, tz);
    const win = winnerAt(ivs, at);
    const state = win ? win.state : 'closed';
    const kind = win ? win.kind : 'default';
    const boundaries = new Set();
    boundaries.add(lo); boundaries.add(hi);
    for (const iv of ivs) { boundaries.add(iv.start); boundaries.add(iv.end); }
    const pts = [...boundaries].filter((x) => x >= lo && x <= hi).sort((a, b) => a - b);

    // 分段身份：状态+优先级+（临时事件时的）具体规则对象，避免同一事件不同分段被错误连通
    const segId = (w) => !w ? 'default/closed'
      : `${w.kind}:${PRIORITY[w.kind]}:${w.state}:${w.kind === 'temporary_event' ? w.rule.id : ''}`;
    const curId = segId(win);

    let from = lo, until = hi;
    const curIdx = pts.findIndex((x, i) => x <= at && pts[i + 1] > at);
    for (let i = curIdx; i < pts.length - 1; i++) {
      const mid = (pts[i] + pts[i + 1]) / 2;
      if (segId(winnerAt(ivs, mid)) !== curId) { until = pts[i]; break; }
    }
    // from 精确化：向回走到首个不同身份分段
    from = lo;
    for (let i = curIdx; i >= 0; i--) {
      const mid = (pts[i] + pts[i + 1]) / 2;
      if (segId(winnerAt(ivs, mid)) !== curId) { from = pts[i + 1]; break; }
    }
    return {
      state, kind: win ? win.kind : 'default',
      note: win ? win.note : '未排开放时段',
      from: Math.max(from, lo), until: Math.min(until, hi),
      clampedFrom: from <= lo, clampedUntil: until >= hi,
      rule: win ? win.rule : null
    };
  }

  return { expandWeekly, expandHolidays, expandTemporary, expandAll, resolveAt, statusRange, PRIORITY };
});
