/**
 * game/data-ready.js —— 交通数据的按需加载（懒加载 + 幂等）
 *
 * 【背景】数据文件 data/beijing-transit.json 约 19MB。早期它在 app.js 的
 *   bootstrap 里跟着网页一起加载（首屏 fetch 全量数据），玩家要等数据下完才能玩。
 *   现在改成"玩家点了再下载"：进入故事/自由/爬塔任一模式菜单时才触发下载，
 *   之后内存里已有数据，再次开局秒开（幂等，只加载一次）。
 *
 * 【为什么放在 game 层】
 *   "数据 → 索引 → 寻路图 → 站点图层"这条组装链同时依赖 core/data/map 三层，
 *   game 层正好位于它们之上（依赖方向 core ← data ← map ← game），
 *   且 game/session.js、game/free.js 等入口需要调用它，故放在这里而非 app.js。
 *   （app.js 是组合根，game 层不能反向 import 它，会形成循环依赖。）
 *
 * 【多城市扩展点】将来引入多个城市时，把 loadTransitData 换成"按城市 id 下载对应
 *   城市 JSON + 本地缓存"，本模块的幂等/加载遮罩/失败兜底逻辑不变，只改数据来源。
 */

import { state } from '../core/state.js';
import { setStatus, showLoading, hideLoading, showError, setLoadingProgress } from '../core/dom.js';
import { buildGraph } from '../core/router-api.js';
import { loadTransitData } from '../data/loader.js';
import { buildIndex } from '../data/index-builder.js';
import { renderMetroContext, renderStops } from '../map/stop-layer.js';
import { onStopMouseOver, onStopMouseOut } from '../map/hover.js';
import { onStopClick } from './route.js';

/** 数据加载 Promise（null = 尚未开始；加载完成后保留，失败时重置以允许重试） */
let readyPromise = null;

/** 数据是否已就绪（索引 + 寻路图都已建好，站点层已渲染） */
export function isGameDataReady() {
  return !!(state.routerGraph && state.physStops.length > 0);
}

/**
 * 确保交通数据已加载（幂等）：首次调用触发完整加载，后续调用直接返回。
 * 失败会重置状态，允许下次重试（失败提示由 loadAll 内部 showError 负责）。
 * @returns {Promise<boolean>} 数据是否就绪（失败时 resolve(false)，不向外抛错）
 */
export function ensureGameDataReady() {
  if (!readyPromise) readyPromise = isGameDataReady() ? Promise.resolve(true) : loadAll();
  return readyPromise;
}

/** 完整加载：下载 JSON → 建索引 → 建寻路图 → 渲染地铁底图与站点层 */
async function loadAll() {
  showLoading('正在下载交通数据（首次约 19MB）…');
  setLoadingProgress(null); // 初始隐藏进度条，等下载开始有 Content-Length 再显示
  try {
    const { data, source } = await loadTransitData((f) => setLoadingProgress(f));
    buildIndex(data);                                      // 物理站/逻辑站索引
    state.routerGraph = buildGraph(data.lines);            // 本地寻路图（供最优路线计算）
    renderMetroContext();                                  // 灰色地铁底图
    renderStops({                                          // 基础站点层（按视野渲染 + 交互）
      onClick: onStopClick,
      onMouseOver: onStopMouseOver,
      onMouseOut: onStopMouseOut,
    });
    setStatus(`已加载 ${state.linesMap.size} 条线路 / ${state.physStops.length} 个站点 · ${source}`);
    hideLoading();
    return true;
  } catch (e) {
    hideLoading();
    showError('交通数据加载失败：' + (e && e.message ? e.message : e));
    console.error(e);
    readyPromise = null; // 允许下次重试
    return false;
  }
}
