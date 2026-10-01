/**
 * ui/settings-preview.js —— 设置页右侧的效果预览（纯渲染：输入设置值，输出 HTML/SVG 字符串）
 *
 * 每个设置项一张示意图，随当前取值实时变化（例如公交站显示级别会标出从第几级开始出现公交站）。
 * 配色与游戏地图一致：地铁站橙、公交站蓝、步行可达站红、地铁底图浅粉灰。
 */

import { FONT_SCALES } from '../core/settings.js';

const C = {
  land: '#ecebe4', road: '#ffffff', roadEdge: '#d8d6cc', water: '#b9d3e6', park: '#cfe3c3',
  metroBase: '#e7b7b1', metro: '#f39c12', bus: '#3b82f6', walk: '#e74c3c', ink: '#1f2937', muted: '#6b7280',
};

/** 一小块示意地图：道路、水面、公园；metroLines 为 true 时叠加灰色地铁底图 */
function mapTile(x, y, w, h, { metroLines = false, busStops = false, metroStops = true, id = 't' } = {}) {
  const clip = `clip-${id}`;
  const px = (fx) => x + fx * w, py = (fy) => y + fy * h;
  const parts = [
    `<clipPath id="${clip}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/></clipPath>`,
    `<g clip-path="url(#${clip})">`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${C.land}"/>`,
    `<path d="M${px(0)} ${py(0.78)} Q ${px(0.35)} ${py(0.62)} ${px(0.6)} ${py(0.86)} T ${px(1)} ${py(0.8)} L ${px(1)} ${py(1)} L ${px(0)} ${py(1)} Z" fill="${C.water}"/>`,
    `<rect x="${px(0.62)}" y="${py(0.12)}" width="${w * 0.22}" height="${h * 0.22}" rx="3" fill="${C.park}"/>`,
  ];
  for (const f of [0.28, 0.55]) parts.push(`<line x1="${x}" y1="${py(f)}" x2="${x + w}" y2="${py(f)}" stroke="${C.roadEdge}" stroke-width="5"/><line x1="${x}" y1="${py(f)}" x2="${x + w}" y2="${py(f)}" stroke="${C.road}" stroke-width="3.5"/>`);
  for (const f of [0.22, 0.5, 0.8]) parts.push(`<line x1="${px(f)}" y1="${y}" x2="${px(f)}" y2="${y + h}" stroke="${C.roadEdge}" stroke-width="5"/><line x1="${px(f)}" y1="${y}" x2="${px(f)}" y2="${y + h}" stroke="${C.road}" stroke-width="3.5"/>`);
  if (metroLines) {
    parts.push(`<polyline points="${px(0)},${py(0.4)} ${px(0.3)},${py(0.4)} ${px(0.5)},${py(0.2)} ${px(1)},${py(0.2)}" fill="none" stroke="${C.metroBase}" stroke-width="3" stroke-opacity=".9"/>`);
    parts.push(`<polyline points="${px(0.35)},${py(0)} ${px(0.35)},${py(0.55)} ${px(0.7)},${py(0.7)} ${px(0.7)},${py(1)}" fill="none" stroke="${C.metroBase}" stroke-width="3" stroke-opacity=".9"/>`);
  }
  if (metroStops) {
    for (const [fx, fy] of [[0.3, 0.4], [0.5, 0.2], [0.35, 0.55]]) parts.push(`<circle cx="${px(fx)}" cy="${py(fy)}" r="4.5" fill="${C.metro}" stroke="#fff" stroke-width="1.5"/>`);
  }
  if (busStops) {
    for (const [fx, fy] of [[0.12, 0.28], [0.22, 0.45], [0.66, 0.28], [0.8, 0.4], [0.5, 0.64], [0.9, 0.55], [0.15, 0.62], [0.8, 0.12]]) {
      parts.push(`<circle cx="${px(fx)}" cy="${py(fy)}" r="3" fill="${C.bus}" stroke="#fff" stroke-width="1.2"/>`);
    }
  }
  parts.push('</g>');
  return parts.join('');
}

