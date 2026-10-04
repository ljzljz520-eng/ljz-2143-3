'use strict';
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem('pavilion-token') || 'admin-token';
$('token').value = token;
function authState(txt, ok) { $('auth-state').textContent = txt; $('auth-state').style.color = ok ? '#8ff0b8' : '#ff9c8f'; }
authState(token ? '已保存' : '未设置', !!token);
function saveToken() { token = $('token').value.trim(); localStorage.setItem('pavilion-token', token); authState('已保存', true); }

async function api(method, url, body, extraHeaders) {
  const res = await fetch(url, {
    method,
    headers: Object.assign({ 'x-admin-key': token, 'x-actor': 'admin-web', 'content-type': 'application/json' }, extraHeaders || {}),
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw Object.assign(new Error((data && data.error) || res.status), { status: res.status, data });
  return data;
}
const get = (u) => api('GET', u);
const post = (u, b) => api('POST', u, b);
const put = (u, b, h) => api('PUT', u, b, h);
const del = (u, b) => api('DELETE', u, b);

document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $('tab-' + b.dataset.tab).classList.add('active');
  refresh();
});

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtUtc = (ms) => ms == null ? '' : new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
function localInputToMs(value) {
  if (!value) return null;
  return new Date(value.length === 16 ? value + ':00' : value).getTime();
}
function msToLocalInput(ms) {
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pill(cls, txt) { return `<span class="pill ${cls}">${esc(txt)}</span>`; }

async function loadEffective() {
  const at = localInputToMs($('obs-at').value);
  const d = await post('/api/schedule/effective', { at_ms: at });
  const c = d.current;
  $('current-status').innerHTML = `
    <div>${pill(c.state, c.state === 'open' ? '开放' : c.state === 'closed' ? '闭馆' : '待核实')}
      <b>${esc(c.note)}</b> <span class="muted">[${esc(c.kind)}]</span></div>
    <div class="muted" style="margin-top:6px">实际生效范围（绝对时间，按 ${esc(d.timezone)} 显示）：<br>
      ${PavilionTime.fmtDate(c.from, d.timezone)} ${PavilionTime.fmtHM(c.from, d.timezone)}
      ～ ${PavilionTime.fmtDate(c.until, d.timezone)} ${PavilionTime.fmtHM(c.until, d.timezone)}
      ${c.clampedFrom ? '（向前到达计算窗口边界）' : ''}${c.clampedUntil ? '（向后到达计算窗口边界）' : ''}</div>`;
  $('temp-effective').innerHTML = d.events.length ? d.events.map((e) => `
    <div class="card ${e.effective ? 'win' : 'lose'}">
      <b>${esc(e.name)}</b> ${pill(e.state, e.state === 'open' ? '临时开放' : '临时闭馆')}
      名义区间：${fmtUtc(e.nominal.start)} ～ ${fmtUtc(e.nominal.end)}<br>
      ${e.effective
        ? `实际生效：${fmtUtc(e.effective.start)} ～ ${fmtUtc(e.effective.end)}（被更高优先级/更晚事件压缩的部分不会显示为生效）`
        : `<span class="muted">${esc(e.effective_note)}</span>`}
    </div>`).join('') : '<p class="muted">暂无临时事件。</p>';
}
function setNow() { $('obs-at').value = msToLocalInput(Date.now()); loadEffective(); }

async function loadAreas() {
  const rows = await get('/api/areas');
  $('areas-body').innerHTML = rows.map((a) => `<tr>
    <td>${esc(a.id)}</td><td>${esc(a.name)}</td><td>${esc(a.floor)}</td><td>${esc(a.description)}</td>
    <td>v${a.version}</td><td>${a.published_version ? 'v' + a.published_version : '<span class="muted">未发布</span>'}</td>
    <td><button class="plain" onclick="editArea('${a.id}')">改名+1</button>
        <button class="plain" onclick="releaseArea('${a.id}')">转为可用</button></td></tr>`).join('');
}
async function createArea() {
  await post('/api/areas', { id: $('a-id').value, name: $('a-name').value, floor: $('a-floor').value,
    description: $('a-desc').value, reason: $('a-reason').value });
  loadAreas();
}
async function editArea(id) {
  const name = prompt('新名称（版本将 +1）：');
  if (name == null) return;
  await put('/api/areas/' + encodeURIComponent(id), { name, reason: '管理端改名' });
  loadAreas();
}
async function releaseArea(id) {
  await post(`/api/areas/${encodeURIComponent(id)}/release`, { reason: '管理端确认可用' });
  loadAreas();
}

async function loadRoutes() {
  const rows = await get('/api/routes');
  $('routes-body').innerHTML = rows.map((r) => `<tr>
    <td>${esc(r.id)}</td><td>${esc(r.name)}</td><td>${esc(r.area_ids.join(','))}</td><td>v${r.version}</td>
    <td><button class="plain" onclick="editRoute('${r.id}', ${r.version})">编辑+1</button></td></tr>`).join('');
}
async function createRoute() {
  await post('/api/routes', { id: $('r-id').value, name: $('r-name').value,
    area_ids: $('r-areas').value.split(',').map((s) => s.trim()).filter(Boolean), reason: $('r-reason').value });
  loadRoutes();
}
async function editRoute(id) {
  const name = prompt('新名称：');
  const areas = prompt('展区 ID（逗号分隔）：');
  if (areas == null || name == null) return;
  await put('/api/routes/' + encodeURIComponent(id), { name, area_ids: areas.split(',').map((s) => s.trim()).filter(Boolean) });
  loadRoutes();
}

async function loadWeekly() {
  const rows = await get('/api/schedule/weekly');
  $('weekly-body').innerHTML = rows.map((r) => `<tr>
    <td>${r.weekdays.join(',')}</td><td>${esc(r.open)}</td><td>${esc(r.close)}${PavilionTime.closeOnNextDay(r.open, r.close) ? ' ⏰跨午夜' : ''}</td>
    <td>${esc(r.name)}</td><td><button class="plain" onclick="delWeekly(${r.id})">删除</button></td></tr>`).join('');
}
async function createWeekly() {
  await post('/api/schedule/weekly', { weekdays: $('w-days').value.split(',').map(Number),
    open: $('w-open').value, close: $('w-close').value, name: $('w-name').value });
  loadWeekly();
}
async function delWeekly(id) { await del('/api/schedule/weekly/' + id); loadWeekly(); }

async function loadHolidays() {
  const rows = await get('/api/schedule/holidays');
  $('holidays-body').innerHTML = rows.map((h) => `<tr>
    <td>${esc(h.name)}</td><td>${esc(h.start_date)}</td><td>${esc(h.end_date)}</td>
    <td>${pill(h.state, h.state === 'open' ? '开放' : '闭馆')}</td>
    <td><button class="plain" onclick="delHoliday(${h.id})">删除</button></td></tr>`).join('');
}
async function createHoliday() {
  await post('/api/schedule/holidays', { name: $('h-name').value, start_date: $('h-start').value,
    end_date: $('h-end').value, state: $('h-state').value });
  loadHolidays();
}
async function delHoliday(id) { await del('/api/schedule/holidays/' + id); loadHolidays(); }

let tempCache = [];
async function loadTemp() {
  tempCache = await get('/api/schedule/temporary');
  $('temp-body').innerHTML = tempCache.map((e) => `<tr>
    <td>${e.id}</td><td>${esc(e.name)}</td><td>${fmtUtc(e.start_ms)}</td><td>${fmtUtc(e.end_ms)}</td>
    <td>${pill(e.state, e.state === 'open' ? '开放' : '闭馆')}</td><td>${esc(e.reason)}</td><td>v${e.row_version}</td>
    <td><button class="plain" onclick="openTempEditor(${e.id})">编辑</button>
        <button class="plain" onclick="delTemp(${e.id})">取消</button></td></tr>`).join('');
  renderConflictLab();
}
async function createTemp() {
  await post('/api/schedule/temporary', { name: $('te-name').value, start_ms: localInputToMs($('te-start').value),
    end_ms: localInputToMs($('te-end').value), state: $('te-state').value, reason: $('te-reason').value });
  loadTemp();
}
async function delTemp(id) {
  await del('/api/schedule/temporary/' + id, { reason: '管理端取消临时事件' });
  loadTemp();
}
// 两人同时改：两个会话各持一份 row_version
const tempEditors = {};
function openTempEditor(id) {
  const ev = tempCache.find((x) => x.id === id);
  if (!ev) return;
  const who = Object.keys(tempEditors).filter((k) => tempEditors[k].id === id).length ? 'B' : 'A';
  tempEditors[who + id] = { id, row_version: ev.row_version, snapshot: ev };
  renderConflictLab();
}
async function saveTempEditor(key, who) {
  const ed = tempEditors[key];
  const name = $(`te-${key}-name`).value;
  const reason = $(`te-${key}-reason`).value;
  try {
    const updated = await put('/api/schedule/temporary/' + ed.id,
      { name, reason, start_ms: localInputToMs($(`te-${key}-start`).value),
        end_ms: localInputToMs($(`te-${key}-end`).value), state: $(`te-${key}-state`).value,
        row_version: ed.row_version }, { 'if-match': ed.row_version });
    ed.row_version = updated.row_version; ed.snapshot = updated;
    $(`te-${key}-result`).innerHTML = `✅ ${who} 保存成功，新版本 v${updated.row_version}`;
  } catch (e) {
    if (e.status === 402) {
      ed.row_version = e.data.current.row_version; ed.snapshot = e.data.current;
      $(`te-${key}-result`).innerHTML = `⛔ ${who} 被拒绝（乐观锁冲突）：库中已是 v${e.data.current.row_version}
        “${esc(e.data.current.name)}”。${who} 必须刷新后基于新版本再改。`;
      $(`te-${key}-result`).className = 'conflict';
    } else $(`te-${key}-result`).textContent = '错误：' + e.message;
  }
  loadTemp();
}
function renderConflictLab() {
  const keys = Object.keys(tempEditors);
  $('conflict-lab').innerHTML = keys.map((key) => {
    const ed = tempEditors[key];
    const who = key.startsWith('A') ? '编辑者 A' : '编辑者 B';
    return `<div class="card ${who.includes('B') ? 'conflict' : ''}" style="margin-bottom:8px">
      <b>${who}</b>（打开时持有 v${ed.row_version}，事件 #${ed.id}）
      <div class="row">
        <label>名称<input id="te-${key}-name" value="${esc(ed.snapshot.name)}"></label>
        <label>开始<input id="te-${key}-start" type="datetime-local" step="1" value="${msToLocalInput(ed.snapshot.start_ms)}"></label>
        <label>结束<input id="te-${key}-end" type="datetime-local" step="1" value="${msToLocalInput(ed.snapshot.end_ms)}"></label>
        <label>状态<select id="te-${key}-state"><option value="closed" ${ed.snapshot.state === 'closed' ? 'selected' : ''}>闭馆</option><option value="open" ${ed.snapshot.state === 'open' ? 'selected' : ''}>开放</option></select></label>
        <label>原因<input id="te-${key}-reason" value="${esc(ed.snapshot.reason || '')}"></label>
        <button onclick="saveTempEditor('${key}','${who}')">以 v${ed.row_version} 提交</button>
      </div>
      <div id="te-${key}-result" class="muted"></div></div>`;
  }).join('') || '<p class="muted">在上方对同一条临时事件点两次“编辑”，即模拟 A、B 两人同时打开。</p>';
}

async function loadPublications() {
  const rows = await get('/api/publications');
  $('pub-body').innerHTML = rows.map((p) => `<tr>
    <td>v${p.version}</td><td>${pill(p.status, p.status === 'released' ? '已发布' : '已撤销')}</td>
    <td>${esc(p.note)}</td><td>${esc(p.revoke_reason || '')}</td>
    <td>${esc(p.created_by)}<br><span class="muted">${fmtUtc(p.created_at)}</span></td>
    <td>${p.status === 'released'
      ? `<button class="warn" onclick="revokePub(${p.version})">撤销（需填原因）</button>
         <a href="/api/publications/${p.version}" target="_blank"><button class="plain">快照</button></a>`
      : `<span class="muted">${p.revoked_at ? fmtUtc(p.revoked_at) : ''}</span>`}</td></tr>`).join('');
}
async function publishNow() {
  const d = await post('/api/publications', { note: $('pub-note').value || '管理端发布' });
  alert('已发布 v' + d.version);
  refresh();
}
async function revokePub(v) {
  const reason = prompt(`撤销 v${v} 的原因（会写入审计与版本记录，终端收到后停用该版本导览）：`);
  if (!reason) return;
  await post(`/api/publications/${v}/revoke`, { reason });
  refresh();
}
async function uploadBg(simFail) {
  if (simFail) {
    await post('/api/files/background', { status: 'failed', contentType: 'image/jpeg', reason: '供应商文件投递失败' });
    alert('已登记背景失败，发布后终端将回退背景但保留欢迎文字');
  } else {
    const f = $('bg-file').files[0];
    if (!f) return alert('先选择文件');
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f);
    });
    await post('/api/files/background', { content: dataUrl, contentType: f.type });
    alert('背景已上传，需发布新版本才进入终端快照');
  }
}

