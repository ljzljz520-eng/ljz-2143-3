/* ============================================================================
 * 展馆排班核心解析逻辑（UMD：Node 服务端 与 C 终端浏览器 共用同一份代码）
 * 优先级：临时事件(priority 高者优先, 同级 updated_at 晚者优先) > 节假日 > 常规周历
 * 跨午夜：会话以"开场日 + 分钟数"表示，close_min 可 >1440（如 1560 = 次日02:00），
 *         评估某时刻时同时展开"昨日"规则，使昨日会话的溢出部分不被按当天日期切断。
 * ==========================================================================*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Schedule = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MIN = 60000, DAY = 86400000;
  var WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function pad(n) { return String(n).padStart(2, '0'); }

  /* UTC毫秒 → 指定 IANA 时区的墙钟部件 */
  function zonedParts(ms, tz) {
    var dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    var p = {};
    dtf.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    var wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(ms));
    return {
      year: +p.year, month: +p.month, day: +p.day,
      hour: +p.hour, minute: +p.minute, second: +p.second,
      weekday: WD[wd],
      date: p.year + '-' + p.month + '-' + p.day
    };
  }

  /* 场馆墙钟（日期 + 当日分钟数，分钟可 >1440 表示跨午夜）→ UTC毫秒。
   * 迭代修正时区偏移；DST 缝隙处可能偏差一个偏移量（README 已注明边界）。 */
  function zonedMs(dateStr, minutes, tz) {
    var wantWall = Date.parse(dateStr + 'T00:00:00Z') + minutes * MIN;
    var guess = wantWall;
    for (var i = 0; i < 4; i++) {
      var p = zonedParts(guess, tz);
      var wallAtGuess = Date.parse(p.date + 'T' + pad(p.hour) + ':' + pad(p.minute) + ':' + pad(p.second) + 'Z');
      var diff = wantWall - wallAtGuess;
      if (diff === 0) break;
      guess += diff;
    }
    return guess;
  }

  function addDays(dateStr, n) {
    var d = new Date(Date.parse(dateStr + 'T00:00:00Z') + n * DAY);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function fmtMin(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function clock(ms, tz) { var p = zonedParts(ms, tz); return pad(p.hour) + ':' + pad(p.minute); }

  /* 展开某本地日期的"原始会话"（节假日优先于周历；当日有节假日则周历不展开） */
  function rawSessionsForDate(data, dateStr, tz) {
    var out = [];
    var weekday = zonedParts(zonedMs(dateStr, 720, tz), tz).weekday;
    var hols = (data.holidays || []).filter(function (h) { return h.date === dateStr; });
    if (hols.length) {
      hols.forEach(function (h) {
        if (h.closed) return; // 节假日闭馆：当日无会话
        out.push({ start: zonedMs(dateStr, h.open_min, tz), end: zonedMs(dateStr, h.close_min, tz),
          source: 'holiday', label: '节假日·' + h.name });
      });
    } else {
      (data.weekly || []).filter(function (w) { return w.enabled && w.weekday === weekday; })
        .forEach(function (w) {
          out.push({ start: zonedMs(dateStr, w.open_min, tz), end: zonedMs(dateStr, w.close_min, tz),
            source: 'weekly', label: w.label || '常规开放' });
        });
    }
    return out;
  }

  /* 覆盖时刻 ms 的会话（同时展开昨日规则 → 跨午夜溢出不被切断） */
  function sessionsCovering(data, ms, tz) {
    var local = zonedParts(ms, tz);
    var out = [];
    [local.date, addDays(local.date, -1)].forEach(function (d) {
      rawSessionsForDate(data, d, tz).forEach(function (s) {
        if (s.start <= ms && ms < s.end) out.push(s);
      });
    });
    return out;
  }

  /* 临时事件：绝对时间区间。zoneId=null 取整馆事件；否则整馆+该展区事件。 */
  function eventAt(data, ms, zoneId) {
    var evs = (data.events || []).filter(function (e) {
      return e.start_at <= ms && ms < e.end_at &&
        (zoneId == null ? e.zone_id == null : (e.zone_id == null || e.zone_id === zoneId));
    });
    if (!evs.length) return null;
    evs.sort(function (a, b) {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.updated_at - a.updated_at;
    });
    return evs[0];
  }

  /* 某时刻开闭馆状态。zoneId=null 表示整馆。 */
  function statusAt(data, ms, tz, zoneId) {
    var ev = eventAt(data, ms, zoneId);
    if (ev) {
      if (ev.kind === 'closed') return { open: false, source: 'event', label: '临时闭馆·' + ev.title, until: ev.end_at };
      return { open: true, source: 'event', label: '临时开放·' + ev.title, until: ev.end_at };
    }
    if (zoneId == null) {
      var s = sessionsCovering(data, ms, tz);
      if (s.length) {
        var soonest = s.reduce(function (a, b) { return a.end < b.end ? a : b; });
        return { open: true, source: soonest.source, label: soonest.label, until: soonest.end };
      }
    }
    return { open: false, source: 'none', label: '闭馆', until: null };
  }

  /* 路线可用性：路线引用的展区版本必须与当前数据中的展区版本一致，
   * 展区须启用，且该时刻展区未被临时闭馆事件覆盖。 */
  function routeAvailable(data, route, ms, tz) {
    if (!route.enabled) return { ok: false, reason: '路线已停用' };
    var refs = route.zone_refs || [];
    for (var i = 0; i < refs.length; i++) {
      var z = null;
      (data.zones || []).forEach(function (zz) { if (zz.id === refs[i].zone_id) z = zz; });
      if (!z) return { ok: false, reason: '引用的展区不存在' };
      if (z.version !== refs[i].zone_version)
        return { ok: false, reason: '展区「' + z.name + '」版本已更新，路线未同步' };
      if (!z.enabled) return { ok: false, reason: '展区「' + z.name + '」已关闭' };
      var ev = eventAt(data, ms, refs[i].zone_id);
      if (ev && ev.kind === 'closed') return { ok: false, reason: '展区「' + z.name + '」临时闭馆：' + ev.title };
    }
    return { ok: true, reason: '' };
  }

  /* 某日 00:00–24:00 的生效时间线（5分钟采样合并），管理端"实际生效范围"与终端"今日时段"共用 */
  function dayTimeline(data, dateStr, tz) {
    var start = zonedMs(dateStr, 0, tz), end = zonedMs(dateStr, 1440, tz);
    var segs = [], cur = null;
    for (var t = start; t < end; t += 5 * MIN) {
      var st = statusAt(data, t, tz, null);
      var key = (st.open ? 'open' : 'closed') + '|' + st.source + '|' + st.label;
      if (cur && cur.key === key) cur.end = t + 5 * MIN;
      else { cur = { key: key, open: st.open, source: st.source, label: st.label, start: t, end: t + 5 * MIN }; segs.push(cur); }
    }
    segs.forEach(function (s) { delete s.key; s.start_clock = clock(s.start, tz); s.end_clock = clock(s.end, tz); });
    return segs;
  }

  return {
    MIN: MIN, DAY: DAY,
    zonedParts: zonedParts, zonedMs: zonedMs, addDays: addDays,
    fmtMin: fmtMin, clock: clock,
    rawSessionsForDate: rawSessionsForDate, sessionsCovering: sessionsCovering,
    eventAt: eventAt, statusAt: statusAt, routeAvailable: routeAvailable,
    dayTimeline: dayTimeline
  };
});
