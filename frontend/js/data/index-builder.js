/**
 * data/index-builder.js —— 站点索引构建与查询（数据的"读模型"）
 *
 * 【这一层在做什么】
 *   shared/router.js 负责把原始线路转换为统一的物理站、逻辑站和线路图。
 *   本模块只把那份共享图适配成前端 state 需要的两种视角：
 *     - 物理站（physStops）：渲染用，一个点就是一个点（含所属线路集合）；
 *     - 逻辑站（logicalStops）：交互用，与系统最优使用完全相同的合并结果。
 *   站名匹配、并查集合并、线路速度和环线识别都只在共享寻路器中实现一次。
 *
 * 【产物写入 core/state.js，供各层只读使用】
 *   state.linesMap / physStops / logicalStops / logicalById / physToLogical / physById / logicalPhysMap
 */

import { state } from '../core/state.js';
import { LINE_PALETTE } from '../core/config.js';
import { buildGraph, haversineKm } from '../core/router-api.js';

// ============ 构建索引 ============

/**
 * 从共享寻路图构建前端索引（会清空并重建 state 中的数据字段）。
 * graph 可省略，主要供只需要前端索引的测试使用；正式加载流程会先建图并传入，避免重复计算。
 * @param {object} data { city, count, lines }
 * @param {object} [graph] shared/router.js 的 buildGraph 结果
 */
export function buildIndex(data, graph = buildGraph(data.lines || [])) {
  state.routerGraph = graph;
  state.linesMap = new Map();
  for (const line of data.lines || []) {
    const id = String(line.id);
    const sharedLine = graph.lineById.get(id);
    if (!sharedLine) throw new Error(`共享寻路图缺少线路：${id}`);
    // 颜色按 name 取色：公交上下行是两条线但同名，必须同色（展示成一条线）
    line.color = colorForLine(line.name);
    // 展示层保留原始 path，同时复用共享图算出的全部线路派生字段。
    line.oneWay = sharedLine.oneWay;
    line.busVmaxKmh = sharedLine.busVmaxKmh;
    line.isLoop = sharedLine.isLoop;
    line.wrapDistKm = sharedLine.wrapDistKm;
    line.stopIndex = sharedLine.stopIndex;
    state.linesMap.set(id, line);
  }

  const physList = graph.physList.map((p) => ({
    id: p.id, name: p.name, lng: p.lng, lat: p.lat, mode: p.mode,
    line_ids: new Set(p.lineIds),
  }));
  const logicalList = Array.from(graph.logicalById.values(), (s) => ({
    id: s.id, name: s.name, lng: s.lng, lat: s.lat, mode: s.mode,
    line_ids: Array.from(s.lineIds), stopByLine: { ...s.stopByLine },
  }));
  const p2l = new Map(graph.physToLogical);
  const l2p = new Map(logicalList.map((s) => [s.id, []]));
  for (const [physId, logicalId] of p2l) l2p.get(logicalId)?.push(physId);

  state.logicalStops = logicalList;
  state.logicalById = new Map(logicalList.map((s) => [s.id, s]));
  state.physToLogical = p2l;
  state.logicalPhysMap = l2p; // 当前未参与计算，保留备用
  state.physById = new Map(physList.map((p) => [p.id, p]));
  state.physStops = physList.map((p) => ({
    id: p.id, name: p.name, lng: p.lng, lat: p.lat,
    mode: p.mode, logicalId: p2l.get(p.id),
  }));

  // 计算连通分量：把「共享线路」的逻辑站归并，用于随机起终点时避免落在孤岛（轮渡/离岛线）上。
  // union-find 约 O(N α(N))：北京 ~1.5 万逻辑站实测几十毫秒，数据加载时算一次即可。
  const compUf = new Map(logicalList.map((s) => [s.id, s.id]));
  const compFind = (x) => { let r = x; while (compUf.get(r) !== r) r = compUf.get(r); while (compUf.get(x) !== x) { const nx = compUf.get(x); compUf.set(x, r); x = nx; } return r; };
  const compUnion = (a, b) => { const ra = compFind(a), rb = compFind(b); if (ra !== rb) compUf.set(ra, rb); };
  for (const line of state.linesMap.values()) {
    const logs = new Set();
    for (const st of line.stops || []) { const lg = p2l.get(String(st.id)); if (lg) logs.add(lg); }
    const arr = [...logs];
    for (let i = 1; i < arr.length; i++) compUnion(arr[0], arr[i]);
  }
  const compSize = new Map();
  for (const s of logicalList) { const r = compFind(s.id); compSize.set(r, (compSize.get(r) || 0) + 1); }
  let mainComp = null, mainSize = 0;
  for (const [r, n] of compSize) if (n > mainSize) { mainSize = n; mainComp = r; }
  state.componentOf = new Map(logicalList.map((s) => [s.id, compFind(s.id)]));
  state.mainComponent = mainComp;
  return graph;
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
  return haversineKm([a.lng, a.lat], [b.lng, b.lat]) * 1000;
}

/** 线路配色：按 name 哈希取色（同一条线路的上下行同名 → 同色，重启不变） */
export function colorForLine(name) {
  let h = 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return LINE_PALETTE[h % LINE_PALETTE.length];
}
