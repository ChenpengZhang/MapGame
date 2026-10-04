// 生成“禁止步行过江”用的江河中心线：data/rivers/<city>.json（GCJ-02）
// 数据来自 OpenStreetMap（waterway=river 的中心线，按名字筛选主要江河），经 Overpass API 下载。
// 用法：
//   node scripts/build-rivers.mjs                 # 下载并生成全部已配置城市
//   node scripts/build-rivers.mjs wuhan           # 只生成武汉
//   node scripts/build-rivers.mjs wuhan --raw a.json [--raw b.json]   # 用已下载的 Overpass 响应（out geom）生成
// Overpass 主站经常超时（504），脚本按区域分块并重试；可用环境变量 OVERPASS_URL 指定镜像。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// 需要禁止步行过江的城市与江河名（OSM 中汉江的名字是“汉水”）
const CITY_RIVERS = {
  wuhan: ['长江', '汉水', '汉江'],
  chongqing: ['长江', '嘉陵江'],
};

const OVERPASS = process.env.OVERPASS_URL || 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';
const ROOT = new URL('../', import.meta.url);

// ---- WGS-84 → GCJ-02（与 frontend/js/amap-polyfill.js 相同） ----
const A = 6378245.0, EE = 0.00669342162296594323, PI = Math.PI;
function transformLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * PI)) + (20.0 * Math.sin(2.0 * x * PI))) * 2.0 / 3.0;
  r += ((20.0 * Math.sin(y * PI)) + (40.0 * Math.sin((y / 3.0) * PI))) * 2.0 / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * PI)) + (320.0 * Math.sin((y * PI) / 30.0))) * 2.0 / 3.0;
  return r;
}
function transformLng(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * PI)) + (20.0 * Math.sin(2.0 * x * PI))) * 2.0 / 3.0;
  r += ((20.0 * Math.sin(x * PI)) + (40.0 * Math.sin((x / 3.0) * PI))) * 2.0 / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * PI)) + (300.0 * Math.sin((x / 30.0) * PI))) * 2.0 / 3.0;
  return r;
}
function wgs2gcj(lng, lat) {
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

/** 城市交通数据的包围盒（只要覆盖了站点的范围），[south, west, north, east] */
function cityBox(city) {
  const data = JSON.parse(readFileSync(new URL(`data/${city}-transit.json`, ROOT)));
  const box = [90, 180, -90, -180];
  for (const line of data.lines) {
    for (const s of line.stops) {
      box[0] = Math.min(box[0], s.lat); box[1] = Math.min(box[1], s.lng);
      box[2] = Math.max(box[2], s.lat); box[3] = Math.max(box[3], s.lng);
    }
  }
  return box;
}

/**
 * 只保留离本市站点 KEEP_M 以内的江段：步行上限 1.5km，更远的江永远不会被判定用到。
 * 长江横贯整个重庆市域、武汉也只经过一段——不裁剪的话会带上大量用不到的上下游。
 * 一段江离开范围时多留一个点，保证跨越边界的那一小段仍是连续的。
 */
const KEEP_M = 3000;
function stopGrid(city) {
  const data = JSON.parse(readFileSync(new URL(`data/${city}-transit.json`, ROOT)));
  const cell = 0.03; // 约 3km
  const grid = new Set();
  for (const line of data.lines) for (const st of line.stops) grid.add(Math.floor(st.lng / cell) + ':' + Math.floor(st.lat / cell));
  return (p) => {
    const x = Math.floor(p[0] / cell), y = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (grid.has((x + dx) + ':' + (y + dy))) return true;
    return false;
  };
}
function clipToStops(line, near) {
  const runs = [];
  let run = null;
  line.forEach((p, i) => {
    const keep = near(p) || (i > 0 && near(line[i - 1])) || (i + 1 < line.length && near(line[i + 1]));
    if (keep) { if (!run) runs.push(run = []); run.push(p); } else run = null;
  });
  return runs.filter((r) => r.length >= 2);
}

/** 把包围盒切成 n×n 块，减少单次 Overpass 查询的体量 */
function tiles([s, w, n, e], parts) {
  const out = [];
  for (let i = 0; i < parts; i++) {
    for (let j = 0; j < parts; j++) {
      out.push([s + (n - s) * i / parts, w + (e - w) * j / parts, s + (n - s) * (i + 1) / parts, w + (e - w) * (j + 1) / parts]);
    }
  }
  return out;
}

async function overpass(names, box) {
  const query = `[out:json][timeout:250];(way["waterway"="river"]["name"~"^(${names.join('|')})$"](${box.map((v) => v.toFixed(4)).join(',')}););out geom;`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'TransitGuesser river layer build' },
      body: 'data=' + encodeURIComponent(query),
    }).catch((e) => ({ ok: false, status: e.message }));
    if (res.ok) {
      const text = await res.text();
      if (text.startsWith('{')) return JSON.parse(text).elements;
    }
    console.warn(`  Overpass ${res.status}，${attempt * 15} 秒后重试…`);
    await new Promise((r) => setTimeout(r, attempt * 15000));
  }
  throw new Error('Overpass 多次失败，可稍后重试或换 OVERPASS_URL 镜像');
}

function round5(v) { return Math.round(v * 1e5) / 1e5; }

async function build(city, rawFiles) {
  const names = CITY_RIVERS[city];
  if (!names) throw new Error(`未配置城市：${city}`);
  let elements = [];
  if (rawFiles.length) {
    for (const f of rawFiles) elements.push(...JSON.parse(readFileSync(f)).elements);
  } else {
    for (const box of tiles(cityBox(city), city === 'chongqing' ? 3 : 1)) {
      console.log(`  ${city} 下载区块 ${box.map((v) => v.toFixed(2)).join(',')}`);
      elements.push(...await overpass(names, box));
    }
  }
  const ways = new Map();
  for (const el of elements) if (el.type === 'way' && el.geometry && names.includes(el.tags?.name)) ways.set(el.id, el);
  const near = stopGrid(city);
  const byName = new Map();
  for (const way of ways.values()) {
    const name = way.tags.name === '汉水' ? '汉江' : way.tags.name;
    if (!byName.has(name)) byName.set(name, []);
    const line = way.geometry.map((p) => wgs2gcj(p.lon, p.lat).map(round5));
    byName.get(name).push(...clipToStops(line, near));
  }
  const rivers = [...byName].filter(([, lines]) => lines.length).map(([name, lines]) => ({ name, lines }));
  const out = {
    city,
    source: 'OpenStreetMap contributors (ODbL), waterway=river centerlines via Overpass API',
    generated_at: new Date().toISOString(),
    rivers,
  };
  mkdirSync(new URL('data/rivers/', ROOT), { recursive: true });
  writeFileSync(new URL(`data/rivers/${city}.json`, ROOT), JSON.stringify(out));
  console.log(`${city}: ${rivers.map((r) => `${r.name} ${r.lines.length} 段 ${r.lines.reduce((n, l) => n + l.length, 0)} 点`).join('，')}`);
}

const args = process.argv.slice(2);
const raw = [];
const cities = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--raw') raw.push(args[++i]);
  else cities.push(args[i]);
}
for (const city of cities.length ? cities : Object.keys(CITY_RIVERS)) await build(city, raw);