const svg = (body, h = 200) => `<svg class="settings-preview-svg" viewBox="0 0 360 ${h}" role="img" aria-hidden="true">${body}</svg>`;
const label = (x, y, text, { anchor = 'middle', size = 11, color = C.muted, weight = 600 } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${color}">${text}</text>`;

function walkTransferPreview(on) {
  const path = 'M 110 110 L 170 110 L 170 80 L 250 80';
  return svg(`
    ${mapTile(20, 15, 320, 160, { metroLines: true, id: 'wt' })}
    <path d="${path}" fill="none" stroke="${on ? C.walk : '#9ca3af'}" stroke-width="3" stroke-dasharray="5 5"/>
    <circle cx="110" cy="110" r="7" fill="${C.bus}" stroke="#fff" stroke-width="2"/>
    <circle cx="250" cy="80" r="7" fill="${on ? C.walk : C.bus}" stroke="#fff" stroke-width="2"/>
    ${label(110, 132, '12路 · 下车', { color: C.ink })}
    ${label(250, 68, '换乘 35路', { color: C.ink })}
    ${on
      ? `<circle r="5" fill="${C.walk}" stroke="#fff" stroke-width="1.5"><animateMotion dur="2.4s" repeatCount="indefinite" path="${path}"/></circle>
         ${label(180, 192, '1.5 公里内可步行到另一站换乘，按步行速度计时', { color: C.ink })}`
      : `<g stroke="${C.walk}" stroke-width="3"><line x1="164" y1="89" x2="176" y2="101"/><line x1="176" y1="89" x2="164" y2="101"/></g>
         ${label(180, 192, '关闭：只能在同一站换乘')}`}`);
}

/** 真实截图（scripts/capture-settings-previews.mjs 生成）：东单一带正好缩放到该级别时的样子 */
function busZoomPreview(threshold) {
  return `<figure class="pv-shot"><img src="assets/settings/bus-zoom-${threshold}.jpg" alt="">
    <figcaption>缩放到 ${threshold} 级：公交站开始显示</figcaption></figure>`;
}

function metroBasePreview(on) {
  return svg(`${mapTile(20, 12, 320, 160, { metroLines: on, id: 'mb' })}
    ${label(180, 192, on ? '显示：灰色地铁线路帮助辨认城市骨架' : '隐藏：只保留地铁站点，地图更干净', { color: C.ink })}`);
}

/** 真实截图：同一位置、同样大小的截取范围，字号越大能看到的内容越少 */
function fontScalePreview(scale) {
  const name = scale in FONT_SCALES ? scale : 'normal';
  return `<figure class="pv-shot"><img src="assets/settings/font-${name}.jpg" alt=""></figure>`;
}

/** 真实截图：同一地点（北京建国门一带）的两种底图 */
function amapPreview() {
  return `<div class="pv-compare">
    <figure class="pv-shot"><img src="assets/settings/osm-sample.jpg" alt=""><figcaption>OpenStreetMap（默认）</figcaption></figure>
    <figure class="pv-shot"><img src="assets/settings/amap-sample.jpg" alt=""><figcaption>高德地图</figcaption></figure>
  </div>`;
}

/** 预览内容表：标题、说明、渲染函数（入参为当前取值） */
export const PREVIEWS = {
  zoomSpeed: { title: '缩放速度', desc: '控制滚轮缩放地图的快慢。数值越大，滚动一格缩放得越多。（使用高德地图时由高德自身控制。）', render: null },
  walkTransfer: {
    title: '步行换乘',
    desc: '允许在 1.5 公里内下车后步行到另一站换乘，按步行速度计时。系统“最优”不计算远距离步行换乘，开启后可能规划出比最优还快的路线。',
    render: walkTransferPreview,
  },
  busMinZoom: {
    title: '公交站显示级别',
    desc: '地图放大到这个级别后才显示公交站。数字越小，缩得越远也能看到公交站，但大城市站点密集，缩放和拖动可能变慢。',
    render: busZoomPreview,
  },
  metroBase: { title: '地铁底图', desc: '在地图上用浅灰色画出全部地铁线路，帮助辨认城市骨架。盲棋和地铁瘫痪情景下始终不显示。', render: metroBasePreview },
  fontScale: { title: '字号', desc: '放大路线规划、站牌、提示和结算等界面文字，地图本身不受影响。', render: fontScalePreview },
  amapKey: { title: '高德地图 Key', desc: '默认使用免 Key 的 OpenStreetMap 底图。填写自己的高德 Key 并保存后会刷新页面，改用高德底图。', render: amapPreview },
};
