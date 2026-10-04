'use strict';
/* C 终端逻辑：
 * 在线 -> /status 实时权威 + 校时；离线 -> 用预下载包本地裁决；
 * 超新鲜度或时钟漂移超限 -> “状态待核实”，不承诺开放、停用导览。 */
const $ = (id) => document.getElementById(id);
const state = {
  live: null,        // 最近一次实时结果
  pkg: null,         // 预下载的包 {snapshot, downloadedServerMs, ttlMs, maxSkewMs}
  sync: null,        // 校时 {skew, rtt, atLocal}
  lastReceiptContext: null
};

function deviceId() { return $('device-id').value.trim() || 'd-demo'; }
function groupId() { return $('group-id').value.trim() || 'g-demo'; }
function offline() { return $('force-offline').checked; }
function localNow() { return Date.now() + Number($('clock-offset').value || 0); }

function simLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  $('sim-log').textContent = line + '\n' + $('sim-log').textContent;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch (e) {}
  return { ok: res.ok, status: res.status, body };
}

// 校时 + 实时状态（一次往返）
async function refreshLive() {
  if (offline()) { state.live = null; render(); return; }
  const t1 = localNow();
  const r = await api(`/api/devices/${encodeURIComponent(deviceId())}/status?groupId=${encodeURIComponent(groupId())}`);
  const t2 = localNow();
  if (r.ok && r.body && typeof r.body.server_now === 'number') {
    state.sync = PavilionClient.estimateSkew(state.sync, t1, r.body.server_now, t2);
    state.live = r.body;
    state.live.routeVersionOk = (routeId, routeVersion) => {
      const rr = r.body.routes.find((x) => x.id === routeId);
      return !!rr && rr.version === routeVersion;
    };
  } else {
    state.live = null; // 网络失败：退化为离线包裁决
    simLog('实时状态获取失败，退化为离线包本地计算');
  }
  render();
}

async function downloadPackage() {
  const r = await api(`/api/devices/${encodeURIComponent(deviceId())}/package?groupId=${encodeURIComponent(groupId())}`);
  if (!r.ok) { simLog('下载包失败：' + (r.body && r.body.message || r.status)); return; }
  state.pkg = {
    snapshot: r.body.snapshot,
    downloadedServerMs: r.body.downloaded_server_ms,
    ttlMs: r.body.ttl_ms,
    maxSkewMs: r.body.max_clock_skew_ms
  };
  simLog(`已下载包 v${r.body.snapshot.version}，TTL=${Math.round(r.body.ttl_ms / 1000)}s`);
  render();
}

// 选择路线：在线/离线均须通过客户端裁决，再向服务端提交回执
async function enterGuide(routeId) {
  const d = PavilionClient.decide({
    nowLocal: localNow(), pkg: state.pkg, live: offline() ? null : state.live,
    sync: state.sync, routeId
  });
  if (!d.guideEnabled) { simLog('导览被阻止：' + d.guideReason); render(); return; }
  const route = PavilionClient.routeInPackage(state.pkg, routeId);
  if (!route) { simLog('导览被阻止：路线与展区可用版本不匹配'); return; }
  const nonce = `${deviceId()}-${routeId}-${Date.now()}`;
  state.lastReceiptContext = { routeId, routeVersion: route.version, packageVersion: state.pkg.snapshot.version };
  const res = await api(`/api/devices/${encodeURIComponent(deviceId())}/receipts?groupId=${encodeURIComponent(groupId())}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, routeId, routeVersion: route.version, packageVersion: state.pkg.snapshot.version })
  });
  if (res.ok) simLog(`导览进入已受理：${routeId}（v${route.version}，包 v${state.pkg.snapshot.version}）`);
  else simLog(`回执被拒绝：${res.body && res.body.reason} — ${res.body && res.body.message}`);
}

// 旧导览回执晚到：手里还是旧包时（或无包），把保存的旧上下文重放给服务端
async function sendLateReceipt() {
  const ctx = state.lastReceiptContext;
  const payload = ctx || { routeId: 'r-classic', routeVersion: 1, packageVersion: 1 };
  const nonce = 'late-' + Date.now();
  const res = await api(`/api/devices/${encodeURIComponent(deviceId())}/receipts?groupId=${encodeURIComponent(groupId())}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, ...payload })
  });
  simLog(`晚到回执（路线 ${payload.routeId} v${payload.routeVersion}，包 v${payload.packageVersion}）-> ` +
    (res.ok ? '受理（不应发生）' : `拒绝：${res.body.reason}（${res.body.message}）`));
}

