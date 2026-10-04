/* ============================================================================
 * C 终端核心逻辑（UMD：浏览器 terminal.html 与 Node 验收测试共用）
 * 关键规则：
 *  - 新鲜度内：用包内时间表本地计算开闭馆与导览可用性；
 *  - 超过 valid_until：进入"状态待核实"，保留欢迎文字与基本导航，不再承诺开放；
 *  - 时钟估算：estNow = generated_at + (本地经过时间)。离线期间设备时钟漂移
 *    无法被校正，误差随离线时长累积（README 说明边界）。
 * ==========================================================================*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./schedule.js'));
  else root.TerminalCore = factory(root.Schedule);
})(typeof self !== 'undefined' ? self : this, function (Schedule) {
  'use strict';

  var DEFAULT_WELCOME = '欢迎光临';

  /* 估算当前时刻：下载包时的服务器时刻 + 本地经过时长 */
  function estimateNow(pkg, fetchedLocalMs, nowLocalMs) {
    return pkg.generated_at + (nowLocalMs - fetchedLocalMs);
  }

  /* 评估终端应呈现的状态。返回结构同时服务于界面渲染与自动化验收。 */
  function evaluate(pkg, estNow) {
    var base = {
      welcome: (pkg && pkg.welcome_text) || DEFAULT_WELCOME,
      basicNav: true,                       // 基本导航（静态展区介绍）始终保留
      zones: ((pkg && pkg.zones) || []).map(function (z) { return { id: z.id, name: z.name }; })
    };
    if (!pkg) {
      base.mode = 'stale';
      base.status = { open: null, label: '状态待核实', reason: '无可用数据包，请联网刷新' };
      base.routes = [];
      return base;
    }
    if (estNow > pkg.valid_until) {
      base.mode = 'stale';
      base.status = {
        open: null, label: '状态待核实',
        reason: '信息已超过新鲜度期限（' + new Date(pkg.valid_until).toISOString() + '），不再承诺开放，请联网核实'
      };
      base.routes = (pkg.routes || []).map(function (r) {
        return { id: r.id, name: r.name, enabled: false, reason: '状态待核实，导览暂不可用' };
      });
      return base;
    }
    var st = Schedule.statusAt(pkg, estNow, pkg.tz, null);
    base.mode = 'ok';
    base.status = st;
    base.publication_version = pkg.version;
    base.routes = (pkg.routes || []).map(function (r) {
      var chk = Schedule.routeAvailable(pkg, r, estNow, pkg.tz);
      var ok = chk.ok && st.open === true;
      var reason = ok ? '' : (!st.open ? '当前闭馆，导览入口已关闭' : chk.reason);
      return { id: r.id, name: r.name, enabled: ok, reason: reason };
    });
    return base;
  }

  /* 背景选择：文件加载失败时回退到纯色/渐变，绝不让终端黑屏 */
  function pickBackground(pkg, loadOk) {
    var bg = (pkg && pkg.bg) || {};
    if (loadOk && bg.url) return { type: 'image', url: bg.url, degraded: false };
    return {
      type: 'fallback', degraded: true,
      color: bg.fallback_color || '#1f2a44',
      note: '背景文件加载失败，已切换备用背景（欢迎文字与导航不受影响）'
    };
  }

  /* 处理包接口响应：410（发布已撤销）/404（未分配）→ 待核实 */
  function handlePackageHttp(status, body) {
    if (status === 200) return { mode: 'ok', pkg: body };
    var reason = (body && (body.reason || body.message || body.error)) || ('HTTP ' + status);
    if (status === 410) reason = '发布版本已撤销（' + reason + '）';
    return { mode: 'stale', reason: reason };
  }

  return {
    estimateNow: estimateNow,
    evaluate: evaluate,
    pickBackground: pickBackground,
    handlePackageHttp: handlePackageHttp
  };
});
