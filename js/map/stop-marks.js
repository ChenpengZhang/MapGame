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
 * 其中 style=0 表示地铁（大点、红色）、style=1 表示公交（小点、蓝色）。
 */

/** 地铁点颜色 / 公交点颜色 */
const METRO_DOT_COLOR = '#e74c3c';
const BUS_DOT_COLOR = '#3498db';

let _icons = null;

/** 地铁/公交圆点图标（懒生成一次，转成 dataURL 复用） */
function getIcons() {
  if (!_icons) _icons = { metroIcon: circleIcon(METRO_DOT_COLOR, 10), busIcon: circleIcon(BUS_DOT_COLOR, 7) };
  return _icons;
}

/**
 * 造一个空的站点图层（MassMarks）。数据用 setData 填充。
 * __baseOpacity 供 anim.js 的淡入淡出还原透明度用。
 */
export function makeMassMarks(data) {
  const { metroIcon, busIcon } = getIcons();
  const mm = new AMap.MassMarks(data, {
    opacity: 0.9,
    zIndex: 110,
    style: [
      { url: metroIcon, size: new AMap.Size(10, 10), anchor: new AMap.Pixel(5, 5) },
      { url: busIcon, size: new AMap.Size(7, 7), anchor: new AMap.Pixel(3.5, 3.5) },
    ],
  });
  mm.__baseOpacity = 0.9;
  return mm;
}

/**
 * 物理点 → MassMarks 数据。
 * 事件回调里的 e.data 就是这里的对象（因此带上 logicalId，便于反查逻辑站）。
 */
export function stopToData(p) {
  return {
    lnglat: [p.lng, p.lat],
    style: p.mode === 'metro' ? 0 : 1,
    id: p.id,
    name: p.name,
    mode: p.mode,
    logicalId: p.logicalId,
  };
}

/** 画一个带白边的实心圆，返回 dataURL（用作 MassMarks 的图标） */
function circleIcon(color, radius) {
  const size = radius * 2;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(radius, radius, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  return c.toDataURL();
}
