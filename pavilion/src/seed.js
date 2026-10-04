'use strict';
/* 初始化演示数据（仅在空库时执行）。 */
const { db, now, getSetting, setSetting, publish, audit } = require('./db');
const T = require('../lib/time');

function seed() {
  const count = db.prepare('SELECT COUNT(*) c FROM settings').get().c
    + db.prepare('SELECT COUNT(*) c FROM areas').get().c;
  if (count > 0) return false;
  const t = now();
  setSetting('timezone', 'Asia/Shanghai');
  setSetting('welcome_text', '欢迎莅临城市展馆 · 祝您参观愉快');
  setSetting('stale_text', '状态待核实，请以现场公告或工作人员指引为准');
  setSetting('max_clock_skew_ms', 300000); // 允许离线时钟漂移 5 分钟

  // 背景文件：ready，内嵌一个小型 SVG data URL
  const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="800" height="480"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b3d66"/><stop offset="1" stop-color="#127a8c"/></linearGradient></defs><rect width="800" height="480" fill="url(#g)"/><text x="400" y="240" font-size="44" fill="#dff3ff" text-anchor="middle" font-family="sans-serif">城市展馆</text></svg>`;
  db.prepare(`INSERT INTO files(id,kind,content,content_type,status,etag,updated_at)
    VALUES('bg-default','background',?,?, 'ready',1,?)`)
    .run('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), 'image/svg+xml', t);

  // 展区（编辑层 version=1，发布后 published_version=1）
  const areas = [
    ['a-history', '城市历史厅', '从建城到近代的城市变迁', '1F', 10],
    ['a-science', '科技创新厅', '交互展项与前沿科技', '2F', 20],
    ['a-art', '当代艺术馆', '临展：光影之间', '3F', 30]
  ];
  const insArea = db.prepare(`INSERT INTO areas(id,name,description,floor,position,active,version,published_version,updated_at)
    VALUES(?,?,?,?,?,1,1,1,?)`);
  for (const a of areas) insArea.run(...a, t);

  const insRoute = db.prepare(`INSERT INTO routes(id,name,area_ids_json,version,active,updated_at) VALUES(?,?,?,1,1,?)`);
  insRoute.run('r-classic', '经典两小时', JSON.stringify(['a-history', 'a-science']), t);
  insRoute.run('r-full', '全馆通览', JSON.stringify(['a-history', 'a-science', 'a-art']), t);

  // 常规周历：周二至周日 09:00–17:00；周五夜场 18:00–22:00（不跨午夜）。
  // 另设周六夜场 19:00–02:00 —— 跨午夜开放，周日凌晨仍应判为开放。
  const insW = db.prepare(`INSERT INTO weekly_rules(weekdays_json,open,close,state,name,active,position,updated_at)
    VALUES(?,?,?, 'open',?,1,?,?)`);
  insW.run(JSON.stringify([2, 3, 4, 5, 6, 0]), '09:00', '17:00', '常规开放时段', 10, t);
  insW.run(JSON.stringify([6]), '19:00', '02:00', '周六夜场（至次日凌晨）', 20, t);

  // 节假日：以“今天”所在年份的 10-01..10-03 为例（固定日期，覆盖常规周历）
  const year = T.localParts(Date.now(), 'Asia/Shanghai').y;
  db.prepare(`INSERT INTO holidays(name,start_date,end_date,state,active,position,updated_at)
    VALUES(?,?,?, 'closed',1,10,?)`).run('国庆假期闭馆', `${year}-10-01`, `${year}-10-03`, t);

  // 设备分组：默认 TTL 12 小时；验收演示用分组 TTL 30 秒
  const insG = db.prepare(`INSERT INTO device_groups(id,name,published_version,ttl_ms,updated_at) VALUES(?,?,1,?,?)`);
  insG.run('g-lobby', '大厅导览屏组', 12 * 3600 * 1000, t);
  insG.run('g-demo', '验收演示组（短新鲜度 30s）', 30 * 1000, t);

  db.prepare(`INSERT INTO devices(id,name,group_id,created_at) VALUES(?,?,?,?)`)
    .run('d-001', '正门大屏', 'g-lobby', t);
  db.prepare(`INSERT INTO devices(id,name,group_id,created_at) VALUES(?,?,?,?)`)
    .run('d-demo', '演示终端', 'g-demo', t);

  publish('system', '初始发布：三展区与两条导览路线');
  audit('seed', 'system', null, 'system', '初始化演示数据', {});
  return true;
}

if (require.main === module) {
  console.log(seed() ? 'seeded' : 'already initialized');
}
module.exports = { seed };
