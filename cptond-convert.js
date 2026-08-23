'use strict';

// 把 CPTOND-2025 的北京 shapefile 转换成游戏用的 beijing-transit.json
// 用法：node cptond-convert.js
// 输入：data/cptond/{metro,bus}/shapefiles/Beijing/beijing_*_routes.shp + beijing_*_stops.shp
// 输出：data/beijing-transit.json
// 要点：
//   1) 线路↔站点靠 route_cn 精确匹配，全程用 Map 保证 O(N)（bus_stops 约 11 万条）
//   2) 坐标系 WGS-84 → GCJ-02（对齐高德底图）。OSM 后端在 amap-polyfill.js 渲染边界统一换算回 WGS-84，
//      所以全项目只维护这一份 GCJ-02 数据，路由/关卡/交互两端结果一致。
//   3) 同一线路的两个方向合并为一条（按 route_cn 去掉 "(起点--终点)" 后缀）
//   4) 路径抽稀到每线 ≤300 点，坐标取 6 位小数，控制输出体积

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseDbf, parseShp } = require('./lib/shp');

const OUT_FILE = path.join(__dirname, 'data', 'beijing-transit.json');
const PATH_MAX_POINTS = 300;

// ---------- WGS-84 → GCJ-02 ----------
const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI)) + (20.0 * Math.sin(2.0 * x * PI))) * 2.0 / 3.0;
  ret += ((20.0 * Math.sin(y * PI)) + (40.0 * Math.sin((y / 3.0) * PI))) * 2.0 / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI)) + (320.0 * Math.sin((y * PI) / 30.0))) * 2.0 / 3.0;
  return ret;
}
function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI)) + (20.0 * Math.sin(2.0 * x * PI))) * 2.0 / 3.0;
  ret += ((20.0 * Math.sin(x * PI)) + (40.0 * Math.sin((x / 3.0) * PI))) * 2.0 / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI)) + (300.0 * Math.sin((x / 30.0) * PI))) * 2.0 / 3.0;
  return ret;
}
function wgs2gcj(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
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
const gcj = (lng, lat) => {
  const [g, l] = wgs2gcj(lng, lat);
  return [Number(g.toFixed(6)), Number(l.toFixed(6))];
};

// ---------- 工具 ----------
function loadFeatures(base) {
  const shp = parseShp(base + '.shp');
  const dbf = parseDbf(base + '.dbf');
  return shp.features.map((f, i) => ({
    geom: f,
    attrs: dbf.records[i] ? dbf.records[i].attributes : {},
  }));
}
function guessMode(routeType, typeEn) {
  const s = (routeType || '') + ' ' + (typeEn || '');
  return /地铁|subway|metro/i.test(s) ? 'metro' : 'bus';
}
function decimate(points, max) {
  if (points.length <= max) return points;
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}
function hashId(base) {
  return 'L_' + crypto.createHash('md5').update(base).digest('hex').slice(0, 12);
}

// 两坐标点球面距离（km）
function haversine(lng1, lat1, lng2, lat2) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 读取 CPTOND segments（相邻站间真实距离，km），建立双向 lookup
function loadSegmentDistances() {
  const lookup = new Map();
  const bases = [
    'data/cptond/metro/shapefiles/Beijing/beijing_metro_segments',
    'data/cptond/bus/shapefiles/Beijing/beijing_bus_segments',
  ];
  for (const base of bases) {
    for (const f of loadFeatures(base)) {
      const s = String(f.attrs.s_stopid || '');
      const e = String(f.attrs.e_stopid || '');
      const d = Number(f.attrs.distance);
      if (!s || !e || !(d > 0)) continue;
      lookup.set(s + '|' + e, d);
      lookup.set(e + '|' + s, d);
    }
  }
  return lookup;
}

function main() {
  const t0 = Date.now();
  const segDist = loadSegmentDistances();

  const stopGroups = new Map(); // route_cn -> [{id,name,lng,lat,seq}]
  const routes = [];            // {cn, attrs, geom}
  let orphanStops = 0;          // stops whose route_cn 没有对应的 route（也算进 stopGroups）

  const pairs = [
    ['data/cptond/metro/shapefiles/Beijing/beijing_metro_routes', 'data/cptond/metro/shapefiles/Beijing/beijing_metro_stops'],
    ['data/cptond/bus/shapefiles/Beijing/beijing_bus_routes', 'data/cptond/bus/shapefiles/Beijing/beijing_bus_stops'],
  ];

  for (const [rbase, sbase] of pairs) {
    // 先读站点（它们带 route_cn）
    const stopFeats = loadFeatures(sbase);
    for (const f of stopFeats) {
      const cn = String(f.attrs.route_cn || '').trim();
      if (!cn) continue;
      if (!stopGroups.has(cn)) stopGroups.set(cn, []);
      stopGroups.get(cn).push({
        id: String(f.attrs.stop_id || ''),
        name: String(f.attrs.name_cn || ''),
        lng: Number(f.geom.coords[0]),
        lat: Number(f.geom.coords[1]),
        seq: Number(f.attrs.sequence || 0),
      });
    }

    // 再读线路（带几何 + 属性）
    const routeFeats = loadFeatures(rbase);
    for (const f of routeFeats) {
      const cn = String(f.attrs.route_cn || '').trim();
      if (!cn) continue;
      routes.push({ cn, attrs: f.attrs, geom: f.geom });
    }
  }

  const routeByCn = new Map();
  for (const r of routes) if (!routeByCn.has(r.cn)) routeByCn.set(r.cn, r);

  // 全量 route_cn（线路 ∪ 站点），并按 base name（去掉 "(...)" 方向后缀）分组
  const allCn = new Set([...routeByCn.keys(), ...stopGroups.keys()]);
  const baseGroups = new Map();
  for (const cn of allCn) {
    const base = cn.split('(')[0].trim();
    if (!base) continue;
    if (!baseGroups.has(base)) baseGroups.set(base, []);
    baseGroups.get(base).push(cn);
  }

  // 构建合并后的线路
  const lines = [];
  let orphanRoutes = 0;
  for (const [base, cns] of baseGroups) {
    // 选最优方向：优先有几何的、站点多的
    let best = null;
    let bestScore = -Infinity;
    for (const cn of cns) {
      const route = routeByCn.get(cn);
      const stops = stopGroups.get(cn) || [];
      const nPts = route && route.geom && route.geom.points ? route.geom.points.length : 0;
      const score = (route ? 1e9 : 0) + stops.length * 1000 + nPts;
      if (score > bestScore) { bestScore = score; best = { cn, route, stops }; }
    }
    if (!best) continue;

    if (best.route && best.stops.length === 0) orphanRoutes++;

    // 排序 + 去重（同一站点可能因换向/区间重复）
    const sorted = best.stops.slice().sort((a, b) => a.seq - b.seq);
    const seen = new Set();
    const stops = [];
    for (const s of sorted) {
      if (!s.id || seen.has(s.id)) continue;
      seen.add(s.id);
      stops.push(s);
    }
    // 数据修正：14号线「高家园」站尚未开通，剔除（后续段距自动按 将台→望京南 重算）
    if (base === '地铁14号线') {
      const g = stops.findIndex((s) => (s.name || '').includes('高家园'));
      if (g >= 0) stops.splice(g, 1);
    }
    // 逐站距离（优先 CPTOND segments 真实值，缺失用 haversine 兜底）
    for (let i = 0; i < stops.length; i++) {
      let d = null;
      if (i < stops.length - 1) {
        const key = stops[i].id + '|' + stops[i + 1].id;
        d = segDist.get(key);
        if (d == null) d = haversine(stops[i].lng, stops[i].lat, stops[i + 1].lng, stops[i + 1].lat);
      }
      stops[i].d = d == null ? null : Number(d.toFixed(3));
    }

    const attrs = best.route ? best.route.attrs : {};
    const mode = guessMode(attrs.route_type, attrs.type_en);

    let path;
    if (best.route && best.route.geom && best.route.geom.points) {
      path = decimate(best.route.geom.points, PATH_MAX_POINTS).map((p) => gcj(p[0], p[1]));
    } else {
      path = stops.map((s) => gcj(s.lng, s.lat));
    }

    lines.push({
      id: hashId(base),
      name: base,
      mode,
      front: String(attrs.s_stop_cn || (stops[0] ? stops[0].name : '')),
      terminal: String(attrs.e_stop_cn || (stops.length ? stops[stops.length - 1].name : '')),
      start_time: String(attrs.start_time || ''),
      end_time: String(attrs.end_time || ''),
      stops: stops.map((s) => {
        const [lng, lat] = gcj(s.lng, s.lat);
        // CPTOND 里"临时站"等占位站会在不同位置复用同一 stop_id（如 BV09413140
        // 同时出现在大兴与平谷），按 id 去重会把它们当成同一站造成"虚空换乘"。
        // 这里把 id 改成"原始id+坐标"，保证物理站在 (id,坐标) 上唯一。
        const sid = s.id ? String(s.id) + '@' + lng.toFixed(5) + ',' + lat.toFixed(5) : null;
        return { id: sid, name: s.name, lng, lat, seq: s.seq, d: s.d };
      }),
      path,
    });
  }

  const metroCount = lines.filter((l) => l.mode === 'metro').length;
  const busCount = lines.filter((l) => l.mode === 'bus').length;
  const stopEntries = lines.reduce((n, l) => n + l.stops.length, 0);

  const out = {
    city: '北京',
    source: 'CPTOND-2025 (WGS-84 → GCJ-02)',
    generated_at: new Date().toISOString(),
    count: lines.length,
    lines,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));

  const sizeMB = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1);
  const summary = {
    total_lines: lines.length,
    metro_lines: metroCount,
    bus_lines: busCount,
    total_stop_entries: stopEntries,
    orphan_stops: orphanStops,
    orphan_routes: orphanRoutes,
    output: OUT_FILE,
    output_mb: sizeMB,
    elapsed_ms: Date.now() - t0,
  };
  fs.writeFileSync(path.join(__dirname, 'data', 'cptond', 'convert-summary.txt'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main();
