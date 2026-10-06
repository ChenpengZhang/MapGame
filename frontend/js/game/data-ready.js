/**
 * game/data-ready.js —— 交通数据的按需加载（懒加载 + 幂等）
 *
 * 【背景】数据文件 data/beijing-transit.json 约 19MB。早期它在 app.js 的
 *   bootstrap 里跟着网页一起加载（首屏 fetch 全量数据），玩家要等数据下完才能玩。
 *   现在改成"玩家点了再下载"：进入故事/自由/爬塔任一模式菜单时才触发下载，
 *   同城再次开局直接复用；跨城故事关则卸载旧图层并重建索引。
 *   加载文案不写死文件大小，而是从响应头 Content-Length 动态读取（见 loadAll）。
 *
 * 【为什么放在 game 层】
 *   "数据 → 索引 → 寻路图 → 站点图层"这条组装链同时依赖 core/data/map 三层，
 *   game 层正好位于它们之上（依赖方向 core ← data ← map ← game），
 *   且 game/session.js、game/free.js 等入口需要调用它，故放在这里而非 app.js。
 *   （app.js 是组合根，game 层不能反向 import 它，会形成循环依赖。）
 *
 * 故事关卡用自身 cityId，自由/无尽模式仍用主页选择的城市。
 */

import { state } from '../core/state.js';
import { setStatus, showLoading, hideLoading, showError, setLoadingProgress } from '../core/dom.js';
import { buildGraph } from '../core/router-api.js';
import { loadTransitData, hasCachedTransitData, dropCachedTransitData } from '../data/loader.js';
import { buildIndex } from '../data/index-builder.js';
import { renderMetroContext, renderStops, disposeStops } from '../map/stop-layer.js';
import { removeOverlay } from '../map/anim.js';
import { waitForMap } from '../map/map-init.js';
import { onStopMouseOver, onStopMouseOut } from '../map/hover.js';
import { onStopClick, cancelRoutePreview, resetRoute } from './route.js';
import { loadRivers, attachRiversToGraph } from '../core/rivers.js';

/** 数据加载 Promise（null = 尚未开始；加载完成后保留，失败时重置以允许重试） */
let readyPromise = null;
let loadingCityId = null;

/** 字节数 → 可读大小（<1MB 显示 KB，否则显示 MB，保留 1 位小数） */
function formatMB(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

/** 数据是否已就绪（索引 + 寻路图都已建好，站点层已渲染） */
export function isGameDataReady(cityId = state.currentCityId) {
  return state.loadedCityId === cityId && !!(state.routerGraph && state.physStops.length > 0);
}

/**
 * 确保交通数据已加载（幂等）：首次调用触发完整加载，后续调用直接返回。
 * 失败会重置状态，允许下次重试（失败提示由 loadAll 内部 showError 负责）。
 * @returns {Promise<boolean>} 数据是否就绪（失败时 resolve(false)，不向外抛错）
 */
export function ensureGameDataReady(cityId = state.currentCityId) {
  if (isGameDataReady(cityId)) return Promise.resolve(true);
  if (readyPromise) {
    if (loadingCityId === cityId) return readyPromise;
    return readyPromise.then(() => ensureGameDataReady(cityId));
  }
  loadingCityId = cityId;
  readyPromise = loadAll(cityId).finally(() => {
    readyPromise = null;
    loadingCityId = null;
  });
  return readyPromise;
}

/**
 * 丢弃本地缓存并重新下载、重建某城市数据。
 * 用于本地数据与服务器不一致时自愈（例如数据文件更新了而数据版本号没变，本地缓存还是旧文件）。
 */
export async function reloadGameData(cityId) {
  await dropCachedTransitData(cityId);
  if (state.loadedCityId === cityId) state.loadedCityId = null;
  return ensureGameDataReady(cityId);
}

/** 完整加载：下载 JSON → 建索引 → 建寻路图 → 渲染地铁底图与站点层 */
async function loadAll(cityId) {
  // 文案不写死大小：拿到实际传输大小（压缩后的 Content-Length）后再动态补上「约 X MB」；
  // 拿不到或直接读本地缓存时保持这句通用文案。多城市无需单独配置。
  try {
    await waitForMap(); // 底图尚未初始化时，沿用 bootstrap 的「正在加载地图」遮罩。
    // 本地已缓存的城市不再显示“下载”：读本地很快，随后的建图才是主要耗时（北京约 1 秒）
    showLoading(await hasCachedTransitData(cityId) ? '正在读取本地交通数据…' : '正在下载城市交通数据…');
    setLoadingProgress(null); // 初始隐藏进度条，等下载开始有 Content-Length 再显示
    const { data, source } = await loadTransitData(
      (f) => setLoadingProgress(f),
      (bytes) => showLoading('正在下载交通数据（约 ' + formatMB(bytes) + '）…'),
      cityId,
    );
    setLoadingProgress(null);
    showLoading('正在构建线路网络…');
    await new Promise((resolve) => setTimeout(resolve, 0)); // 让提示先绘制出来，再进入耗时的同步建图
    // 唯一一次建图：索引和最优路线共用；数据文件自带预先算好的站点合并结果，跳过最耗时的合并
    const graph = buildGraph(data.lines, { logical: data.logical, mergeRules: data.mergeRules });
    await loadRivers(cityId);                              // 江河（武汉、重庆）：禁止步行过江
    attachRiversToGraph(graph);
    if (state.loadedCityId && state.loadedCityId !== cityId) resetRoute();
    disposeStops();
    for (const overlay of state.metroBase) removeOverlay(overlay);
    state.metroBase = [];
    buildIndex(data, graph);                               // 适配为前端物理站/逻辑站索引
    renderMetroContext();                                  // 灰色地铁底图
    renderStops({                                          // 基础站点层（按视野渲染 + 交互）
      onClick: onStopClick,
      onMouseOver: onStopMouseOver,
      onMouseOut: onStopMouseOut,
      onMapClick: cancelRoutePreview,
    });
    state.loadedCityId = cityId;
    setStatus(`已加载 ${state.linesMap.size} 条线路 / ${state.physStops.length} 个站点 · ${source}`);
    hideLoading();
    return true;
  } catch (e) {
    hideLoading();
    showError('交通数据加载失败：' + (e && e.message ? e.message : e));
    console.error(e);
    state.loadedCityId = null; // 部分构建失败时不可复用残缺索引
    return false;
  }
}
