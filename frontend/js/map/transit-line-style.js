/**
 * map/transit-line-style.js —— 天津站牌式彩色线路图元。
 *
 * 所有可交互线路统一画成两层：深色彩线作外框，细白线反相压在中央。
 * 调用方负责把返回图元挂到地图和自己的生命周期数组中。
 */

export function makeTransitLineLayers({
  path,
  color,
  mode = 'bus',
  selected = false,
  zIndex = 180,
  interactive = false,
  lineName = '',
  onClick = null,
  opacity = 0.92,
}) {
  const outerWeight = mode === 'bus' ? (selected ? 8 : 6) : 9 + (selected ? 2 : 0);
  const innerWeight = mode === 'bus'
    ? 2
    : (selected ? 3.5 : 3);
  const common = { path, lineJoin: 'round', interactive };
  const outer = new AMap.Polyline({
    ...common,
    strokeColor: color,
    strokeWeight: outerWeight,
    strokeOpacity: opacity,
    zIndex,
  });
  const inner = new AMap.Polyline({
    ...common,
    strokeColor: '#ffffff',
    strokeWeight: innerWeight,
    strokeOpacity: Math.min(1, opacity + 0.06),
    zIndex: zIndex + 1,
  });
  for (const layer of [outer, inner]) {
    layer.__lineName = lineName;
    layer.__transitLineLayer = layer === outer ? 'outer' : 'inner';
    if (interactive && typeof onClick === 'function') layer.on('click', onClick);
  }
  return [outer, inner];
}
