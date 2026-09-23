'use strict';

// 把 CPTOND-2025 的某城市 shapefile 转换成游戏用的 <城市>-transit.json
// 用法：
//   node scripts/cptond-convert.js                 # 默认转换北京
//   node scripts/cptond-convert.js guangzhou       # 转换广州
//   node scripts/cptond-convert.js shenzhen shanghai  # 批量转换多城
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
const { parseDbf, parseShp } = require('../lib/shp');

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

// GCJ-02 → WGS-84（迭代求逆，2~3 次即收敛到米级；用于把高德行政区边界转回 WGS-84 后裁剪源数据）
function gcj2wgs(gLng, gLat) {
  let lng = gLng, lat = gLat;
  for (let i = 0; i < 3; i++) {
    const [cLng, cLat] = wgs2gcj(lng, lat);
    lng -= cLng - gLng;
    lat -= cLat - gLat;
  }
  return [lng, lat];
}

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

// ============ 线路构建小工具（地铁/公交共用，保持主流程可读） ============

/** 站点按 seq 排序 + 去重（同一站点可能因换向/区间重复出现） */
function orderedStops(raw) {
  const sorted = raw.slice().sort((a, b) => a.seq - b.seq);
  const seen = new Set();
  const out = [];
  for (const s of sorted) {
    if (!s.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** 幽灵站剔除（坑2）：按线路名 + 站名，直接改传入数组 */
function filterGhostStops(stops, base, ghostMap) {
  const ghostNames = ghostMap[base];
  if (!ghostNames || !ghostNames.length) return stops;
  for (const g of ghostNames) {
    const idx = stops.findIndex((s) => (s.name || '').includes(g));
    if (idx >= 0) stops.splice(idx, 1);
  }
  return stops;
}

/** 逐站距离（优先 CPTOND segments 真实值，缺失用 haversine 兜底），直接改传入数组 */
function fillDistances(stops, segDist) {
  for (let i = 0; i < stops.length; i++) {
    let d = null;
    if (i < stops.length - 1) {
      const key = stops[i].id + '|' + stops[i + 1].id;
      d = segDist.get(key);
      if (d == null) d = haversine(stops[i].lng, stops[i].lat, stops[i + 1].lng, stops[i + 1].lat);
    }
    stops[i].d = d == null ? null : Number(d.toFixed(3));
  }
  return stops;
}

/** 输出站数组：坐标转 GCJ、id 加坐标后缀防"临时站"同 id 冲突（坑1）、seq 重编号 */
function emitStops(stops) {
  return stops.map((s, idx) => {
    const [lng, lat] = gcj(s.lng, s.lat);
    const sid = s.id ? String(s.id) + '@' + lng.toFixed(5) + ',' + lat.toFixed(5) : null;
    return { id: sid, name: s.name, lng, lat, seq: idx + 1, d: s.d };
  });
}

/** 输出路径：有几何则抽稀转 GCJ，否则用站点坐标连成折线 */
function emitPath(rawPath, stops) {
  if (rawPath) return decimate(rawPath, PATH_MAX_POINTS).map((p) => gcj(p[0], p[1]));
  return stops.map((s) => gcj(s.lng, s.lat));
}

/** 是否环线（与 index-builder/router 的 isLoop 判定一致，环线是单向的） */
function isLoopName(name) {
  return /内环|外环/.test(name || '') && !/区间/.test(name || '');
}

// ---------- 城市边界裁剪（剔除跨市公交伸到邻市的部分） ----------
// 边界 GeoJSON 来自高德 DataV（GCJ-02），下载后放在 data/boundaries/<cityKey>.json（已入库跟踪）。
// 只对公交裁剪：跨市公交（如广州的 佛*/莞* 线路）会把站点铺到佛山/东莞，但那边没有本城地铁，
// 会造成连通性错乱（孤立的公交孤岛、最优路线算不出）。
const BOUNDARY_FILES = {
  beijing: 'data/boundaries/beijing.json',
  shanghai: 'data/boundaries/shanghai.json',
  guangzhou: 'data/boundaries/guangzhou.json',
  shenzhen: 'data/boundaries/shenzhen.json',
};

// 跨市公交的线路名标识：单字邻市（佛=佛山/莞=东莞）只认开头，多字邻市名可出现在任意位置。
// 跨市线被边界裁剪后若只剩 2 站，就是无意义碎片（如「平湖229路」「便民快巴泰兴上海线2线」），
// 连同这种 ≤2 站碎片一起丢掉。
const CROSS_CITY_RE = /(^佛|^莞|平湖|嘉善|泰兴|昆山|太仓|花桥|吴江|启东|海门|燕郊|涿州|廊坊|三河|香河|固安|大厂|惠州|凤岗|珠海|清远|肇庆|江门)/;

/** 射线法：点是否在多边形内（rings = 一个多边形的外环 + 内环数组，偶数次穿越 = 外） */
function pointInPolygon(lng, lat, rings) {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** 点是否在 MultiPolygon 任意一个多边形内 */
function pointInBoundary(lng, lat, polygons) {
  for (const rings of polygons) if (pointInPolygon(lng, lat, rings)) return true;
  return false;
}

// 边界容差（度）：DataV 行政区边界是简化多边形，紧贴边界的「机场」站点会被误裁
//（北京大兴机场约在界外 600m）。只给机场/航站楼这类边界设施开容差，避免把跨市公交的
// 边站重新放进来（广佛/燕郊等边境密集区如果普遍开容差，会把邻市站点又捞回来形成孤岛）。
const EDGE_STOP_TOLERANCE_DEG = 0.008;
const EDGE_STOP_RE = /机场|航站楼/;

/** 点到线段的距离（度） */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.sqrt((px - qx) * (px - qx) + (py - qy) * (py - qy));
}

/** 点到 MultiPolygon 边界的最短距离（度） */
function distToBoundary(lng, lat, polygons) {
  let best = Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        const d = distToSegment(lng, lat, a[0], a[1], b[0], b[1]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** 站点是否保留：严格在边界内；机场/航站楼在界外但离边界 ≤ 容差的也保留（大兴机场） */
function stopInBoundary(s, polygons) {
  if (pointInBoundary(s.lng, s.lat, polygons)) return true;
  return EDGE_STOP_RE.test(String(s.name || '')) && distToBoundary(s.lng, s.lat, polygons) <= EDGE_STOP_TOLERANCE_DEG;
}

/** 读取并转换城市边界：DataV GeoJSON（GCJ-02）→ WGS-84 的 MultiPolygon（供裁剪源数据） */
function loadBoundary(cityKey) {
  const file = BOUNDARY_FILES[cityKey];
  if (!file) return null;
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  const g = j.features[0].geometry;
  const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  return polys.map((poly) => poly.map((ring) => ring.map(([lng, lat]) => gcj2wgs(lng, lat))));
}

/** 把一条线的站点/几何裁剪到边界内；返回 { stops, rawPath }（可能为空） */
function clipToBoundary(stops, rawPath, boundary) {
  if (!boundary) return { stops, rawPath };
  const inStops = stops.filter((s) => stopInBoundary(s, boundary));
  let inPath = null;
  if (rawPath) {
    // 路径几何严格裁剪（不给容差）：站点已含机场特例，路径差几百米只是视觉上的小缺口
    const pts = rawPath.filter((p) => pointInBoundary(p[0], p[1], boundary));
    if (pts.length >= 2) inPath = pts;
  }
  return { stops: inStops, rawPath: inPath };
}

// 转换单个城市
function convertCity(cityKey) {
  const cfg = CITIES[cityKey];
  if (!cfg) throw new Error('未知城市：' + cityKey + '（可用：' + Object.keys(CITIES).join(', ') + '）');
  const dir = cfg.dir;
  const prefix = dir.toLowerCase();
  const OUT_FILE = path.join(__dirname, '..', 'data', prefix + '-transit.json');

  const t0 = Date.now();
  const segDist = loadSegmentDistances(dir);
  const boundary = loadBoundary(cityKey); // 城市边界（WGS-84，无配置则为 null → 不裁剪）

  const stopGroups = new Map(); // route_cn -> [{id,name,lng,lat,seq}]
  const routes = [];            // {cn, attrs, geom}
  let orphanStops = 0;

  const pairs = [
    [`data/cptond/metro/shapefiles/${dir}/${prefix}_metro_routes`, `data/cptond/metro/shapefiles/${dir}/${prefix}_metro_stops`],
    [`data/cptond/bus/shapefiles/${dir}/${prefix}_bus_routes`, `data/cptond/bus/shapefiles/${dir}/${prefix}_bus_stops`],
  ];

  // 未完工线路（status != '1'）的 route_cn。地铁才有 status 语义：
  //   1=运营，2=在建，3=规划；只保留 1（运营），避免把没开通的二期/北延段/中段等当成本体。
  const nonOperating = new Set();

  for (const [rbase, sbase] of pairs) {
    const isMetro = rbase.includes('/metro/');
    // 先读线路（拿 status 过滤未完工线路，再决定哪些站保留）
    const routeFeats = loadFeatures(rbase);
    for (const f of routeFeats) {
      const cn = String(f.attrs.route_cn || '').trim();
      if (!cn) continue;
      if (isMetro && String(f.attrs.status || '') !== '1') { nonOperating.add(cn); continue; }
      routes.push({ cn, attrs: f.attrs, geom: f.geom });
    }

    // 再读站点（跳过未完工线路的站）
    const stopFeats = loadFeatures(sbase);
    for (const f of stopFeats) {
      const cn = String(f.attrs.route_cn || '').trim();
      if (!cn || nonOperating.has(cn)) continue;
      if (!stopGroups.has(cn)) stopGroups.set(cn, []);
      stopGroups.get(cn).push({
        id: String(f.attrs.stop_id || ''),
        name: String(f.attrs.name_cn || ''),
        lng: Number(f.geom.coords[0]),
        lat: Number(f.geom.coords[1]),
        seq: Number(f.attrs.sequence || 0),
      });
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
    const isMetro = cns.some((cn) => {
      const r = routeByCn.get(cn);
      return r && guessMode(r.attrs.route_type, r.attrs.type_en) === 'metro';
    });

    // ===== 公交：拆上下行，每个方向一条单向线 =====
    // 公交上下行常走不同街道（单行道绕行），必须拆成两条单向线，否则路由器把
    // 存的那一条方向反着走，实际却是另一条街、站点也对不上（即"左行公交"）。
    if (!isMetro) {
      const real = cns.filter((cn) => !isServiceVariant(cn)); // 过滤夜班/大站车等变体
      const dirs = real.length ? real : cns;
      for (const cn of dirs) {
        const route = routeByCn.get(cn);
        const rawPath = route && route.geom && route.geom.points ? route.geom.points : null;
        // 裁剪到城市边界内：剔除跨市公交伸到佛山/东莞等邻市的部分（否则那边没有本城地铁，连通性错乱）
        const clipped = clipToBoundary(orderedStops(stopGroups.get(cn) || []), rawPath, boundary);
        const stops = clipped.stops;
        if (route && stops.length === 0) orphanRoutes++;
        if (stops.length < 2) continue; // 裁剪后不足两站，整条线丢弃
        // 跨市碎片：跨市前缀的线裁剪后只剩 2 站，是无意义残留（本体在邻市），一并丢弃
        if (CROSS_CITY_RE.test(base) && stops.length <= 2) continue;
        filterGhostStops(stops, base, ghostMap);
        fillDistances(stops, segDist);
        const attrs = route ? route.attrs : {};
        // 端点取裁剪后的首末站名（跨市线裁剪后 attrs 的端点可能还在佛山/东莞，已过时）
        const front = stops.length ? String(stops[0].name || '') : String(attrs.s_stop_cn || '');
        const terminal = stops.length ? String(stops[stops.length - 1].name || '') : String(attrs.e_stop_cn || '');
        lines.push({
          id: hashId(cn), // route_cn 唯一，上下行各得不同 id
          name: base,      // 上下行同名，展示为一条线（颜色按 name 统一）
          mode: 'bus',
          oneWay: true,    // 单向：只沿 seq 前进方向乘车
          front,
          terminal,
          start_time: String(attrs.start_time || ''),
          end_time: String(attrs.end_time || ''),
          stops: emitStops(stops),
          path: emitPath(clipped.rawPath, stops),
        });
      }
      continue;
    }

    // ===== 地铁：分支拆分 + 分叉贯通；环线（内环/外环）单向，其余双向 =====
    // 坑3：同名地铁可能包含多个不连通支段（广州3号线主线 vs 北延段、12号线西段 vs 南段）。
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
    const branches = [...branchGroups.values()];

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

      const stops = orderedStops(best.stops);
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
    if (resolved.length >= 2) spliceBranches(resolved);

    // 第三步：逐支段构建最终线路。
    let branchIndex = 0;
    for (const r of resolved) {
      const stops = r.stops;
      filterGhostStops(stops, base, ghostMap);
      fillDistances(stops, segDist);
      const attrs = r.attrs;
      const mode = guessMode(attrs.route_type, attrs.type_en);
      const front = r.front;
      const terminal = r.terminal;
      // 只有主支保持 base 名；额外支段必须用唯一名，否则 linesMap 会因 id 冲突被覆盖。
      const name = branchIndex === 0 ? base : base + '（' + front + '—' + terminal + '）';

      lines.push({
        id: hashId(name),
        name,
        mode,
        oneWay: isLoopName(name), // 地铁环线（内环/外环）单向，其余双向
        front,
        terminal,
        start_time: String(attrs.start_time || ''),
        end_time: String(attrs.end_time || ''),
        stops: emitStops(stops),
        path: emitPath(r.rawPath, stops),
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
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'cptond', 'convert-summary-' + prefix + '.txt'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

// ---------- 入口 ----------
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const cities = args.length ? args : ['beijing'];
for (const c of cities) convertCity(c);
