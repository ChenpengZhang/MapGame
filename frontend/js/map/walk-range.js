/**
 * map/walk-range.js —— 起终点步行范围的几何与绘制
 *
 * 范围判定、圆圈半径和视野边界统一使用 MAX_WALK_M，避免地图提示圈、
 * 站点着色和实际可选距离各写一套数值后逐渐不一致。
 */

import { MAX_WALK_M } from '../core/config.js';
import { haversineKm } from '../core/router-api.js';
import { crossesRiver, clipWalkRange } from '../core/rivers.js';

/** 物理站或 [lng,lat] 是否位于指定步行范围内。 */
export function isWithinWalkRange(point, center, radiusM = MAX_WALK_M) {
  if (!point || !center) return false;
  const lnglat = Array.isArray(point) ? point : (point.lnglat || [point.lng, point.lat]);
  if (!Number.isFinite(lnglat[0]) || !Number.isFinite(lnglat[1])) return false;
  // 江对岸的站不算步行可达（武汉、重庆等有江河数据的城市，见 core/rivers.js）
  return haversineKm(center, lnglat) * 1000 <= radiusM && !crossesRiver(center, lnglat);
}

/** 创建一个不拦截地图交互的红色步行范围圈；圈内有江时画成按江截断的形状。 */
export function createWalkRangeCircle(center, radiusM = MAX_WALK_M) {
  const ring = clipWalkRange(center, radiusM);
  if (ring && AMap.Polygon) {
    return new AMap.Polygon({
      path: ring,
      strokeColor: '#e74c3c',
      strokeWeight: 2,
      strokeOpacity: 0.85,
      fillColor: '#e74c3c',
      fillOpacity: 0.06,
      zIndex: 70,
      interactive: false,
      bubble: true,
    });
  }
  return new AMap.Circle({
    center,
    radius: radiusM,
    strokeColor: '#e74c3c',
    strokeWeight: 2,
    strokeOpacity: 0.85,
    fillColor: '#e74c3c',
    fillOpacity: 0.06,
    zIndex: 70,
    interactive: false,
  });
}

/** 返回能容纳若干步行范围圆的经纬度边界。 */
export function walkRangeBounds(centers, radiusM = MAX_WALK_M) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const center of centers || []) {
    if (!center) continue;
    const latRad = center[1] * Math.PI / 180;
    const dLat = radiusM / 111000;
    const dLng = radiusM / Math.max(1, 111320 * Math.cos(latRad));
    minLng = Math.min(minLng, center[0] - dLng);
    maxLng = Math.max(maxLng, center[0] + dLng);
    minLat = Math.min(minLat, center[1] - dLat);
    maxLat = Math.max(maxLat, center[1] + dLat);
  }
  return Number.isFinite(minLng) ? { sw: [minLng, minLat], ne: [maxLng, maxLat] } : null;
}