async function loadGroupsDevices() {
  const groups = await get('/api/groups');
  $('groups-body').innerHTML = groups.map((g) => `<tr>
    <td>${esc(g.id)}</td><td>${esc(g.name)}</td>
    <td>${g.published_version != null ? 'v' + g.published_version : '<span class="muted">无可用版本</span>'}</td>
    <td>${g.ttl_ms}</td>
    <td><button class="plain" onclick="editGroup('${g.id}',${g.ttl_ms})">改 TTL</button></td></tr>`).join('');
  const devices = await get('/api/devices');
  $('devices-body').innerHTML = devices.map((d) => `<tr>
    <td>${esc(d.id)}</td><td>${esc(d.name)}</td><td>${esc(d.group_id || '—')}</td>
    <td>${d.last_seen_ms ? new Date(d.last_seen_ms).toLocaleString() : '从未'}</td>
    <td>${d.package_version != null ? 'v' + d.package_version : '—'}</td>
    <td>${d.package_received_at ? new Date(d.package_received_at).toLocaleString() : '—'}</td></tr>`).join('');
}
async function editGroup(id, ttl) {
  const v = prompt('新的 TTL（毫秒，超过后终端状态待核实）：', ttl);
  if (v == null) return;
  await put('/api/groups/' + encodeURIComponent(id), { ttl_ms: Number(v), reason: '调整新鲜度期限' });
  loadGroupsDevices();
}

