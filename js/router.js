/*
 * 本地公共交通寻路器（Transit Router）
 *
 * 纯 JS 模块，不依赖高德/任何地图 SDK，可在浏览器与 Node 中运行。
 * 算法：在「(逻辑站, 线路)」状态空间上做 Dijkstra，考虑：
 *   - 乘车：段距(km)/巡航速度(km/h)×60 + 停站时间
 *   - 等车：上车 / 换乘时按线路模式计固定等车时间
 *   - 换乘：按前后线路模式计换乘惩罚（公交↔公交=0 / 地铁↔地铁 / 公交↔地铁）
 * 支持情景模式（禁用地铁 / 换乘惩罚 / 公交加速）——仅替换参数或可用线路集合。
 *
 * 用法（Node）：
 *   const router = require('./js/router.js');
 *   const graph = router.buildGraph(data.lines);
 *   const r = await router.findOptimalRoute(graph, [lng,lat], [lng,lat], { allowMetro: true }, walkFn);
 * 用法（浏览器）：
 *   <script src="js/router.js"></script>  →  window.TransitRouter
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TransitRouter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 默认成本参数（与 app.js 常量一致，可用 opts 覆盖以模拟情景模式）
  const DEFAULT_PARAMS = {
    metroSpeedKmh: 35,
    metroDwellMin: 0.6,
    busDwellMin: 0.4,
    busVmaxKmh: 36.45,       // 快车/郊区大站最高速度（快车侧再降 10%）
    busVmaxLocalKmh: 16,     // 城区密站慢车最高速度
    busSpacingLocalKm: 0.5,  // 平均站间距 ≤ 此值 → 慢车
    busSpacingExpressKm: 2.0,// 平均站间距 ≥ 此值 → 快车
    busAccelMps2: 0.3,  // 公交加速度 m/s²（缓慢加速）
    busSpeedFactor: 1,  // 公交速度情景系数（1.2=加速20%，0.5=减缓50%）
    metroWaitMin: 2.5,
    busWaitMin: 5,
    metroMetroTransferMin: 3,
    busBusTransferMin: 0,
    busMetroTransferMin: 5,
    allowMetro: true, // 禁用地铁模式 = false
    // 候选站：固定取直线最近的 3 公交 + 2 地铁（已用直线距离，无需距离扩展）
    candidateBaseBus: 3,      // 公交站：直线最近的前 3
    candidateBaseMetro: 2,    // 地铁站：直线最近的前 2
  };

  const MERGE_DISTANCE_M = 300; // 同名站点合并距离（公交↔地铁换乘，曾为 500 太激进）
  const MAX_WALK_KM = 1.5;      // 起终点步行上限：候选站只考虑 1.5km 以内

  // 公交线路巡航速度：按平均站间距区分城区慢车/郊区快车
  function busVmaxForLine(line) {
    const ds = (line.stops || []).map((s) => s.d).filter((x) => typeof x === 'number' && x > 0);
    if (!ds.length) return DEFAULT_PARAMS.busVmaxKmh;
    const avg = ds.reduce((a, b) => a + b, 0) / ds.length;
    const t = Math.max(0, Math.min(1,
      (avg - DEFAULT_PARAMS.busSpacingLocalKm) / (DEFAULT_PARAMS.busSpacingExpressKm - DEFAULT_PARAMS.busSpacingLocalKm)));
    return DEFAULT_PARAMS.busVmaxLocalKmh + t * (DEFAULT_PARAMS.busVmaxKmh - DEFAULT_PARAMS.busVmaxLocalKmh);
  }

  function stateKey(logicalId, lineId) {
    return logicalId + '|' + lineId;
  }

  // 逻辑站在某条线路上的物理站（换乘站会合并多个物理点，需按"所选线路"取准确的上下车点）
  function physicalStopFor(graph, logicalId, lineId) {
    const log = graph.logicalById.get(logicalId);
    if (!log || !log.stopByLine) return null;
    const physId = log.stopByLine[lineId];
    return physId ? graph.physById.get(physId) : null;
  }

  function dwellOf(line, p) { return line.mode === 'metro' ? p.metroDwellMin : p.busDwellMin; }
  function waitOf(line, p) { return line.mode === 'metro' ? p.metroWaitMin : p.busWaitMin; }
  function transferOf(lineA, lineB, p) {
    const m1 = lineA.mode, m2 = lineB.mode;
    if (m1 !== m2) return p.busMetroTransferMin;
    return m1 === 'metro' ? p.metroMetroTransferMin : p.busBusTransferMin;
  }

  // 单段（两相邻站之间）行驶分钟，不含停站：地铁匀速，公交梯形加速（0→缓加速→线路vmax→匀速）
  function segmentRideMin(line, distKm, p) {
    if (line.mode === 'metro') return (distKm / p.metroSpeedKmh) * 60;
    const vmax = (line.busVmaxKmh || p.busVmaxKmh) * (p.busSpeedFactor || 1) / 3.6;
    const tAccel = vmax / p.busAccelMps2;
    const dAccel = 0.5 * p.busAccelMps2 * tAccel * tAccel;
    const d = distKm * 1000;
    if (d < dAccel) return Math.sqrt((2 * d) / p.busAccelMps2) / 60;
    return (tAccel + (d - dAccel) / vmax) / 60;
  }

  function haversineKm(a, b) {
    const R = 6371;
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b[1] - a[1]);
    const dLng = rad(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  function haversineM(a, b) {
    const R = 6371000;
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  // 站名匹配：完全相同，或一者包含另一者（短名需≥2字避免误配）
  function namesMatch(a, b) {
    a = String(a || '').trim();
    b = String(b || '').trim();
    if (!a || !b) return false;
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b;
    if (shorter.length < 2) return false;
    const longer = a.length <= b.length ? b : a;
    return longer.includes(shorter);
  }

  // 机场航站楼特殊匹配：T2/T3/大兴机场的站名不统一，归一化到同一航站楼 key 后视为同名。
  function airportTerminalKey(name) {
    name = String(name || '').trim();
    if (!name) return null;
    if (name.includes('大兴机场') || /^航站楼/.test(name)) return 'daxing';
    const isCapital = name.includes('首都机场') || /^T[23]/.test(name) || /^\d号航/.test(name);
    if (!isCapital) return null;
    if (/2/.test(name) && !/3/.test(name)) return 't2';
    if (/3/.test(name) && !/2/.test(name)) return 't3';
    return null;
  }
  function airportTerminalMatch(a, b) {
    const ka = airportTerminalKey(a), kb = airportTerminalKey(b);
    return ka != null && kb != null && ka === kb;
  }

  // 是否共享线路：同一条线路上的两个不同站不能合并（否则破坏线路拓扑，乘车边会断）
  function sharesLine(a, b) {
    const sa = a.lineIds;
    const sb = b.lineIds;
    for (const lid of sa) if (sb.has(lid)) return true;
    return false;
  }

  // ============ 最小堆 ============
  function MinHeap() { this.a = []; }
  MinHeap.prototype.size = function () { return this.a.length; };
  MinHeap.prototype.push = function (cost, payload) {
    const a = this.a;
    a.push({ cost, payload });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      const t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  };
  MinHeap.prototype.pop = function () {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return [top.cost, top.payload];
  };

  // ============ 建图：物理点去重 → 逻辑站合并 ============
  function buildGraph(lines) {
    const lineById = new Map();
    const physById = new Map(); // 物理 stop_id -> {id,name,lng,lat,mode,lineIds:Set}

    for (const line of lines || []) {
      const lid = String(line.id);
      const l = {
        id: lid,
        name: line.name,
        mode: line.mode === 'metro' ? 'metro' : 'bus',
        busVmaxKmh: busVmaxForLine(line), // 公交线路巡航速度（城区慢/郊区快）
        stops: (line.stops || []).map((st) => ({
          id: String(st.id),
          name: String(st.name || '').trim(),
          lng: Number(st.lng), lat: Number(st.lat),
          seq: Number(st.seq || 0), d: st.d,
        })),
      };
      lineById.set(lid, l);
      l.stopIndex = new Map(l.stops.map((s, i) => [s.id, i]));
      // 地铁环线（内环/外环）首尾相邻，补上闭环距离，供"走站少的那边"
      l.isLoop = /内环|外环/.test(line.name || '');
      if (l.isLoop && l.stops.length >= 2) {
        const a = l.stops[0], b = l.stops[l.stops.length - 1];
        l.wrapDistKm = haversineKm([a.lng, a.lat], [b.lng, b.lat]);
      }
      for (const st of l.stops) {
        let p = physById.get(st.id);
        if (!p) {
          p = { id: st.id, name: st.name, lng: st.lng, lat: st.lat, mode: l.mode, lineIds: new Set() };
          physById.set(st.id, p);
        }
        p.lineIds.add(lid);
        if (l.mode === 'metro') p.mode = 'metro';
      }
    }

    const physList = Array.from(physById.values());

    // 合并：距离 < MERGE_DISTANCE_M 且名字匹配（完全相同 或 一者包含另一者）
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
      rootLines.set(p.id, new Set(p.lineIds));
    }
    const findRoot = (x) => { let r = x; while (uf.get(r) !== r) r = uf.get(r); while (uf.get(x) !== x) { const nx = uf.get(x); uf.set(x, r); x = nx; } return r; };
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
            if (haversineM(p, q) < MERGE_DISTANCE_M && (namesMatch(p.name, q.name) || airportTerminalMatch(p.name, q.name)) && !sharesLine(p, q)) union(p.id, q.id);
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

    const logicalById = new Map();
    const physToLogical = new Map();

    for (const clusterPhys of groups.values()) {
      clusterPhys.sort((a, b) => (a.id < b.id ? -1 : 1));
      let rep = null;
      for (const p of clusterPhys) if (p.mode === 'metro') { rep = p; break; }
      if (!rep) rep = clusterPhys[0];
      let name = clusterPhys[0].name;
      for (const p of clusterPhys) if (p.name.length < name.length) name = p.name;

      const lineIds = new Set();
      const stopByLine = {};
      const physIds = [];
      for (const p of clusterPhys) {
        for (const lid of p.lineIds) { lineIds.add(lid); stopByLine[lid] = p.id; }
        physIds.push(p.id);
      }

      const id = 'S_' + name + '@' + rep.lng.toFixed(4) + ',' + rep.lat.toFixed(4);
      logicalById.set(id, {
        id, name, lng: rep.lng, lat: rep.lat, mode: rep.mode,
        lineIds: Array.from(lineIds), stopByLine,
      });
      for (const pid of physIds) physToLogical.set(pid, id);
    }

    return { lineById, physById, physList, logicalById, physToLogical };
  }

  // 起终点附近候选站：nBus 个公交站 + nMetro 个地铁站（按直线距离）
  function nearestCandidates(graph, pt, nBus, nMetro) {
    const bus = [], metro = [];
    for (const p of graph.physList) {
      const d = haversineKm(pt, [p.lng, p.lat]);
      if (p.mode === 'metro') metro.push({ p, d });
      else bus.push({ p, d });
    }
    bus.sort((a, b) => a.d - b.d);
    metro.sort((a, b) => a.d - b.d);
    const out = [];
    for (let i = 0; i < nBus && i < bus.length; i++) out.push(bus[i].p);
    for (let i = 0; i < nMetro && i < metro.length; i++) out.push(metro[i].p);
    return out;
  }

  // 候选站：固定取直线最近（且 ≤1.5km）的 N 个公交站 + M 个地铁站
  function adaptiveCandidates(graph, pt, opts) {
    opts = Object.assign({}, DEFAULT_PARAMS, opts || {}); // 防御：未传的参数用默认值
    const bus = [], metro = [], all = [];
    for (const p of graph.physList) {
      const d = haversineKm(pt, [p.lng, p.lat]);
      if (d > MAX_WALK_KM) continue; // 距离过滤：步行不超过 1.5km
      all.push({ p, d });
      if (p.mode === 'metro') metro.push({ p, d });
      else bus.push({ p, d });
    }
    bus.sort((a, b) => a.d - b.d);
    metro.sort((a, b) => a.d - b.d);

    const out = [];
    for (let i = 0; i < opts.candidateBaseBus && i < bus.length; i++) out.push(bus[i].p);
    if (opts.allowMetro) {
      for (let i = 0; i < opts.candidateBaseMetro && i < metro.length; i++) out.push(metro[i].p);
    }
    if (!out.length && all.length) {
      // 兜底：1.5km 内没有任何站时，取最近的一个（避免无路线）
      all.sort((a, b) => a.d - b.d);
      out.push(all[0].p);
    }
    return out;
  }

  // ============ Dijkstra over (logicalStop, line) ============
  function runDijkstra(graph, sources, opts) {
    const dist = new Map();
    const parent = new Map();
    const heap = new MinHeap();

    for (const [key, s] of sources) {
      dist.set(key, s.cost);
      parent.set(key, null);
      heap.push(s.cost, { logicalId: s.logicalId, lineId: s.lineId });
    }

    while (heap.size()) {
      const [cost, cur] = heap.pop();
      const curKey = stateKey(cur.logicalId, cur.lineId);
      if (cost > (dist.get(curKey) || Infinity)) continue; // 过期条目

      const line = graph.lineById.get(cur.lineId);
      const log = graph.logicalById.get(cur.logicalId);
      if (!line || !log) continue;

      // 乘车边：沿当前线路向两侧相邻物理站移动
      const physId = log.stopByLine[cur.lineId];
      const stops = line.stops;
      const idx = line.stopIndex ? line.stopIndex.get(physId) : undefined;
      if (idx != null) {
        if (idx + 1 < stops.length) relaxRide(idx, idx + 1);
        if (idx - 1 >= 0) relaxRide(idx, idx - 1);
        // 环线：首尾相邻，补闭环边（走站少的那边）
        if (line.isLoop) {
          if (idx === 0) relaxRide(0, stops.length - 1, line.wrapDistKm);
          else if (idx === stops.length - 1) relaxRide(stops.length - 1, 0, line.wrapDistKm);
        }
      }

      function relaxRide(aIdx, bIdx, explicitDist) {
        const a = stops[aIdx], b = stops[bIdx];
        const lo = a.seq <= b.seq ? a : b; // 用 seq 较小一站的 d（到下一站的距离）
        const d = explicitDist != null ? explicitDist : lo.d;
        if (typeof d !== 'number' || !(d > 0)) return;
        const bLog = graph.physToLogical.get(b.id);
        if (!bLog) return;
        const edge = segmentRideMin(line, d, opts) + dwellOf(line, opts);
        const nKey = stateKey(bLog, cur.lineId);
        const nCost = cost + edge;
        if (nCost < (dist.get(nKey) || Infinity)) {
          dist.set(nKey, nCost);
          parent.set(nKey, { logicalId: cur.logicalId, lineId: cur.lineId });
          heap.push(nCost, { logicalId: bLog, lineId: cur.lineId });
        }
      }

      // 换乘边：同逻辑站换到其它线路（重新等车 + 换乘惩罚）
      for (const lid of log.lineIds) {
        if (lid === cur.lineId) continue;
        const nline = graph.lineById.get(lid);
        if (!nline) continue;
        if (!opts.allowMetro && nline.mode === 'metro') continue;
        const nCost = cost + transferOf(line, nline, opts) + waitOf(nline, opts);
        const nKey = stateKey(cur.logicalId, lid);
        if (nCost < (dist.get(nKey) || Infinity)) {
          dist.set(nKey, nCost);
          parent.set(nKey, { logicalId: cur.logicalId, lineId: cur.lineId });
          heap.push(nCost, { logicalId: cur.logicalId, lineId: lid });
        }
      }
    }

    return { dist, parent };
  }

  // 两逻辑站在某线路上的段统计（段数/距离/乘车时间）；环线时选站少/时间少的那边
  function rideStatsBetween(graph, line, fromLogicalId, toLogicalId, opts) {
    const fl = graph.logicalById.get(fromLogicalId);
    const tl = graph.logicalById.get(toLogicalId);
    const fp = fl && fl.stopByLine ? fl.stopByLine[line.id] : null;
    const tp = tl && tl.stopByLine ? tl.stopByLine[line.id] : null;
    const stops = line.stops;
    const ia = line.stopIndex ? line.stopIndex.get(fp) : undefined;
    const ib = line.stopIndex ? line.stopIndex.get(tp) : undefined;
    if (ia == null || ib == null || ia === ib) return { stops: 0, distanceKm: 0, rideMin: 0 };
    const lo = Math.min(ia, ib), hi = Math.max(ia, ib);

    function rangeStats(a, b) {
      let dist = 0, rideMin = 0;
      for (let i = a; i < b; i++) {
        const d = stops[i].d;
        if (typeof d === 'number' && d > 0) { dist += d; rideMin += segmentRideMin(line, d, opts); }
      }
      return { segs: b - a, dist, rideMin };
    }

    // 方向1：线性 lo→hi
    const d1 = rangeStats(lo, hi);
    // 方向2：绕环 hi→…→末站→首站→…→lo（仅环线）
    let d2 = null;
    if (line.isLoop && line.wrapDistKm > 0) {
      const seg1 = rangeStats(hi, stops.length - 1);
      const seg2 = rangeStats(0, lo);
      d2 = {
        segs: seg1.segs + 1 + seg2.segs,
        dist: seg1.dist + line.wrapDistKm + seg2.dist,
        rideMin: seg1.rideMin + segmentRideMin(line, line.wrapDistKm, opts) + seg2.rideMin,
      };
    }

    const best = (d2 && d2.rideMin < d1.rideMin) ? d2 : d1;
    return {
      stops: best.segs,
      distanceKm: best.dist,
      rideMin: best.rideMin + best.segs * dwellOf(line, opts),
    };
  }

  // 回溯路径并压缩：返回 [ {type:'ride',...}, {type:'transfer',...}, ... ]
  function reconstructRoute(graph, parent, bestState, opts) {
    const chain = [];
    let cur = bestState;
    while (cur) {
      chain.push(cur);
      const p = parent.get(stateKey(cur.logicalId, cur.lineId));
      if (!p) break;
      cur = p;
    }
    // chain[0]=终点, chain[last]=起点；反向得到起点→终点
    const events = [];
    for (let i = chain.length - 1; i >= 1; i--) {
      const from = chain[i], to = chain[i - 1];
      if (from.lineId === to.lineId) {
        events.push({ type: 'ride', lineId: from.lineId, fromLogicalId: from.logicalId, toLogicalId: to.logicalId });
      } else {
        events.push({ type: 'transfer', logicalId: from.logicalId, fromLineId: from.lineId, toLineId: to.lineId });
      }
    }

    const legs = [];
    for (const ev of events) {
      if (ev.type === 'ride') {
        const last = legs[legs.length - 1];
        if (last && last.type === 'ride' && last.lineId === ev.lineId && last.toLogicalId === ev.fromLogicalId) {
          last.toLogicalId = ev.toLogicalId; // 连续同线乘车段合并
        } else {
          legs.push({ type: 'ride', lineId: ev.lineId, fromLogicalId: ev.fromLogicalId, toLogicalId: ev.toLogicalId });
        }
      } else {
        const fl = graph.lineById.get(ev.fromLineId);
        const tl = graph.lineById.get(ev.toLineId);
        legs.push({
          type: 'transfer', logicalId: ev.logicalId,
          fromLineId: ev.fromLineId, toLineId: ev.toLineId,
          fromLineName: fl ? fl.name : ev.fromLineId, toLineName: tl ? tl.name : ev.toLineId,
          stopName: graph.logicalById.get(ev.logicalId).name,
        });
      }
    }
    for (const leg of legs) {
      if (leg.type !== 'ride') continue;
      const line = graph.lineById.get(leg.lineId);
      const st = rideStatsBetween(graph, line, leg.fromLogicalId, leg.toLogicalId, opts);
      leg.lineName = line ? line.name : leg.lineId;
      leg.mode = line ? line.mode : 'bus';
      leg.fromName = graph.logicalById.get(leg.fromLogicalId).name;
      leg.toName = graph.logicalById.get(leg.toLogicalId).name;
      leg.stops = st.stops;
      leg.distanceKm = st.distanceKm;
      leg.rideMin = st.rideMin;
      leg.waitMin = waitOf(line, opts);
    }
    return legs;
  }

  // ============ 主入口 ============
  // origin/dest: [lng, lat]；opts: 成本参数覆盖（含 allowMetro）；walkFn(a,b) -> Promise<{dist(米), min(分钟)}>
  function findOptimalRoute(graph, origin, dest, opts, walkFn) {
    opts = Object.assign({}, DEFAULT_PARAMS, opts || {});
    // 自适应候选站：直线前 3 公交 + 前 2 地铁必选，距离接近的额外纳入
    const board = adaptiveCandidates(graph, origin, opts);
    const alight = adaptiveCandidates(graph, dest, opts);
    if (!board.length || !alight.length) return Promise.resolve(null);

    const tasks = [];
    for (const p of board) tasks.push(walkFn(origin, [p.lng, p.lat]).then((r) => ({ kind: 'to', physId: p.id, r })));
    for (const p of alight) tasks.push(walkFn([p.lng, p.lat], dest).then((r) => ({ kind: 'from', physId: p.id, r })));

    return Promise.all(tasks).then((results) => {
      const toMin = new Map();
      const fromMin = new Map();
      for (const x of results) {
        if (x.kind === 'to') toMin.set(x.physId, x.r.min);
        else fromMin.set(x.physId, x.r.min);
      }

      // 单次多源 Dijkstra：把"步行到上车站"的时间并入源点成本，保证配对正确
      const sources = new Map();
      for (const p of board) {
        const logId = graph.physToLogical.get(p.id);
        const wTo = toMin.get(p.id);
        if (!logId || wTo == null) continue;
        const log = graph.logicalById.get(logId);
        for (const lid of log.lineIds) {
          const line = graph.lineById.get(lid);
          if (!line) continue;
          if (!opts.allowMetro && line.mode === 'metro') continue;
          const key = stateKey(logId, lid);
          const c = wTo + waitOf(line, opts);
          const cur = sources.get(key);
          if (!cur || c < cur.cost) sources.set(key, { logicalId: logId, lineId: lid, cost: c, boardPhysId: p.id, walkToMin: wTo });
        }
      }
      if (!sources.size) return null;

      const { dist, parent } = runDijkstra(graph, sources, opts);

      let best = null;
      for (const ap of alight) {
        const aLog = graph.physToLogical.get(ap.id);
        const wFrom = fromMin.get(ap.id);
        if (!aLog || wFrom == null) continue;
        const alog = graph.logicalById.get(aLog);
        let bestLine = null, bestTransit = Infinity;
        for (const lid of alog.lineIds) {
          if (!opts.allowMetro && graph.lineById.get(lid).mode === 'metro') continue;
          const key = stateKey(aLog, lid);
          if (dist.has(key) && dist.get(key) < bestTransit) {
            bestTransit = dist.get(key);
            bestLine = lid;
          }
        }
        if (bestTransit === Infinity) continue;
        const total = bestTransit + wFrom; // bestTransit 已含步行到上车站
        if (!best || total < best.totalMin) {
          best = { totalMin: total, fromOriginMin: bestTransit, walkFromMin: wFrom, alightPhys: ap, bestState: { logicalId: aLog, lineId: bestLine } };
        }
      }
      if (!best) return null;

      // 回溯到源点，恢复上车站与步行信息
      let srcState = null, cur2 = best.bestState;
      while (cur2) {
        srcState = cur2;
        const pp = parent.get(stateKey(cur2.logicalId, cur2.lineId));
        if (!pp) break;
        cur2 = pp;
      }
      const src = srcState ? sources.get(stateKey(srcState.logicalId, srcState.lineId)) : null;
      best.walkToMin = src ? src.walkToMin : 0;
      best.transitMin = best.fromOriginMin - best.walkToMin;
      best.boardPhys = src ? graph.physById.get(src.boardPhysId) : null;

      best.legs = reconstructRoute(graph, parent, best.bestState, opts);
      best.board = best.boardPhys ? { name: best.boardPhys.name, mode: best.boardPhys.mode, lng: best.boardPhys.lng, lat: best.boardPhys.lat } : null;
      best.alight = { name: best.alightPhys.name, mode: best.alightPhys.mode, lng: best.alightPhys.lng, lat: best.alightPhys.lat };
      best.transferCount = best.legs.filter((l) => l.type === 'transfer').length;

      // 修正起/终点为换乘站时的上下车点：实际上下车点应是"所选线路"上的物理站
      // （而非离起/终点直线最近的那个候选物理站），步行时间也要按它重算。
      const boardPhys2 = srcState ? physicalStopFor(graph, srcState.logicalId, srcState.lineId) : null;
      const alightPhys2 = physicalStopFor(graph, best.bestState.logicalId, best.bestState.lineId);
      const pWalkTo = boardPhys2 ? walkFn(origin, [boardPhys2.lng, boardPhys2.lat]).then((r) => r.min) : Promise.resolve(best.walkToMin);
      const pWalkFrom = alightPhys2 ? walkFn([alightPhys2.lng, alightPhys2.lat], dest).then((r) => r.min) : Promise.resolve(best.walkFromMin);

      return Promise.all([pWalkTo, pWalkFrom]).then(([walkToMin, walkFromMin]) => {
        best.transitMin = best.fromOriginMin - best.walkToMin; // 纯乘车时间不变
        best.walkToMin = walkToMin;
        best.walkFromMin = walkFromMin;
        best.totalMin = best.transitMin + best.walkToMin + best.walkFromMin;
        if (boardPhys2) best.boardPhys = boardPhys2;
        if (alightPhys2) best.alightPhys = alightPhys2;
        best.board = best.boardPhys ? { name: best.boardPhys.name, mode: best.boardPhys.mode, lng: best.boardPhys.lng, lat: best.boardPhys.lat } : null;
        best.alight = best.alightPhys ? { name: best.alightPhys.name, mode: best.alightPhys.mode, lng: best.alightPhys.lng, lat: best.alightPhys.lat } : null;
        return best;
      });
    });
  }

  return {
    DEFAULT_PARAMS,
    buildGraph,
    nearestCandidates,
    adaptiveCandidates,
    findOptimalRoute,
    haversineKm,
  };
});
