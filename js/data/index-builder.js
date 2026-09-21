/**
 * data/index-builder.js —— 站点索引构建与查询（数据的"读模型"）
 *
 * 【这一层在做什么】
 *   原始数据是"线路 → 沿线物理站"（同一条线路的同一个物理站在数据里是独立的记录）。
 *   游戏需要两种视角：
 *     - 物理站（physStops）：渲染用，一个点就是一个点（含所属线路集合）；
 *     - 逻辑站（logicalStops）：路由用，把"地铁苹果园站"和"苹果园"这类
 *       距离 < MERGE_DISTANCE_M(300m) 且站名匹配的物理站合并成一个换乘节点。
 *   合并结果必须与 js/router.js 的 buildGraph 完全一致，否则会出现
 *   "最优路线被切断、玩家反而比系统更快"的诡异结果（详见下面逻辑站 id 的注释）。
 *
 * 【关键实现：空间网格 + 并查集】
 *   2.8 万个点的两两比较不可行，所以先用 0.01° 网格分桶，只比邻近 3×3 格；
 *   用并查集做合并，并额外记录"每簇已包含哪些线路"，
 *   防止把同一条线路上的两个相邻站合并（那会破坏线路拓扑）。
 *
 * 【产物写入 core/state.js，供各层只读使用】
 *   state.linesMap / physStops / logicalStops / logicalById / physToLogical / physById / logicalPhysMap
 */

import { state } from '../core/state.js';
import { MERGE_DISTANCE_M, BUS_VMAX_KMH, BUS_VMAX_LOCAL_KMH, BUS_SPACING_LOCAL_KM, BUS_SPACING_EXPRESS_KM, LINE_PALETTE } from '../core/config.js';
import { haversineKm } from '../core/router-api.js';

// ============ 构建索引 ============

/**
 * 从原始数据构建全部索引（会清空并重建 state 中的数据字段）。
 * 会在 line 对象上补三个派生字段：color（配色）、busVmaxKmh（巡航速度）、isLoop/wrapDistKm（环线闭环距离）。
 * @param {object} data { city, count, lines }
 */
