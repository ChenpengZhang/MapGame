'use strict';

// 把 CPTOND-2025 的某城市 shapefile 转换成游戏用的 <城市>-transit.json
// 用法：
//   node cptond-convert.js                 # 默认转换北京
//   node cptond-convert.js guangzhou       # 转换广州
//   node cptond-convert.js shenzhen shanghai  # 批量转换多城
// 输入：data/cptond/{metro,bus}/shapefiles/<City>/<city>_*_routes.shp + <city>_*_stops.shp
// 输出：data/<city>-transit.json
// 要点：
//   1) 线路↔站点靠 route_cn 精确匹配，全程用 Map 保证 O(N)（bus_stops 可达 11 万+ 条）
//   2) 坐标系 WGS-84 → GCJ-02（对齐高德底图）。OSM 后端在 amap-polyfill.js 渲染边界统一换算回 WGS-84，
//      所以全项目只维护这一份 GCJ-02 数据，路由/关卡/交互两端结果一致。
//   3) 同一线路的两个方向合并为一条（按 route_cn 去掉 "(起点--终点)" 后缀）
//   4) 路径抽稀到每线 ≤300 点，坐标取 6 位小数，控制输出体积
//   5) 幽灵站修正按城市配置（GHOST_STOPS），新城市上线前人工核对后补上

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseDbf, parseShp } = require('./lib/shp');

const PATH_MAX_POINTS = 300;

// ---------- 城市配置（加新城市只需在此表加一行 + 下载源数据） ----------
// dir：data/cptond/{metro,bus}/shapefiles/ 下的目录名；prefix = dir 小写，用于文件名。
const CITIES = {
  beijing:   { dir: 'Beijing',   zh: '北京' },
  guangzhou: { dir: 'Guangzhou', zh: '广州' },
  shenzhen:  { dir: 'Shenzhen',  zh: '深圳' },
  shanghai:  { dir: 'Shanghai',  zh: '上海' },
};

// ---------- 幽灵站修正（坑2：未开通/预留站仍出现在数据里，需按线路+站名剔除） ----------
// 剔除后前一个站的 d 会自动按「前一站 → 下一站」重算。新城市上线前人工核对后补进这里。
const GHOST_STOPS = {
  beijing: { '地铁14号线': ['高家园'] },
  guangzhou: {},
  shenzhen: {},
  shanghai: {},
};

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

// 同名线路的分支 key：用「站点集合」区分不同支段（比只比端点更稳）。
// 同一物理线路的两个方向，站点集合完全一致 → 合并为一条；
// 分叉的两个支段（如广州3号线主线 vs 北延段）站点集合不同 → 拆成两条。
// 坑：只比端点会误拆——北京「首都机场线」两个方向的端点一个写 3号航楼、一个写 2号航楼，
// 但站点集合完全相同（北新桥/东直门/三元桥/3号航楼/2号航楼），其实是一条线。
function stationSetKey(stops) {
  const ids = new Set();
  for (const s of stops) {
    ids.add(s.id ? 'I:' + String(s.id) : 'N:' + String(s.name || '').trim());
  }
  return [...ids].sort().join(',');
}

// 短交路/快车等服务变体：它们不是独立线路或支线，只是同一物理线路上的运营模式
// （如「地铁10号线(夜班)」「地铁2号线(8号线)晨曦特快」「地铁16号线大站车」），
// 若当成分支处理会把一条线误拆成多条。分支检测前先把这些 route_cn 排除。
function isServiceVariant(cn) {
  return /夜班|大站车|快车|特快|晨曦|区间|直达|高峰/.test(cn);
}

// 两个站是否同一个物理站：优先按 stop_id（CPTOND 在汇合站复用同一 id），
// 无 id 时按「同名 + 坐标接近」兜底，避免同名不同站误判。
function sameStation(a, b) {
  if (a.id && b.id && String(a.id) === String(b.id)) return true;
  if (String(a.name || '').trim() === String(b.name || '').trim()) {
    return haversine(a.lng, a.lat, b.lng, b.lat) < 0.5; // 500m 内视为同一站
  }
  return false;
}