async function loadAudit() {
  const rows = await get('/api/audit?limit=200');
  $('audit-body').innerHTML = rows.map((r) => `<div class="card">
    <b>${esc(r.action)}</b> · ${esc(r.entity || '')} ${esc(r.entity_id || '')} · ${esc(r.actor)}
    <span class="muted">${fmtUtc(r.at)}</span>
    ${r.reason ? `<br>原因：${esc(r.reason)}` : ''}
    ${r.detail_json ? `<pre class="detail">${esc(r.detail_json)}</pre>` : ''}
  </div>`).join('') || '<p class="muted">暂无</p>';
}

async function loadSettings() {
  const s = await get('/api/settings');
  $('s-tz').value = s.timezone; $('s-welcome').value = s.welcome_text;
  $('s-stale').value = s.stale_text; $('s-skew').value = s.max_clock_skew_ms;
}
async function saveSettings() {
  await put('/api/settings', { timezone: $('s-tz').value, welcome_text: $('s-welcome').value,
    stale_text: $('s-stale').value, max_clock_skew_ms: Number($('s-skew').value) });
  alert('已保存');
}

function refresh() {
  loadEffective().catch(() => {});
  loadAreas().catch((e) => authState('请求失败：' + e.message, false));
  loadRoutes().catch(() => {});
  loadWeekly().catch(() => {});
  loadHolidays().catch(() => {});
  loadTemp().catch(() => {});
  loadPublications().catch(() => {});
  loadGroupsDevices().catch(() => {});
  loadAudit().catch(() => {});
  loadSettings().catch(() => {});
}
setNow();
refresh();
setInterval(() => { loadAudit().catch(() => {}); loadEffective().catch(() => {}); }, 15000);
