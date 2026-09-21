/**
 * game/time-model.js —— 时间估计模型与评分（纯计算，不碰地图也不碰 DOM）
 *
 * 【为什么单独抽成一层】
 *   这是整个游戏最需要"校准"的部分（见 README 的 §成本模型校准）：
 *   它的输出直接决定玩家是否达标，也决定寻路器算出的最优解是否可信。
 *   抽成纯函数后可以：
 *     - 与 js/router.js 的 DEFAULT_PARAMS 逐项对照（两者必须一致）；
 *     - 用 node 脚本直接跑（calibrate.js / benchmark.js 的思路）。
 *
 * 【构成】
 *   总耗时 = 起点步行 + Σ(等车 + 乘车 + 换乘) + 终点步行
 *   乘车   = 段距/巡航速度 + 每站停站时间（公交还要算缓慢加速）
 *   所有系数都在 core/config.js，情景（禁地铁/公交加速/雨天）通过 state.scenario 生效。
 */

import { state } from '../core/state.js';
import {
  METRO_SPEED_KMH, METRO_DWELL_MIN, BUS_DWELL_MIN,
  BUS_VMAX_KMH, BUS_ACCEL_MPS2,
  METRO_WAIT_MIN, BUS_WAIT_MIN,
  METRO_METRO_TRANSFER_MIN, BUS_BUS_TRANSFER_MIN, BUS_METRO_TRANSFER_MIN,
  WALK_SPEED_M_PER_MIN,
} from '../core/config.js';
import { stopIndexInLine, distM } from '../data/index-builder.js';

/**
 * 公交车段行驶分钟（梯形加速：0→缓加速→线路巡航速度→匀速，路程=∫v dt）。
 * @param {number} distMeters 段距（米）
 * @param {number} vmaxKmh 该线路的巡航速度（由平均站间距决定，见 index-builder.busVmaxForLine）
 */
export function busSegmentMinutes(distMeters, vmaxKmh) {
  // 公交速度受情景影响（如加速 20% / 减缓 50%）
  const vmax = (vmaxKmh || BUS_VMAX_KMH) * state.scenario.busSpeedFactor / 3.6;
  const tAccel = vmax / BUS_ACCEL_MPS2;
  const dAccel = 0.5 * BUS_ACCEL_MPS2 * tAccel * tAccel;
  if (distMeters < dAccel) return Math.sqrt((2 * distMeters) / BUS_ACCEL_MPS2) / 60;
  return (tAccel + (distMeters - dAccel) / vmax) / 60;
}

/** 单段（两相邻站之间）行驶分钟，不含停站 */
export function segmentRideMinutes(line, distMeters) {
  if (line.mode === 'metro') return (distMeters / 1000 / METRO_SPEED_KMH) * 60;
  return busSegmentMinutes(distMeters, line.busVmaxKmh);
}

/**
 * 乘车统计：站数 / 距离 / 纯行驶分钟（不含停站与等车）。
 * 单向线（公交上下行/环线）只按前进方向走，反向返回 null（不可乘车）。
 * 双向线（地铁）仍按 min(线性, 绕环) 取短边。
 * @returns {{distanceKm:number, segments:number, hasDist:boolean, rideMin:number}|null}
 */
export function rideStats(line, from, to) {
  const ia = stopIndexInLine(line, from);
  const ib = stopIndexInLine(line, to);
  if (ia < 0 || ib < 0) return null;
  if (ia === ib) return { distanceKm: 0, segments: 0, hasDist: false, rideMin: 0 };
  const N = line.stops.length;

  function rangeStats(a, b) {
    let dist = 0, hasDist = false, rideMin = 0;
    for (let i = a; i < b; i++) {
      const d = line.stops[i].d;
      if (typeof d === 'number' && d > 0) {
        dist += d;
        hasDist = true;
        rideMin += segmentRideMinutes(line, d * 1000);
      }
    }
    return { dist, hasDist, rideMin, segs: b - a };
  }

  // 单向线：只沿 seq 前进方向乘车
  if (line.oneWay) {
    let best;
    if (ia < ib) {
      best = rangeStats(ia, ib);
    } else if (line.isLoop) {
      // 环线绕环（ia → 末站 → 首站 → ib）
      const seg1 = rangeStats(ia, N - 1);
      const seg2 = rangeStats(0, ib);
      best = {
        dist: seg1.dist + line.wrapDistKm + seg2.dist,
        hasDist: true,
        rideMin: seg1.rideMin + segmentRideMinutes(line, line.wrapDistKm * 1000) + seg2.rideMin,
        segs: seg1.segs + 1 + seg2.segs,
      };
    } else {
      // 反向不可达
      return null;
    }
    return { distanceKm: best.dist, segments: best.segs, hasDist: best.hasDist, rideMin: best.rideMin };
  }

  // 双向线：线性 vs 绕环（仅环线），取时间短的那个
  const lo = Math.min(ia, ib), hi = Math.max(ia, ib);
  const d1 = rangeStats(lo, hi);
  let d2 = null;
  if (line.isLoop && line.wrapDistKm > 0) {
    const seg1 = rangeStats(hi, N - 1);
    const seg2 = rangeStats(0, lo);
    d2 = {
      dist: seg1.dist + line.wrapDistKm + seg2.dist,
      hasDist: true,
      rideMin: seg1.rideMin + segmentRideMinutes(line, line.wrapDistKm * 1000) + seg2.rideMin,
      segs: seg1.segs + 1 + seg2.segs,
    };
  }

  const best = (d2 && d2.rideMin < d1.rideMin) ? d2 : d1;
  return { distanceKm: best.dist, segments: best.segs, hasDist: best.hasDist, rideMin: best.rideMin };
}

