'use strict';

// 验证：修复后「系统最优」是否真的 ≥ 玩家可达的任意方案（即最优不再被玩家击败）
//
// 思路：玩家能做的 = 在 1.5km 内任选上车站、任意坐、在 1.5km 内任选下车站。
// 用「每条线路的每一对 (上车站, 下车站) 组合 + 0~2 次换乘」构造大量候选方案，
// 用与 app.js 相同的成本模型（estimateRideMinutes 那套）算时间，取最小值，
// 与 router 报的 totalMin 比较。若 playerBest < optimal - 容差，则 bug 仍在。

const R = require('../shared/router.js');
const data = require('../data/beijing-transit.json');

const graph = R.buildGraph(data.lines);
const MAX_WALK_KM = 1.5;
const METRO_SPEED = 35, METRO_DWELL = 0.6, BUS_DWELL = 0.4;
const METRO_WAIT = 2.5, BUS_WAIT = 5;
const M2M = 3, B2M = 5, B2B = 0;
const BUS_ACCEL = 0.3, BUS_VMAX = 36.45, BUS_VMAX_LOCAL = 16;
const SP_LOCAL = 0.5, SP_EXPRESS = 2.0;

function haversineKm(a, b) { return R.haversineKm(a, b); }

function busVmaxForLine(line) {
  const ds = (line.stops || []).map((s) => s.d).filter((x) => typeof x === 'number' && x > 0);
  if (!ds.length) return BUS_VMAX;
  const avg = ds.reduce((a, b) => a + b, 0) / ds.length;
  const t = Math.max(0, Math.min(1, (avg - SP_LOCAL) / (SP_EXPRESS - SP_LOCAL)));
  return BUS_VMAX_LOCAL + t * (BUS_VMAX - BUS_VMAX_LOCAL);
}
function busSegMin(distM, vmaxKmh) {
  const vmax = vmaxKmh / 3.6;
  const tA = vmax / BUS_ACCEL, dA = 0.5 * BUS_ACCEL * tA * tA;
  if (distM < dA) return Math.sqrt((2 * distM) / BUS_ACCEL) / 60;
  return (tA + (distM - dA) / vmax) / 60;
}
// 与 app.js estimateRideMinutes 同源（单向线只沿前进方向，反向返回 null）
function rideMinutes(line, iFrom, iTo) {
  if (line.oneWay && !line.isLoop && iFrom > iTo) return null; // 单向公交不可反向
  const lo = Math.min(iFrom, iTo), hi = Math.max(iFrom, iTo);
  let rideMin = 0, segs = 0;
  for (let i = lo; i < hi; i++) {
    const d = line.stops[i].d;
    if (typeof d === 'number' && d > 0) {
      segs++;
      rideMin += line.mode === 'metro' ? (d / METRO_SPEED) * 60 : busSegMin(d * 1000, busVmaxForLine(line));
    }
  }
  if (segs === 0) return null;
  const dwell = line.mode === 'metro' ? METRO_DWELL : BUS_DWELL;
  return rideMin + segs * dwell;
}
function waitOf(line) { return line.mode === 'metro' ? METRO_WAIT : BUS_WAIT; }
function transferOf(a, b) {
  if (a.mode !== b.mode) return B2M;
  return a.mode === 'metro' ? M2M : B2B;
}

// 收集某点 1.5km 内的 (line, stopIndex) 候选
function reachable(line) {
  return (line.stops || []).map((s, i) => ({ physId: s.id, i, lng: Number(s.lng), lat: Number(s.lat) }));
}

