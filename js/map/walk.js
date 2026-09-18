/**
 * map/walk.js —— 步行策略与步行结果获取
 *
 * 【当前策略：直线距离估计（不依赖任何外部服务）】
 *   步行时间 = 球面直线距离 / 75 m/min（受情景的 walkSpeedFactor 影响，如大雨降 50%）。
 *   这样离线、零 Key、零网络请求也能算，且与寻路器 router.js 用同一口径。
 *
 * 【文件结构】
 *   第 1 段：当前生效的步行策略（straightLineWalk / activeWalk / routerWalkFn）
 *   第 2 段：备用策略与高德步行封装（当前未被调用，保留备用——见每段前的说明）
 *
 * 注意：不要给 game 层直接暴露"高德步行"，因为最优点与玩家点必须用同一套步行口径，
 *       否则会出现"最优比玩家慢"的不变式破坏（项目里有 test-optimal-invariant.js 专门守这条）。
 */

import { state } from '../core/state.js';
import { WALK_SPEED_M_PER_MIN } from '../core/config.js';
import { readJSON, writeJSON, removeKey } from '../core/storage.js';
import { haversineKm } from '../core/router-api.js';

// ======================================================================
// 第 1 段：当前生效的步行策略
// ======================================================================

/**
 * 直线步行：球面直线距离 / 步行速度。
 * 步行速度受情景影响（如大雨减缓 50% → walkSpeedFactor 0.5）。
 * @returns {Promise<{dist:number, min:number, path:Array}>} dist 米，min 分钟，path 只有两个端点
 */
export function straightLineWalk(from, to) {
  const d = haversineKm(from, to) * 1000;
  const speed = WALK_SPEED_M_PER_MIN * state.scenario.walkSpeedFactor;
  return Promise.resolve({ dist: d, min: d / speed, path: [from, to] });
}

/**
 * 当前模式使用的步行策略：一律直线距离估计（含故事模式，不再调高德）。
 * 想换成别的策略（如直角距离、真实路网）只改这一个函数。
 */
export function activeWalk(from, to) {
  return straightLineWalk(from, to);
}

/**
 * 供寻路器使用的步行函数（router.js 只认这个签名）。
 * @returns {Promise<{dist:number, min:number}>}
 */
export function routerWalkFn(a, b) {
  return activeWalk(a, b).then((r) => ({ dist: r.dist, min: r.min }));
}

/**
 * 直角（曼哈顿）步行：|Δx| + |Δy|（备用策略，当前未被调用）。
 * 说明：北京纬度下 1° 经度约 85km、1° 纬度约 111km；
 *       该策略不乘 walkSpeedFactor，若要启用需先补齐情景系数。
 */
export function manhattanWalk(from, to) {
  const dx = Math.abs(from[0] - to[0]) * 85000;
  const dy = Math.abs(from[1] - to[1]) * 111000;
  const d = dx + dy;
  return Promise.resolve({ dist: d, min: d / WALK_SPEED_M_PER_MIN, path: [from, to] });
}

// ======================================================================
// 第 2 段：高德步行封装（⚠ 当前未接入，保留备用）
// ======================================================================
// 以下代码是早期"用高德 Walking 插件取真实步行折线"的实现：
// 带 localStorage 缓存（双向复用）、并发去重、失败兜底。
// 现在 activeWalk 固定走直线估计，所以这些函数没有任何调用点。
// 保留原因：将来若要用真实步行路网，直接改 activeWalk 调 getWalkResult 即可。
// 若确认不再需要，可整段删除（不影响任何现有功能）。

/** 高德步行缓存 key（v4 起每站距离按折线长度算，旧版本含错误分钟数，故换 key） */
const WALK_CACHE_KEY = 'amapWalkCache_v4';
const walkCache = new Map();     // key -> {path, dist, min, ts}
const walkInFlight = new Map();  // key -> Promise（并发去重）
let walking = null;              // AMap.Walking 实例

/** 启动时把本地缓存读进内存（并清理更早版本的脏缓存） */
export function loadWalkCache() {
  // 迁移：清除旧版本缓存（含错误分钟数的脏数据）
  removeKey('amapWalkCache_v1');
  removeKey('amapWalkCache_v2');
  removeKey('amapWalkCache_v3');
  const obj = readJSON(WALK_CACHE_KEY);
  if (obj) {
    for (const [k, v] of Object.entries(obj)) walkCache.set(k, v);
  }
}

