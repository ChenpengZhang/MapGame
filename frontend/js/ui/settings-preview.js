/**
 * ui/settings-preview.js —— 设置页右侧的效果预览（纯渲染：输入设置值，输出 HTML）
 *
 * 每个设置项一张真实截图（frontend/assets/settings/），随当前取值切换（例如公交站显示级别、字号）。
 * 公交站显示级别与 OSM 底图由 scripts/capture-settings-previews.mjs 生成，其余为手动截取。
 */

import { FONT_SCALES } from '../core/settings.js';

// 截图是压缩后的 WebP（scripts/compress-settings-previews.py 生成）。带版本号走一年强缓存：
// 切换设置项时预览会重建 <img>，不带版本号的资源服务器回 no-store，每次都会重新下载。换图时把版本号加一。
const SHOT_VERSION = 1;
const shotUrl = (name) => `assets/settings/${name}.webp?v=${SHOT_VERSION}`;

/** 一张截图 + 左下角说明；预览框固定为字号示意图的比例，截图铺满裁切（见 css/screens.css） */
function shot(src, caption = '') {
  return `<figure class="pv-shot"><img src="${shotUrl(src)}" alt="" decoding="async">`
    + (caption ? `<figcaption>${caption}</figcaption>` : '') + '</figure>';
}

/** 真实截图：步行换乘（绿色虚线）——下车后步行到附近另一站换乘 */
function walkTransferPreview(on) {
  return shot('walk-transfer', on ? '已开启：虚线为步行换乘' : '已关闭：只能在同一站换乘');
}

/** 真实截图（scripts/capture-settings-previews.mjs 生成）：东单一带正好缩放到该级别时的样子 */
function busZoomPreview(threshold) {
  return shot(`bus-zoom-${threshold}`, `缩放到 ${threshold} 级：公交站开始显示`);
}

/** 真实截图：同一位置开 / 关地铁底图 */
function metroBasePreview(on) {
  return shot(on ? 'metro-on' : 'metro-off', on ? '显示地铁底图' : '隐藏地铁底图');
}

/** 真实截图：同一局游戏三种字号，站牌在左上角 */
function fontScalePreview(scale) {
  const name = scale in FONT_SCALES ? scale : 'normal';
  return shot(`font-${name}`);
}

/** 真实截图：同一地点（北京建国门一带）的两种底图 */
function amapPreview() {
  return `<div class="pv-compare">
    ${shot('osm-sample', 'OpenStreetMap（默认）')}
    ${shot('amap-sample', '高德地图')}
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
  focusOnConfirm: {
    title: '确认后自动缩放',
    desc: '每确认一个站点，地图自动缩放到所有可达的站；已到终点附近时缩放到终点的步行范围。关闭后地图保持当前视野。',
    render: null,
  },
  collectTraces: {
    title: '匿名记录规划过程',
    desc: '为了改进关卡和交互，游戏会记录每局的规划过程：预览和确认了哪些站、选了哪些线路、撤回和用时，以及最终路线和屏幕尺寸等设备信息。'
      + '不记录姓名、邮箱、位置等个人信息；未登录时只用一个随机生成的匿名编号区分浏览器，登录后会关联到你的游玩记录。关闭后不再记录。',
    render: null,
  },
  amapKey: { title: '高德地图 Key', desc: '默认使用免 Key 的 OpenStreetMap 底图。填写自己的高德 Key 并保存后会刷新页面，改用高德底图。', render: amapPreview },
};