// 在路径点序列里找离某站最近的下标（用于几何拼接的切断点）
function nearestPathIndex(points, stop) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = (points[i][0] - stop.lng) ** 2 + (points[i][1] - stop.lat) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// 分叉贯通（坑4）：把「被截断的支段」沿主干延伸到主干另一端终点。
// 例：广州3号线北延段在数据里只到「体育西路」，但实际列车会继续开到「海傍」，
// 乘客在体育西路无需换乘，故应拼成 机场北 → 体育西路 → 海傍 的完整服务。
// 判定：支段某一端是「另一支段的内部站」（非端点），即该支段在此被截断。
function spliceBranches(resolved) {
  for (let i = 0; i < resolved.length; i++) {
    const cur = resolved[i];
    if (!cur.stops.length) continue;
    // 只检查 cur 的两个端点：哪个端点是另一支段的内部站（汇合站）
    let junction = null; // { host, hostIdx, isHead }
    const ends = [
      { isHead: true, idx: 0 },
      { isHead: false, idx: cur.stops.length - 1 },
    ];
    for (const end of ends) {
      const cs = cur.stops[end.idx];
      for (let j = 0; j < resolved.length; j++) {
        if (i === j) continue;
        const host = resolved[j];
        if (!host.stops.length) continue;
        // 该站是 host 的端点 → 背靠背，不是贯通；跳过
        if (sameStation(cs, host.stops[0]) || sameStation(cs, host.stops[host.stops.length - 1])) continue;
        const hj = host.stops.findIndex((s) => sameStation(cs, s));
        if (hj >= 0) { junction = { host, hostIdx: hj, isHead: end.isHead }; break; }
      }
      if (junction) break;
    }
    if (!junction) continue;

    const { host, hostIdx, isHead } = junction;
    // 若汇合站在首端，先反转到末端，统一成「外端 → 汇合站」方向
    if (isHead && cur.stops.length > 1) {
      cur.stops = cur.stops.slice().reverse();
      if (cur.rawPath) cur.rawPath = cur.rawPath.slice().reverse();
    }
    // 主干在汇合站之后的站点（不含汇合站本身）
    const hostTail = host.stops.slice(hostIdx + 1);
    if (hostTail.length) cur.stops = cur.stops.concat(hostTail);
    // 拼接几何：cur.rawPath + host.rawPath 从汇合站之后的部分
    if (cur.rawPath && host.rawPath && host.stops[hostIdx]) {
      const jp = nearestPathIndex(host.rawPath, host.stops[hostIdx]);
      cur.rawPath = cur.rawPath.concat(host.rawPath.slice(jp + 1));
    }
    // 贯通后端点已变化，重算首尾站名并标记
    cur.spliced = true;
    cur.front = String(cur.stops[0] ? cur.stops[0].name : cur.front);
    cur.terminal = String(cur.stops[cur.stops.length - 1] ? cur.stops[cur.stops.length - 1].name : cur.terminal);
  }
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
function loadSegmentDistances(dir) {
  const lookup = new Map();
  const bases = [
    `data/cptond/metro/shapefiles/${dir}/${dir.toLowerCase()}_metro_segments`,
    `data/cptond/bus/shapefiles/${dir}/${dir.toLowerCase()}_bus_segments`,
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

// 转换单个城市
function convertCity(cityKey) {
  const cfg = CITIES[cityKey];
  if (!cfg) throw new Error('未知城市：' + cityKey + '（可用：' + Object.keys(CITIES).join(', ') + '）');
  const dir = cfg.dir;
  const prefix = dir.toLowerCase();
  const OUT_FILE = path.join(__dirname, 'data', prefix + '-transit.json');

  const t0 = Date.now();
  const segDist = loadSegmentDistances(dir);

  const stopGroups = new Map(); // route_cn -> [{id,name,lng,lat,seq}]
  const routes = [];            // {cn, attrs, geom}
  let orphanStops = 0;

  const pairs = [
    [`data/cptond/metro/shapefiles/${dir}/${prefix}_metro_routes`, `data/cptond/metro/shapefiles/${dir}/${prefix}_metro_stops`],
    [`data/cptond/bus/shapefiles/${dir}/${prefix}_bus_routes`, `data/cptond/bus/shapefiles/${dir}/${prefix}_bus_stops`],
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
  const ghostMap = GHOST_STOPS[cityKey] || {};
  const lines = [];
  let orphanRoutes = 0;
  for (const [base, cns] of baseGroups) {
    // 是否地铁：只有地铁才做「分支拆分」+「分叉贯通」。地铁端点命名一致、可靠；
    // 公交站点名有大量别名/错字（如「时代广汽」vs「时代广动」），
    // 按端点对拆分会把同一公交的两个方向误判成两条假支段，故公交沿用旧的「合并所有方向选最优」。
    const isMetro = cns.some((cn) => {
      const r = routeByCn.get(cn);
      return r && guessMode(r.attrs.route_type, r.attrs.type_en) === 'metro';
    });

    let branches;
    if (isMetro) {
      // 坑3：同名地铁可能包含多个不连通支段（广州3号线主线 vs 北延段、12号线西段 vs 南段）。
      // 先过滤「短交路/快车」等服务变体（夜班/大站车/特快…），再按「起点|终点」无序对拆分支。
      const real = cns.filter((cn) => !isServiceVariant(cn));
      const pool = real.length ? real : cns; // 全部都是变体时退回保留，避免整线消失
      const branchGroups = new Map(); // stationSetKey -> [{cn, route, stops}]
      for (const cn of pool) {
        const route = routeByCn.get(cn);
        const stops = stopGroups.get(cn) || [];
        const key = stationSetKey(stops);
        if (!branchGroups.has(key)) branchGroups.set(key, []);
        branchGroups.get(key).push({ cn, route, stops });
      }
      branches = [...branchGroups.values()];
    } else {
      branches = [cns.map((cn) => ({ cn, route: routeByCn.get(cn), stops: stopGroups.get(cn) || [] }))];
    }

    // 主线（站点最多的支段）保持原名 base；其余支段追加「起点—终点」后缀以区分。
    branches.sort((a, b) => {
      const maxStops = (arr) => arr.reduce((m, e) => Math.max(m, e.stops.length), 0);
      return maxStops(b) - maxStops(a);
    });

    // 第一步：把每个支段解析成「有序去重站点 + 原始几何」（WGS，尚未抽稀/转 GCJ）。
    const resolved = [];
    for (const entries of branches) {
      // 选最优方向：优先有几何的、站点多的
      let best = null;
      let bestScore = -Infinity;
      for (const e of entries) {
        const nPts = e.route && e.route.geom && e.route.geom.points ? e.route.geom.points.length : 0;
        const score = (e.route ? 1e9 : 0) + e.stops.length * 1000 + nPts;
        if (score > bestScore) { bestScore = score; best = e; }
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

      const attrs = best.route ? best.route.attrs : {};
      resolved.push({
        attrs,
        stops,
        rawPath: best.route && best.route.geom && best.route.geom.points ? best.route.geom.points : null,
        front: String(attrs.s_stop_cn || (stops[0] ? stops[0].name : '')),
        terminal: String(attrs.e_stop_cn || (stops.length ? stops[stops.length - 1].name : '')),
        spliced: false,
      });
    }

    // 第二步：分叉贯通（坑4）——把被截断的支段沿主干延伸到主干另一端
    //（如广州3号线北延段只到「体育西路」，实际列车继续开到「海傍」，乘客无需换乘）。
    if (isMetro && resolved.length >= 2) spliceBranches(resolved);

    // 第三步：逐支段构建最终线路。
    let branchIndex = 0;
    for (const r of resolved) {
      const stops = r.stops;
      // 幽灵站剔除（坑2）：按线路名 + 站名
      const ghostNames = ghostMap[base];
      if (ghostNames && ghostNames.length) {
        for (const g of ghostNames) {
          const idx = stops.findIndex((s) => (s.name || '').includes(g));
          if (idx >= 0) stops.splice(idx, 1);
        }
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

      const attrs = r.attrs;
      const mode = guessMode(attrs.route_type, attrs.type_en);
      const front = r.front;
      const terminal = r.terminal;
      // 只有主支保持 base 名；额外支段必须用唯一名，否则 linesMap 会因 id 冲突被覆盖。
      const name = branchIndex === 0 ? base : base + '（' + front + '—' + terminal + '）';

      let path;
      if (r.rawPath) {
        path = decimate(r.rawPath, PATH_MAX_POINTS).map((p) => gcj(p[0], p[1]));
      } else {
        path = stops.map((s) => gcj(s.lng, s.lat));
      }

      lines.push({
        id: hashId(name),
        name,
        mode,
        front,
        terminal,
        start_time: String(attrs.start_time || ''),
        end_time: String(attrs.end_time || ''),
        stops: stops.map((s, idx) => {
          const [lng, lat] = gcj(s.lng, s.lat);
          // 坑1：CPTOND 里"临时站"等占位站会在不同位置复用同一 stop_id，
          // 按 id 去重会把它们当成同一站造成"虚空换乘"。这里把 id 改成"原始id+坐标"，
          // 保证物理站在 (id,坐标) 上唯一。
          const sid = s.id ? String(s.id) + '@' + lng.toFixed(5) + ',' + lat.toFixed(5) : null;
          return { id: sid, name: s.name, lng, lat, seq: idx + 1, d: s.d };
        }),
        path,
      });
      branchIndex++;
    }
  }

  const metroCount = lines.filter((l) => l.mode === 'metro').length;
  const busCount = lines.filter((l) => l.mode === 'bus').length;
  const stopEntries = lines.reduce((n, l) => n + l.stops.length, 0);

  const out = {
    city: cfg.zh,
    source: 'CPTOND-2025 (WGS-84 → GCJ-02)',
    generated_at: new Date().toISOString(),
    count: lines.length,
    lines,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));

  const sizeMB = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1);
  const summary = {
    city: cfg.zh,
    city_key: cityKey,
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
  fs.writeFileSync(path.join(__dirname, 'data', 'cptond', 'convert-summary-' + prefix + '.txt'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

// ---------- 入口 ----------
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const cities = args.length ? args : ['beijing'];
for (const c of cities) convertCity(c);