/** 把内存缓存写回本地；超过 3.5MB 时按最旧优先删除 */
function saveWalkCache() {
  try {
    let obj = {};
    for (const [k, v] of walkCache) obj[k] = v;
    let s = JSON.stringify(obj);
    while (s.length > 3.5 * 1024 * 1024 && walkCache.size > 0) {
      let oldestK = null, oldestTs = Infinity;
      for (const [k, v] of walkCache) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestK = k; }
      }
      if (oldestK == null) break;
      walkCache.delete(oldestK);
      obj = {};
      for (const [k, v] of walkCache) obj[k] = v;
      s = JSON.stringify(obj);
    }
    writeJSON(WALK_CACHE_KEY, obj);
  } catch (e) { /* localStorage 不可用则忽略 */ }
}

function pointStr(pt) {
  return pt[0].toFixed(6) + ',' + pt[1].toFixed(6);
}

/** 双向复用：A→B 与 B→A 共享同一缓存（路径按 key 顺序存储，方向按需翻转） */
function walkKey(a, b) {
  const p1 = pointStr(a), p2 = pointStr(b);
  return p1 < p2 ? p1 + '|' + p2 : p2 + '|' + p1;
}

/** 懒加载高德 Walking 插件（不绑定 map，自己画虚线） */
function ensureWalking(cb) {
  if (walking) { cb(walking); return; }
  AMap.plugin('AMap.Walking', () => {
    walking = new AMap.Walking({});
    cb(walking);
  });
}

/** 步行距离/时间：直接用步行路径折线长度算（不依赖高德字段名/单位，稳定可靠） */
function pathLengthMeters(path) {
  if (!path || path.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += haversineKm(path[i - 1], path[i]) * 1000;
  }
  return total;
}

/** 把高德返回的 steps[].path 拍平成一串 [lng,lat] */
function collectWalkPath(route) {
  const pts = [];
  for (const step of route.steps || []) {
    for (const p of step.path || []) {
      const lng = typeof p.lng === 'number' ? p.lng : (p.getLng ? p.getLng() : p[0]);
      const lat = typeof p.lat === 'number' ? p.lat : (p.getLat ? p.getLat() : p[1]);
      if (typeof lng === 'number' && typeof lat === 'number') pts.push([lng, lat]);
    }
  }
  return pts;
}

/**
 * 取步行结果（复用缓存 / 并发去重 / 方向归一化），不画线；供玩家路线与寻路器共用。
 * ⚠ 当前未被调用（见文件头说明）。
 * @returns {Promise<{dist:number, min:number, path:Array|null}>}
 */
export function getWalkResult(from, to) {
  const key = walkKey(from, to);
  const keyFirst = key.split('|')[0];
  const reverse = pointStr(from) !== keyFirst;
  const orient = (path) => (path ? (reverse ? path.slice().reverse() : path) : null);

  const cached = walkCache.get(key);
  if (cached) return Promise.resolve({ dist: cached.dist, min: cached.min, path: orient(cached.path) });

  let p = walkInFlight.get(key);
  if (!p) {
    p = new Promise((resolve) => {
      ensureWalking((wk) => {
        wk.search(from, to, (status, result) => {
          let c = null;
          if (status === 'complete' && result.routes && result.routes[0]) {
            const r = result.routes[0];
            let path = collectWalkPath(r);
            if (reverse && path.length) path.reverse(); // 归一化：按 key 顺序存储
            let dist = pathLengthMeters(path);
            if (!(dist > 0)) dist = haversineKm(from, to) * 1000; // 折线为空→直线距离兜底
            c = { path: path.length >= 2 ? path : null, dist, min: dist / WALK_SPEED_M_PER_MIN, ts: Date.now() };
            console.log('[walk]', pointStr(from), '→', pointStr(to), '| 距离', Math.round(dist) + 'm', '| 时间', (dist / WALK_SPEED_M_PER_MIN).toFixed(1) + 'min', '| 折线点数', path.length);
            walkCache.set(key, c);
            saveWalkCache(); // 失败结果不缓存
          }
          walkInFlight.delete(key);
          if (c) {
            resolve({ dist: c.dist, min: c.min, path: c.path });
          } else {
            // 高德步行失败：直线距离兜底（不缓存，下次重试）
            const straight = haversineKm(from, to) * 1000;
            resolve({ dist: straight, min: straight / WALK_SPEED_M_PER_MIN, path: null });
          }
        });
      });
    });
    walkInFlight.set(key, p);
  }
  return p.then((c) => ({ dist: c.dist, min: c.min, path: orient(c.path) }));
}