export function buildIndex(data) {
  state.linesMap = new Map();
  const physMap = new Map(); // stop_id -> 物理点（含 line_ids）

  for (const line of data.lines || []) {
    const id = String(line.id);
    // 颜色按 name 取色：公交上下行是两条线但同名，必须同色（展示成一条线）
    line.color = colorForLine(line.name);
    line.oneWay = line.oneWay === true; // 单向线（公交上下行/环线）只沿 seq 前进方向乘车
    line.busVmaxKmh = busVmaxForLine(line); // 公交线路巡航速度（城区慢/郊区快）
    // 地铁环线（内环/外环）首尾相邻，补上闭环距离，供"走站少的那边"
    // 注意：名称含"区间"的是短途/区间线（如 300路外环区间），首末站不相邻，不是闭环，不能按环线处理
    line.isLoop = /内环|外环/.test(line.name || '') && !/区间/.test(line.name || '');
    if (line.isLoop && line.stops.length >= 2) {
      const a = line.stops[0], b = line.stops[line.stops.length - 1];
      line.wrapDistKm = haversineKm([a.lng, a.lat], [b.lng, b.lat]);
    }
    state.linesMap.set(id, line);

    for (const st of line.stops || []) {
      const sid = String(st.id != null ? st.id : st.name + ',' + st.lng + ',' + st.lat);
      let p = physMap.get(sid);
      if (!p) {
        p = {
          id: sid,
          name: String(st.name || '').trim(),
          lng: Number(st.lng),
          lat: Number(st.lat),
          mode: line.mode === 'metro' ? 'metro' : 'bus',
          line_ids: new Set(),
        };
        physMap.set(sid, p);
      }
      p.line_ids.add(id);
      if (line.mode === 'metro') p.mode = 'metro';
    }
  }

  const physList = Array.from(physMap.values());

  // 逻辑站合并：距离 < MERGE_DISTANCE_M 且名字匹配（完全相同 或 一者包含另一者）
  // 用空间网格 + 并查集，支持"地铁苹果园站"↔"苹果园"这类近名换乘
  const CELL = 0.01;
  const grid = new Map();
  for (const p of physList) {
    const k = Math.floor(p.lng / CELL) + ':' + Math.floor(p.lat / CELL);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }

  const uf = new Map();
  const rootLines = new Map(); // root -> 该簇内所有线路集合（防止传递合并同一线路的两个站）
  for (const p of physList) {
    uf.set(p.id, p.id);
    rootLines.set(p.id, new Set(p.line_ids));
  }
  const findRoot = (x) => {
    let r = x;
    while (uf.get(r) !== r) r = uf.get(r);
    while (uf.get(x) !== x) { const nx = uf.get(x); uf.set(x, r); x = nx; }
    return r;
  };
  const union = (a, b) => {
    const ra = findRoot(a), rb = findRoot(b);
    if (ra === rb) return;
    const la = rootLines.get(ra), lb = rootLines.get(rb);
    for (const lid of la) if (lb.has(lid)) return; // 同一线路的两个站不合并（含传递）
    uf.set(ra, rb);
    for (const lid of la) lb.add(lid);
    rootLines.delete(ra);
  };

  for (const p of physList) {
    const gi = Math.floor(p.lng / CELL), gj = Math.floor(p.lat / CELL);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const cell = grid.get((gi + di) + ':' + (gj + dj));
        if (!cell) continue;
        for (const q of cell) {
          if (q.id === p.id) continue;
          if (distM(p, q) < MERGE_DISTANCE_M && (namesMatch(p.name, q.name) || airportTerminalMatch(p.name, q.name)) && !sharesLine(p, q)) {
            union(p.id, q.id);
          }
        }
      }
    }
  }

  const groups = new Map();
  for (const p of physList) {
    const r = findRoot(p.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  }

  const logicalList = [];
  const p2l = new Map(); // 物理 stop_id -> 逻辑站 id
  const l2p = new Map(); // 逻辑站 id -> [物理 stop_id]

  for (const clusterPhys of groups.values()) {
    clusterPhys.sort((a, b) => (a.id < b.id ? -1 : 1));
    let rep = null;
    for (const p of clusterPhys) if (p.mode === 'metro') { rep = p; break; }
    if (!rep) rep = clusterPhys[0];
    let name = clusterPhys[0].name;
    for (const p of clusterPhys) if (p.name.length < name.length) name = p.name;

    const line_ids = new Set();
    const stopByLine = {};
    const physIds = [];
    for (const p of clusterPhys) {
      for (const lid of p.line_ids) { line_ids.add(lid); stopByLine[lid] = p.id; }
      physIds.push(p.id);
    }

    // 逻辑站 id 必须全局唯一（与 router.js buildGraph 保持完全一致）。
    // 只用「站名+坐标(4位小数)」会让多个同名且坐标相近、但因共享线路而无法合并的簇
    // 生成同一个 id，互相覆盖后丢失线路信息（会导致最优路线被切断、玩家反而更快）。
    const id = 'S_' + name + '@' + rep.lng.toFixed(4) + ',' + rep.lat.toFixed(4) + '#' + rep.id;
    logicalList.push({
      id, name, lng: rep.lng, lat: rep.lat, mode: rep.mode,
      line_ids: Array.from(line_ids), stopByLine,
    });
    l2p.set(id, physIds);
    for (const pid of physIds) p2l.set(pid, id);
  }

  state.logicalStops = logicalList;
  state.logicalById = new Map(logicalList.map((s) => [s.id, s]));
  state.physToLogical = p2l;
  state.logicalPhysMap = l2p; // 当前未参与计算，保留备用
  state.physById = new Map(physList.map((p) => [p.id, p]));
  state.physStops = physList.map((p) => ({
    id: p.id, name: p.name, lng: p.lng, lat: p.lat,
    mode: p.mode, logicalId: p2l.get(p.id),
  }));
}

// ============ 查询（各层只读用） ============

/** 取线路对象 */
export function getLine(id) {
  return state.linesMap.get(id) || null;
}

/** 按逻辑站 id 取逻辑站 */
export function getLogical(id) {
  return state.logicalById.get(id) || null;
}

/** 按物理 stop_id 取物理点 */
export function getPhys(id) {
  return state.physById.get(id) || null;
}