/** 乘车总分钟 = 行驶 + 停站（无距离数据时退回"站数 × 每站时长"兜底） */
export function estimateRideMinutes(line, from, to) {
  const st = rideStats(line, from, to);
  if (!st || !st.hasDist) {
    // 兜底：无距离数据时退回"站数 × 每站时长"
    const n = st ? st.segments : 1;
    return n * (line.mode === 'metro' ? 2.5 : 2.0);
  }
  const dwell = line.mode === 'metro' ? METRO_DWELL_MIN : BUS_DWELL_MIN;
  return st.rideMin + st.segments * dwell;
}

/** 等车时间（发车间隔/2 的粗略估计；每个乘车段算一次，含换乘后的重新等车） */
export function waitMin(line) {
  return line.mode === 'metro' ? METRO_WAIT_MIN : BUS_WAIT_MIN;
}

/** 换乘惩罚（按前后线路模式区分：公交↔公交不算时间，地铁↔地铁与公交↔地铁不同） */
export function transferPenaltyMin(lineA, lineB) {
  const m1 = lineA.mode, m2 = lineB.mode;
  if (m1 !== m2) return BUS_METRO_TRANSFER_MIN; // 公交↔地铁：下/上地铁
  return m1 === 'metro' ? METRO_METRO_TRANSFER_MIN : BUS_BUS_TRANSFER_MIN;
}

/**
 * 玩家当前路线的总耗时（分钟）。
 * 完成（finished）后才计入"末站→终点"的步行时间，未完成时只算到已选站点。
 * 路线链中 routeRides[i] === null 表示"步行换乘段"（下车步行到下一站，按步行速度计时）。
 */
export function computeTotalMinutes() {
  let total = state.walkToFirstMin;
  for (let i = 0; i < state.routeRides.length; i++) {
    const ride = state.routeRides[i];
    if (ride === null) {
      // 步行换乘段：上一站实际停靠点 → 下一站，直线距离 / 步行速度
      const p1 = state.routeStops[i].point;
      const p2 = state.routeStops[i + 1].point;
      const dM = distM({ lng: p1[0], lat: p1[1] }, { lng: p2[0], lat: p2[1] });
      total += dM / (WALK_SPEED_M_PER_MIN * state.scenario.walkSpeedFactor);
      continue;
    }
    total += waitMin(ride); // 等车
    total += estimateRideMinutes(ride, state.routeStops[i].logical, state.routeStops[i + 1].logical);
    if (i > 0) {
      const prevRide = state.routeRides[i - 1];
      if (prevRide !== null) total += transferPenaltyMin(prevRide, ride); // 换乘（步行段不计固定惩罚，已按实际步行计时）
    }
  }
  if (state.finished) total += state.walkToDestMin;
  return total;
}

/**
 * 评分：按"比最优慢多少"给档位（差距越小分越高）。
 * @param {number} gapRatio (玩家耗时 - 最优耗时) / 最优耗时
 */
export function scoreFor(gapRatio) {
  if (gapRatio <= 0.05) return { label: '完美', stars: '⭐⭐⭐', color: '#27ae60' };
  if (gapRatio <= 0.15) return { label: '优秀', stars: '⭐⭐', color: '#2980b9' };
  if (gapRatio <= 0.30) return { label: '良好', stars: '⭐', color: '#f39c12' };
  return { label: '还有差距', stars: '', color: '#c0392b' };
}
