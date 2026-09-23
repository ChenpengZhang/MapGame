/**
 * core/router-api.js —— 对 shared/router.js 的唯一引用点（适配层）
 *
 * 【为什么要有这个文件】
 *   shared/router.js 是一个独立的 UMD 模块（Node 里 require、浏览器里挂 window.TransitRouter），
 *   它属于"纯算法层"，不参与本次前端分层，保持原样不动。
 *   为了不让 window.TransitRouter 这种隐式全局散落在十几个文件里，
 *   全项目只在这里取用它一次；将来若把 router.js 改成 ES Module，
 *   也只需要改这一个文件。
 *
 * 依赖：index.html 中 load 的顺序保证 router.js 先于本模块执行（普通 <script> 先跑，
 *       type="module" 的模块是延迟执行的）。
 */

/** 取寻路器实例；未加载时抛出可读的错误（而不是 undefined.xxx） */
function R() {
  const router = typeof window !== 'undefined' ? window.TransitRouter : null;
  if (!router) throw new Error('shared/router.js 未加载：请检查 index.html 的脚本顺序');
  return router;
}

/** 寻路、玩家计时与站点索引共用的默认参数（唯一来源是 shared/router.js）。 */
export const DEFAULT_PARAMS = Object.freeze({ ...R().DEFAULT_PARAMS });

/**
 * 构建寻路图（供最优路线计算）。
 * @param {Array} lines 线路数组（data.lines）
 */
export function buildGraph(lines) {
  return R().buildGraph(lines);
}

/** 单段乘车时间；前端玩家计时与系统最优共用同一公式。 */
export function segmentRideMin(line, distanceKm, opts = {}) {
  return R().segmentRideMin(line, distanceKm, { ...DEFAULT_PARAMS, ...opts });
}

/** 某条线路上两个逻辑站之间的乘车统计。 */
export function rideStatsBetween(graph, line, fromLogicalId, toLogicalId, opts = {}) {
  return R().rideStatsBetween(graph, line, fromLogicalId, toLogicalId, { ...DEFAULT_PARAMS, ...opts });
}

/**
 * 计算最优路线（Dijkstra，见 router.js 头注释）。
 * @param {object} graph buildGraph 的结果
 * @param {[number,number]} origin 起点 [lng,lat]
 * @param {[number,number]} dest 终点 [lng,lat]
 * @param {object} opts { allowMetro, busSpeedFactor }
 * @param {Function} walkFn (a,b) => Promise<{dist(米), min(分钟)}>
 */
export function findOptimalRoute(graph, origin, dest, opts, walkFn) {
  return R().findOptimalRoute(graph, origin, dest, opts, walkFn);
}

/**
 * 球面距离（公里）。全项目所有"两点距离"都用它，保证与寻路器口径一致。
 */
export function haversineKm(a, b) {
  return R().haversineKm(a, b);
}
