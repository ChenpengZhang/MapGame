/**
 * map/stop-marks.js —— 站点图元工厂（站点图标 + MassMarks 图层构造）
 *
 * 【为什么单独抽出来】
 *   基础站点层（stop-layer.js）和候选站点层（game/route.js）画的是同一种"海量小圆点"，
 *   都用高德 MassMarks（一次绘制上万个点，比一个个 Marker 快得多）。
 *   把"怎么造一个站点图层"集中在这里，两处保持完全一致的样式与数据结构，
 *   也避免 game 层为了造图层去 import 整个 stop-layer。
 *
 * 数据格式（stopToData 的输出）就是高德 MassMarks 要求的 { lnglat, style, ... }，
 * 其中 style=0 表示地铁（大橙点）、style=1 表示公交（小蓝点）、style=2 表示步行（小红点）。
 */

import { METRO_STOP_COLOR, BUS_STOP_COLOR, WALK_STOP_COLOR } from '../core/config.js';

const METRO_DOT_SIZE = 12;
const BUS_DOT_SIZE = 7;
const WALK_DOT_SIZE = 6;

let _icons = null;

/** 地铁/公交/步行可达圆点图标（懒生成一次，转成 dataURL 复用） */
function getIcons() {
  if (!_icons) {
    _icons = {
      metroIcon: circleIcon(METRO_STOP_COLOR, METRO_DOT_SIZE),
      busIcon: circleIcon(BUS_STOP_COLOR, BUS_DOT_SIZE),
      walkIcon: circleIcon(WALK_STOP_COLOR, WALK_DOT_SIZE),
    };
  }
  return _icons;
}

/**
 * 造一个空的站点图层（MassMarks）。数据用 setData 填充。
 * __baseOpacity 供 anim.js 的淡入淡出还原透明度用。
 * style：0=地铁（大橙点）、1=公交（小蓝点）、2=步行可达（小红点）。
 */
export function makeMassMarks(data, options = {}) {
  const { metroIcon, busIcon, walkIcon } = getIcons();
  const allowWalkStyle = options.allowWalkStyle !== false;
  const styles = [
    { url: metroIcon, size: new AMap.Size(METRO_DOT_SIZE, METRO_DOT_SIZE), anchor: new AMap.Pixel(METRO_DOT_SIZE / 2, METRO_DOT_SIZE / 2) },
    { url: busIcon, size: new AMap.Size(BUS_DOT_SIZE, BUS_DOT_SIZE), anchor: new AMap.Pixel(BUS_DOT_SIZE / 2, BUS_DOT_SIZE / 2) },
    // 关闭步行换乘的图层根本不装载红色步行图标；即使意外收到 style=2 也回退为蓝点。
    { url: allowWalkStyle ? walkIcon : busIcon, size: new AMap.Size(WALK_DOT_SIZE, WALK_DOT_SIZE), anchor: new AMap.Pixel(WALK_DOT_SIZE / 2, WALK_DOT_SIZE / 2) },
  ];
  if (options.inverseLineStops) {
    const styleByKey = new Map();
    for (const point of data) {
      if (point.style === 2 || !point.lineColor) continue;
      const size = point.mode === 'metro' ? METRO_DOT_SIZE : BUS_DOT_SIZE;
      const key = `${point.lineColor}|${size}`;
      if (!styleByKey.has(key)) {
        styleByKey.set(key, styles.length);
        const icon = circleIcon(point.lineColor, size, true);
        styles.push({ url: icon, size: new AMap.Size(size, size), anchor: new AMap.Pixel(size / 2, size / 2) });
      }
      point.style = styleByKey.get(key);
    }
  }
  const mm = new AMap.MassMarks(data, {
    opacity: 0.9,
    // 候选站点需高于线路的透明点击热区（route.js 使用 181/191），
    // 否则原生高德地图会先命中线路，无法点击在线路上的地铁站换乘。
    zIndex: options.zIndex ?? 110,
    style: styles,
    // 纯展示层（如悬浮预览线路上的站点）不生成命中区，避免抢走下层站点的悬浮/点击。
    interactive: options.interactive !== false,
  });
  mm.__baseOpacity = 0.9;
  return mm;
}

/**
 * 物理点 → MassMarks 数据。
 * 事件回调里的 e.data 就是这里的对象（因此带上 logicalId，便于反查逻辑站）。
 * @param {object} p 物理点
 * @param {boolean} walkable 是否"步行可达站"（style=2，红色）
 */
export function stopToData(p, walkable, lineColor = null) {
  return {
    lnglat: [p.lng, p.lat],
    style: walkable ? 2 : (p.mode === 'metro' ? 0 : 1),
    id: p.id,
    name: p.name,
    mode: p.mode,
    logicalId: p.logicalId,
    lineColor,
  };
}

/** 画一个带白边的实心圆，返回 dataURL（用作 MassMarks 的图标） */
function circleIcon(color, size, inverse = false) {
  const radius = size / 2;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(radius, radius, Math.max(1, radius - 1), 0, Math.PI * 2);
  ctx.fillStyle = inverse ? '#ffffff' : color;
  ctx.fill();
  ctx.lineWidth = inverse ? 2 : 1.5;
  ctx.strokeStyle = inverse ? color : '#ffffff';
  ctx.stroke();
  return c.toDataURL();
}
