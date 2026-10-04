/**
 * core/rivers.js —— 当前城市的江河（禁止步行过江）
 *
 * 对 shared/rivers.js（UMD，挂 window.TransitRivers）的唯一引用点。数据按城市懒加载：
 * data/rivers/<city>.json 存在的城市（武汉、重庆）才有江河，其余城市所有判断都返回“不过江”。
 * 规则与服务端一致：一段直线步行穿过江河中心线即视为过江，不允许。
 */

import { DATA_VERSION } from './config.js';

let index = null;

function lib() {
  return typeof window !== 'undefined' ? window.TransitRivers || null : null;
}

/** 加载某城市的江河数据（没有该城市的文件时视为无江河） */
export async function loadRivers(cityId) {
  index = null;
  const R = lib();
  if (!R || typeof fetch !== 'function') return null;
  try {
    const res = await fetch(`data/rivers/${cityId}.json?v=${DATA_VERSION}`);
    if (!res.ok) return null;
    index = R.buildRiverIndex(await res.json());
  } catch {
    index = null;
  }
  return index;
}

/** 给寻路图挂上过江判断（shared/router.js 据此跳过过江的上/下车站） */
export function attachRiversToGraph(graph) {
  if (!graph) return;
  graph.rivers = index ? { crosses: (a, b) => crossesRiver(a, b) } : null;
}

/** 从 a 直线步行到 b 是否要过江 */
export function crossesRiver(a, b) {
  const R = lib();
  return !!(index && R && R.crossesRiver(index, a, b));
}

/** 步行范围圆按江截断后的多边形；范围内没有江时返回 null */
export function clipWalkRange(center, radiusM) {
  const R = lib();
  return index && R ? R.clipWalkRange(index, center, radiusM) : null;
}

/** 当前城市是否有江河数据 */
export function hasRivers() {
  return !!index;
}
