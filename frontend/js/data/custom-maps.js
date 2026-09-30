/**
 * data/custom-maps.js —— 自定义关卡组的共享规则（前端与后端共用，纯数据与纯函数，无 DOM 依赖）
 *
 * 一个关卡组（custom map）= 标题、说明、公开范围 + 1~10 个关卡。每个关卡：
 *   { city, origin:[lng,lat], dest:[lng,lat], originName?, destName?,
 *     scenario, timeLimit: null | {type:'minutes', value} | {type:'ratio', value}, title?, text? }
 *
 * 计分：每关满分 5000 = 最优用时 / 你的用时（最多 5000）；超过时限记 0 分。
 * 时限：'minutes' 为固定分钟数；'ratio' 为最优用时的倍数（如 1.5 = 可比最优慢 50%）。
 */

export const CUSTOM_LIMITS = Object.freeze({
  maxLevels: 10,
  maxMapsPerUser: 30,
  titleMax: 40,
  descriptionMax: 300,
  levelTitleMax: 30,
  levelTextMax: 200,
  placeNameMax: 20,
  minDistanceKm: 1.6, // 起终点至少相距 1.6km：更近的话可以直接步行，没有乘车路线可验证
  minutesMin: 1,
  minutesMax: 300,
  ratioMin: 1.01,
  ratioMax: 5,
});

export const MAX_LEVEL_SCORE = 5000;

/** 编辑器可选的情景（与无尽模式相同的 6 种） */
export const CUSTOM_SCENARIO_KEYS = ['normal', 'noMetro', 'busBoost', 'rain', 'blind', 'realRide'];

/** 本关时限（毫秒）；无时限返回 null */
export function customLimitMs(timeLimit, optimalDurationMs) {
  if (!timeLimit) return null;
  if (timeLimit.type === 'minutes') return Math.round(timeLimit.value * 60000);
  if (timeLimit.type === 'ratio') return Math.ceil(optimalDurationMs * timeLimit.value);
  return null;
}

/** 单关得分：超时 0 分；否则按最优/实际等比，最多满分 */
export function customLevelScore(durationMs, optimalDurationMs, limitMs = null) {
  if (!(durationMs > 0) || !(optimalDurationMs > 0)) return 0;
  if (limitMs != null && durationMs > limitMs) return 0;
  return Math.round(MAX_LEVEL_SCORE * Math.min(1, optimalDurationMs / durationMs));
}

/** 时限的简短描述（HUD / 列表用） */
export function describeTimeLimit(timeLimit) {
  if (!timeLimit) return '不限时';
  if (timeLimit.type === 'minutes') return `≤ ${timeLimit.value} 分钟`;
  return `≤ 最速 ${Math.round(timeLimit.value * 100)}%`;
}