// ---------------- 渲染 ----------------
function renderBackground(pkg, live) {
  const bg = $('bg');
  if ($('bg-fail').checked) {
    // 背景文件失败：降级为内置渐变，欢迎文字与基本导航仍保留
    bg.style.background = 'linear-gradient(135deg,#222,#444)';
    return;
  }
  const snap = pkg && pkg.snapshot;
  const bgf = snap && snap.background;
  if (bgf && bgf.status === 'ready' && bgf.content) {
    bg.style.background = `#082033 url("${bgf.content}") center/cover no-repeat`;
  } else if (bgf && bgf.status === 'failed') {
    bg.style.background = 'linear-gradient(135deg,#2a1d12,#44402a)';
  } else {
    bg.style.background = 'linear-gradient(135deg,#0b3d66,#127a8c)';
  }
}

function renderHours(pkg) {
  const el = $('open-hours');
  if (!pkg) { el.innerHTML = '<div class="tag">开放时段</div><span>暂无离线时间表，待联网获取</span>'; return; }
  const tz = pkg.snapshot.timezone;
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  const rows = (pkg.snapshot.schedule.weekly || []).map((r) => {
    const cross = PavilionTime.closeOnNextDay(r.open, r.close);
    const wds = r.weekdays.map((w) => '周' + names[w]).join('、');
    return `<div><span class="tag">${wds}</span> ${r.open} – ${r.close}
      ${cross ? '<span class="cross">（跨午夜，次日凌晨仍开放）</span>' : ''}</div>`;
  }).join('');
  el.innerHTML = `<div><span class="tag">开放时段</span>（时区 ${tz}）</div>` + rows;
}

function renderGuides(d) {
  const wrap = $('guide-buttons');
  wrap.innerHTML = '';
  const routes = (state.pkg && state.pkg.snapshot.routes) || (state.live && state.live.routes) || [];
  for (const r of routes) {
    const btn = document.createElement('button');
    btn.className = 'guide-btn';
    const route = state.pkg ? PavilionClient.routeInPackage(state.pkg, r.id) : null;
    btn.disabled = !d.guideEnabled;
    btn.innerHTML = `${r.name}<small>${r.id} · 版本 v${r.version}${route ? '' : '（与展区版本不匹配）'}</small>`;
    btn.onclick = () => enterGuide(r.id);
    wrap.appendChild(btn);
  }
  $('guide-note').textContent = d.guideEnabled ? '' : (d.guideReason || '导览暂不可用');
}

function render() {
  const d = PavilionClient.decide({
    nowLocal: localNow(), pkg: state.pkg, live: offline() ? null : state.live,
    sync: state.sync
  });
  $('welcome').textContent = d.welcomeText;
  const stateEl = $('state');
  stateEl.className = 'state ' + d.display;
  stateEl.textContent = d.display === 'open' ? '现在开放' : d.display === 'closed' ? '当前闭馆' : '状态待核实';
  $('state-note').textContent = d.note || '';
  if (d.from || d.until) {
    const tz = d.timezone;
    $('state-range').textContent = '本状态实际生效范围：' +
      (d.from ? PavilionTime.fmtDate(d.from, tz) + ' ' + PavilionTime.fmtHM(d.from, tz) : '…') +
      ' 至 ' +
      (d.until ? PavilionTime.fmtDate(d.until, tz) + ' ' + PavilionTime.fmtHM(d.until, tz) : '…') +
      `（${d.kind}）` + (d.dataAgeMs != null ? ` · 离线包龄 ${Math.round(d.dataAgeMs / 1000)}s / TTL ${Math.round(d.ttlMs / 1000)}s` : '') +
      (d.clockSkewMs ? ` · 时钟偏差 ${d.clockSkewMs}ms` : '');
  } else {
    $('state-range').textContent = '';
  }
  $('warnings').innerHTML = d.warnings.map((w) => `<div>⚠ ${w}</div>`).join('');

  const badge = $('src-badge');
  if (d.source === 'server-realtime') { badge.className = 'badge live'; badge.textContent = '服务端实时'; }
  else if (d.source.startsWith('offline-stale')) { badge.className = 'badge stale'; badge.textContent = '离线·待核实'; }
  else if (d.source.startsWith('offline')) { badge.className = 'badge offline'; badge.textContent = '离线包计算'; }
  else { badge.className = 'badge'; badge.textContent = d.source || ''; }

  renderBackground(state.pkg, state.live);
  renderHours(state.pkg);
  renderGuides(d);
}

function tick() {
  $('clock').textContent = new Date(localNow()).toLocaleString('zh-CN', { hour12: false });
  render();
}

$('btn-download').onclick = downloadPackage;
$('btn-refresh').onclick = refreshLive;
$('btn-send-late').onclick = sendLateReceipt;
['force-offline', 'clock-offset', 'bg-fail', 'device-id', 'group-id'].forEach((id) =>
  $(id).addEventListener('change', render));

(async function boot() {
  await downloadPackage();
  await refreshLive();
  setInterval(refreshLive, 15000);
  setInterval(tick, 1000);
  tick();
})();