function main() {
  // 北京拆上下行后寻路图变大，单次 Dijkstra 约 1.5s；N=30 即约 45s。样本数减少但仍有统计意义。
  const N = 30;
  const pool = [];
  const seen = new Set();
  for (const line of data.lines) for (const s of line.stops || []) {
    const k = s.lng.toFixed(5) + ',' + s.lat.toFixed(5);
    if (!seen.has(k)) { seen.add(k); pool.push([Number(s.lng), Number(s.lat)]); }
  }
  function randomPoint() {
    const p = pool[Math.floor(Math.random() * pool.length)];
    const a = Math.random() * 2 * Math.PI, d = 300 + Math.random() * 1200;
    return [p[0] + (d * Math.sin(a)) / 85000, p[1] + (d * Math.cos(a)) / 111000];
  }
  const walkFn = (a, b) => {
    const km = haversineKm(a, b);
    return Promise.resolve({ dist: km * 1000, min: (km * 1000) / 75 });
  };

  // 预建索引：物理站 id -> {line, i}
  const physIndex = new Map(); // physId -> [{line, i}]
  for (const line of data.lines) {
    for (let i = 0; i < (line.stops || []).length; i++) {
      const sid = String(line.stops[i].id);
      if (!physIndex.has(sid)) physIndex.set(sid, []);
      physIndex.get(sid).push({ line, i });
    }
  }

  (async function run() {
    let worseCount = 0, maxGap = 0, checked = 0;
    for (let t = 0; t < N; t++) {
      let o, d, km;
      do { o = randomPoint(); d = randomPoint(); km = haversineKm(o, d); } while (km < 5);

      const r = await R.findOptimalRoute(graph, o, d, { allowMetro: true }, walkFn);
      if (!r) continue;
      checked++;

      // 玩家候选：1.5km 内所有 (line, index)
      const boards = [];
      for (const line of data.lines) {
        for (let i = 0; i < (line.stops || []).length; i++) {
          const s = line.stops[i];
          if (haversineKm(o, [Number(s.lng), Number(s.lat)]) <= MAX_WALK_KM) boards.push({ line, i });
        }
      }
      const alights = [];
      for (const line of data.lines) {
        for (let i = 0; i < (line.stops || []).length; i++) {
          const s = line.stops[i];
          if (haversineKm(d, [Number(s.lng), Number(s.lat)]) <= MAX_WALK_KM) alights.push({ line, i });
        }
      }

      // 玩家最优（0 次换乘：同一条线上车→下车）
      let playerBest = Infinity;
      // 预索引 alights 按线路 id 分组：1 次换乘枚举里避免对全部 alights 重复扫描
      //（数据拆上下行后线路数翻倍，不索引的话 1 次换乘穷举会退化到 80s+）
      const alightsByLine = new Map();
      for (const a of alights) {
        if (!alightsByLine.has(a.line.id)) alightsByLine.set(a.line.id, []);
        alightsByLine.get(a.line.id).push(a);
      }
      for (const b of boards) {
        const ride = null; // placeholder
        // 同线直达：遍历该线所有可达下车站
        for (const a of alightsByLine.get(b.line.id) || []) {
          const rideMin = rideMinutes(b.line, b.i, a.i);
          if (rideMin == null) continue;
          const wTo = haversineKm(o, [b.line.stops[b.i].lng, b.line.stops[b.i].lat]) * 1000 / 75;
          const wFrom = haversineKm([a.line.stops[a.i].lng, a.line.stops[a.i].lat], d) * 1000 / 75;
          const total = wTo + waitOf(b.line) + rideMin + wFrom;
          if (total < playerBest) playerBest = total;
        }
      }
      // 1 次换乘：两条线在同一物理站/逻辑站衔接
      for (const b of boards) {
        const wTo = haversineKm(o, [b.line.stops[b.i].lng, b.line.stops[b.i].lat]) * 1000 / 75;
        // 换乘点：该线上 b.i 之后的每一站
        for (let k = b.i + 1; k < b.line.stops.length; k++) {
          const mid = b.line.stops[k];
          const ride1 = rideMinutes(b.line, b.i, k);
          if (ride1 == null) continue;
          const links = physIndex.get(String(mid.id)) || [];
          for (const lk of links) {
            if (lk.line.id === b.line.id) continue;
            for (const a of alightsByLine.get(lk.line.id) || []) {
              const ride2 = rideMinutes(lk.line, lk.i, a.i);
              if (ride2 == null) continue;
              const wFrom = haversineKm([a.line.stops[a.i].lng, a.line.stops[a.i].lat], d) * 1000 / 75;
              const total = wTo + waitOf(b.line) + ride1 + transferOf(b.line, lk.line) + waitOf(lk.line) + ride2 + wFrom;
              if (total < playerBest) playerBest = total;
            }
          }
        }
      }

      if (playerBest < Infinity) {
        const gap = r.totalMin - playerBest;
        if (gap > 0.5) {
          worseCount++;
          if (gap > maxGap) maxGap = gap;
          if (worseCount <= 3) {
            console.log('❌ 最优被玩家击败：optimal=' + r.totalMin.toFixed(1) +
              ' player=' + playerBest.toFixed(1) + ' gap=' + gap.toFixed(1) +
              ' origin=' + JSON.stringify(o) + ' dest=' + JSON.stringify(d));
          }
        }
      }
    }
    console.log('\n===== 验证结果（' + checked + ' 对，含 0/1 次换乘穷举） =====');
    console.log('最优被玩家击败的样本：' + worseCount + ' 个');
    console.log('最大差距：' + maxGap.toFixed(1) + ' 分钟');
    console.log(worseCount === 0 ? '✅ 通过：系统最优始终 ≤ 玩家可达方案' : '❌ 仍有问题');
  })();
}

main();
