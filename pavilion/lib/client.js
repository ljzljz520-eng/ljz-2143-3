'use strict';
/*
 * C 终端裁决库（纯逻辑，Node/浏览器通用）。
 *
 * 两条信息路径：
 *  A. 提前下载的“带时间表的包”：离线时用本地引擎按包内快照排期计算开放状态；
 *     受“新鲜度期限 TTL”和“时钟漂移容差”双重约束。
 *  B. 服务端实时计算 /api/status：在线时为权威结果，并校正本地时钟。
 *
 * 边界（超出即降级，不继续承诺开放）：
 *   - 离线数据年龄 > TTL：展示“状态待核实”，只保留欢迎文字与基本导航；
 *   - 已知时钟漂移 |skew| > maxSkew：时间口径不可信，同样降级；
 *   - 离线后漂移无法继续测量，故 TTL 是离线承诺开放的硬上限；
 *   - 临时事件只存在于服务端，离线期间新发布的临时变更无法送达，
 *     只能等下次在线同步；在线时一律以服务端实时结果为准。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./schedule'));
  } else {
    root.PavilionClient = factory(root.PavilionSchedule);
  }
})(typeof self !== 'undefined' ? self : this, function (S) {

  // 用一次往返估计时钟偏差：skew = serverTime - localMidpoint
  function estimateSkew(prev, localSendMs, serverNowMs, localRecvMs) {
    const skew = serverNowMs - (localSendMs + localRecvMs) / 2;
    const rtt = localRecvMs - localSendMs;
    // 仅当新估计的网络误差窗口更小时采用（简单去抖）
    if (prev && prev.rtt != null && rtt > prev.rtt) return prev;
    return { skew, rtt, atLocal: localRecvMs };
  }

  function correctedNow(localNowMs, sync) {
    return localNowMs + (sync ? sync.skew : 0);
  }

  // 包内路线与展区版本是否自洽（导览按钮引用的路线必须匹配展区可用版本）
  function routeInPackage(pkg, routeId) {
    if (!pkg || !pkg.snapshot) return null;
    const route = (pkg.snapshot.routes || []).find((r) => r.id === routeId);
    if (!route) return null;
    const areas = pkg.snapshot.areas || [];
    for (const aid of route.area_ids || []) {
      const a = areas.find((x) => x.id === aid);
      if (!a) return null; // 路线引用了该版本包里不存在/不可用的展区
    }
    return route;
  }

  /*
   * ctx: {
   *   nowLocal, pkg: {snapshot, downloadedServerMs, receivedAtLocalMs, ttlMs, maxSkewMs},
   *   live: null | {serverNow, state, kind, note, from, until, groupVersion, packageCurrent,
   *                 backgroundEtag, welcomeText, staleText, closed, routeOpen, routes}
   *   sync: estimateSkew() 的结果（最近一次在线校时）
   * }
   */
  function decide(ctx) {
    const { nowLocal, pkg, live, sync, routeId } = ctx;
    const warnings = [];
    const base = {
      welcomeText: pkg && pkg.snapshot ? pkg.snapshot.welcome_text : (live && live.welcomeText) || '欢迎莅临展馆',
      staleText: (live && live.staleText) || '状态待核实，请以现场公告或工作人员指引为准',
      timezone: pkg && pkg.snapshot ? pkg.snapshot.timezone : 'Asia/Shanghai',
      warnings
    };

    const route = routeInPackage(pkg, routeId);

    // ---- 路径 B：服务端实时，权威 ----
    if (live) {
      const guideEnabled = live.state === 'open'
        && live.packageCurrent === true
        && (!routeId || !!route)
        && (routeId ? live.routeVersionOk(routeId, route ? route.version : null) : true);
      if (!live.packageCurrent) warnings.push('本地包版本已过期或被撤销，导览已停用，等待下发新包');
      if (live.state !== 'open') warnings.push('服务端实时状态：' + live.note);
      if (routeId && !route) warnings.push('路线在当前展区可用版本中不存在');
      return Object.assign({}, base, {
        source: 'server-realtime', display: live.state, kind: live.kind, note: live.note,
        from: live.from, until: live.until,
        guideEnabled: live.state === 'open' ? guideEnabled : false,
        guideReason: guideEnabled ? null
          : live.state !== 'open' ? '当前非开放时段，旧页面不得继续引导进入'
          : !live.packageCurrent ? '导览内容版本与展区不匹配，需更新终端包'
          : '路线不可用',
        backgroundEtag: live.backgroundEtag, clockSkewMs: sync ? sync.skew : 0
      });
    }

    // ---- 路径 A：离线，用下载的包本地计算 ----
    if (!pkg || !pkg.snapshot || !pkg.snapshot.schedule) {
      return Object.assign({}, base, { source: 'offline-nopkg', display: 'unverified',
        note: '终端没有可用的时间表包', guideEnabled: false, guideReason: '缺少离线包',
        clockSkewMs: sync ? sync.skew : 0 });
    }
    const tz = pkg.snapshot.timezone;
    const now = correctedNow(nowLocal, sync);
    const dataAge = now - pkg.downloadedServerMs;
    const skewAbs = sync ? Math.abs(sync.skew) : 0;
    const ttlMs = pkg.ttlMs || 12 * 3600 * 1000;
    const maxSkew = pkg.maxSkewMs != null ? pkg.maxSkewMs : 5 * 60 * 1000;

    if (dataAge > ttlMs) {
      warnings.push(`离线数据已超过新鲜度期限（${Math.round(dataAge / 1000)}s > ${Math.round(ttlMs / 1000)}s），不再承诺开放状态`);
    }
    if (skewAbs > maxSkew) {
      warnings.push(`终端时钟漂移 ${skewAbs}ms 超过容差 ${maxSkew}ms，时间口径不可信`);
    }
    const stale = dataAge > ttlMs || skewAbs > maxSkew;

    const r = S.resolveAt(pkg.snapshot.schedule, now, tz);
    if (stale) {
      // 仅作参考地展示本地计算结果，但状态定性为“待核实”
      return Object.assign({}, base, { source: 'offline-stale', display: 'unverified',
        localHint: r.state, kind: r.kind, note: base.staleText, computedNote: r.note,
        dataAgeMs: dataAge, ttlMs, clockSkewMs: sync ? sync.skew : 0,
        guideEnabled: false, guideReason: '状态待核实：离线包过旧或时钟漂移超限',
        backgroundEtag: pkg.snapshot.background ? pkg.snapshot.background.etag : null });
    }
    const guideEnabled = r.state === 'open' && (!routeId || !!route);
    return Object.assign({}, base, {
      source: 'offline-package', display: r.state, kind: r.kind, note: r.note + '（离线包计算）',
      dataAgeMs: dataAge, ttlMs, clockSkewMs: sync ? sync.skew : 0,
      guideEnabled,
      guideReason: guideEnabled ? null : (r.state !== 'open' ? '当前非开放时段' : '路线不可用'),
      backgroundEtag: pkg.snapshot.background ? pkg.snapshot.background.etag : null
    });
  }

  // 服务端对导览进入回执的裁决（供 UI/测试共用同一条规则）
  function evaluateReceipt(server, receipt) {
    // server: {state, groupPublishedVersion, releasedVersionOf(routeId), routeExists}
    if (server.state !== 'open') {
      return { accept: false, reason: 'closed_now', message: '当前非开放时段，禁止进入导览' };
    }
    if (receipt.packageVersion == null || receipt.packageVersion !== server.groupPublishedVersion) {
      return { accept: false, reason: 'package_version_mismatch',
        message: `终端包版本 v${receipt.packageVersion} 与分组当前发布 v${server.groupPublishedVersion} 不匹配（旧页面/晚到回执）` };
    }
    const rv = server.releasedVersionOf(receipt.routeId);
    if (rv == null) return { accept: false, reason: 'route_unavailable', message: '路线在当前展区可用版本中不存在或已撤销' };
    if (receipt.routeVersion !== rv) {
      return { accept: false, reason: 'route_version_mismatch', message: `路线版本 v${receipt.routeVersion} 与可用版本 v${rv} 不匹配` };
    }
    return { accept: true, reason: null };
  }

  return { estimateSkew, correctedNow, routeInPackage, decide, evaluateReceipt };
});