/**
 * 把地图事件里的站点数据（MassMarks 的 e.data）解析成逻辑站。
 * 地图上的点携带 logicalId；没有的话按物理 id 反查。
 */
export function resolveStop(d) {
  if (!d) return null;
  const lid = d.logicalId || state.physToLogical.get(d.id);
  return state.logicalById.get(lid) || null;
}

/**
 * 取"该线路在该逻辑站上的物理站记录"（含 lng/lat/seq/d）。
 * 逻辑站可能合并了多个物理站（如地铁站 + 同名公交站），所以要按线路分别取。
 */
export function findStopInLine(line, logicalStop) {
  const sid = logicalStop && logicalStop.stopByLine ? logicalStop.stopByLine[String(line.id)] : null;
  if (sid) {
    const s = (line.stops || []).find((x) => String(x.id) === String(sid));
    if (s) return s;
  }
  return (line.stops || []).find((s) => String(s.id) === String(logicalStop && logicalStop.id));
}

/** 取该逻辑站在线路 stops 数组里的下标（找不到返回 -1） */
export function stopIndexInLine(line, logicalStop) {
  const sid = logicalStop && logicalStop.stopByLine ? logicalStop.stopByLine[String(line.id)] : null;
  if (sid) {
    const i = (line.stops || []).findIndex((x) => String(x.id) === String(sid));
    if (i >= 0) return i;
  }
  return (line.stops || []).findIndex((s) => String(s.id) === String(logicalStop && logicalStop.id));
}

// ============ 几何 / 名称匹配工具 ============

/** 两个 {lng,lat} 之间的球面距离（米） */
export function distM(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** 站名匹配：完全相同，或一者包含另一者（如"苹果园"⊂"地铁苹果园站"），短名需≥2字避免误配 */
export function namesMatch(a, b) {
  a = String(a || '').trim();
  b = String(b || '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  if (shorter.length < 2) return false;
  const longer = a.length <= b.length ? b : a;
  return longer.includes(shorter);
}

/**
 * 机场航站楼特殊匹配：T2/T3/大兴机场的站名不统一（如"T2航站楼"vs"2号航站楼"、"大兴机场"vs"航站楼"），
 * 归一化到同一航站楼 key 后视为同名。距离是否过近仍由 MERGE_DISTANCE_M 判断。
 */
export function airportTerminalKey(name) {
  name = String(name || '').trim();
  if (!name) return null;
  if (name.includes('大兴机场') || /^航站楼/.test(name)) return 'daxing';
  const isCapital = name.includes('首都机场') || /^T[23]/.test(name) || /^\d号航/.test(name);
  if (!isCapital) return null;
  if (/2/.test(name) && !/3/.test(name)) return 't2';
  if (/3/.test(name) && !/2/.test(name)) return 't3';
  return null;
}

export function airportTerminalMatch(a, b) {
  const ka = airportTerminalKey(a), kb = airportTerminalKey(b);
  return ka != null && kb != null && ka === kb;
}

/** 是否共享线路：同一条线路上的两个不同站不能合并（否则破坏线路拓扑，乘车边会断） */
export function sharesLine(a, b) {
  const sa = a.line_ids;
  const sb = b.line_ids;
  for (const lid of sa) if (sb.has(lid)) return true;
  return false;
}

/** 线路配色：按 name 哈希取色（同一条线路的上下行同名 → 同色，重启不变） */
export function colorForLine(name) {
  let h = 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return LINE_PALETTE[h % LINE_PALETTE.length];
}

/** 公交线路巡航速度：按平均站间距区分城区慢车/郊区快车 */
export function busVmaxForLine(line) {
  const ds = (line.stops || []).map((s) => s.d).filter((x) => typeof x === 'number' && x > 0);
  if (!ds.length) return BUS_VMAX_KMH; // 无距离数据，按快车
  const avg = ds.reduce((a, b) => a + b, 0) / ds.length;
  const t = Math.max(0, Math.min(1, (avg - BUS_SPACING_LOCAL_KM) / (BUS_SPACING_EXPRESS_KM - BUS_SPACING_LOCAL_KM)));
  return BUS_VMAX_LOCAL_KMH + t * (BUS_VMAX_KMH - BUS_VMAX_LOCAL_KMH);
}
