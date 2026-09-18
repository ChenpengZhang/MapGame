/**
 * app.js —— 应用入口（组合根 / Composition Root）
 *
 * 【这个文件只做三件事】
 *   1) 引导（bootstrap）：按"有没有配高德 Key"决定加载哪一个地图 SDK，
 *      然后初始化地图、加载交通数据、建索引与寻路图、渲染首屏；
 *   2) 组装（loadGameData）：把"数据 → 索引 → 寻路图 → 图层"按顺序接起来；
 *   3) 事件绑定（bindUiEvents）：把界面按钮接到各层的函数上——全项目唯一写
 *      addEventListener 的地方。
 *
 * 【它刻意不做什么】
 *   不写玩法规则（game/）、不画地图（map/）、不拼面板 HTML（ui/）。
 *   所以本文件应该常年保持在 100 行上下；如果它开始变长，说明有新逻辑放错了层。
 *
 * 【分层与依赖方向】core ← data ← map ← game ← ui 之上是入口；
 *   game 可以 import ui/map/data/core，反方向一律禁止（详见 docs/前端架构.md）。
 *
 * 【脚本加载顺序】index.html 里：router.js（普通脚本，先执行）→ amap-polyfill.js
 *   → app.js（type="module"，延迟到 DOM 解析完再执行）。
 *   所以本文件顶层可以安全地取 DOM 元素，也能用 window.TransitRouter。
 */

import { state } from './core/state.js';
import { $, hide, show, setStatus, showError, showLoading, hideLoading, loadScript } from './core/dom.js';
import { buildGraph } from './core/router-api.js';
import { loadAmapKey, loadAmapSecurity, saveAmapKey, saveAmapSecurity } from './core/storage.js';
import { loadTransitData } from './data/loader.js';
import { buildIndex } from './data/index-builder.js';
import { initMap, setZoomSpeed } from './map/map-init.js';
import { renderMetroContext, renderStops, toggleShowAllStops } from './map/stop-layer.js';
import { onStopMouseOver, onStopMouseOut } from './map/hover.js';
import { onStopClick, resetRoute, undoRoute } from './game/route.js';
import { showMenu, openStoryMenu, openTowerMenu, startLevel } from './game/session.js';
import { openFreeMenu, startFreeGame } from './game/free.js';
import { startTower, resetTowerFromLayer1 } from './game/tower.js';
// 注意：import game/flow.js 会执行它的模块体，从而注册"最优路线就绪"的订阅（结算弹窗）
import { nextLevel, restartLevel } from './game/flow.js';
import { loadStoryProgress, loadTowerState } from './game/progress.js';
import { buildStoryLevels, openSettingsPanel, closeSettingsPanel, setCityLabel } from './ui/menu.js';
import { hideResultOverlay } from './ui/result.js';
import { storyNext, tutorialNext } from './ui/story.js';

// ============ 1. 引导 ============

/**
 * 启动流程：加载地图 SDK → 初始化地图 → 加载数据。
 * 高德 Key 只存本地缓存（localStorage），不进代码/仓库，避免泄露。
 */
async function bootstrap() {
  showLoading('正在加载地图…');
  try {
    const amapKey = loadAmapKey();
    if (amapKey) {
      // 配置了高德 Key → 用高德底图（真实高德脚本会覆盖 amap-polyfill.js 里的兼容层）
      window._AMapSecurityConfig = { securityJsCode: loadAmapSecurity() || '' };
      await loadScript('https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(amapKey));
    } else {
      // 未配置 Key → 免 Key 的 Leaflet + OSM（amap-polyfill.js 提供 AMap 兼容层）
      await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
    }
    setCityLabel('北京');
    initMap();
    loadGameData();
  } catch (e) {
    hideLoading();
    showError('初始化失败：' + (e && e.message ? e.message : e));
  }
}

// ============ 2. 组装：数据 → 索引 → 寻路图 → 图层 ============

/**
 * 加载交通数据并渲染首屏。
 * （重构前这段写在 initMap 里，导致"地图初始化"顺带承担了数据职责，故拆开。）
 */
async function loadGameData() {
  try {
    const { data, source } = await loadTransitData();
    buildIndex(data);                                        // 建物理站/逻辑站索引
    state.routerGraph = buildGraph(data.lines);              // 本地寻路图（供最优路线计算）
    renderMetroContext();                                    // 灰色地铁底图
    renderStops({                                            // 基础站点层（按视野渲染）
      onClick: onStopClick,
      onMouseOver: onStopMouseOver,
      onMouseOut: onStopMouseOut,
    });
    setStatus(`已加载 ${state.linesMap.size} 条线路 / ${state.physStops.length} 个站点 · ${source} · 选择关卡开始游戏`);
    hideLoading(); // 数据渲染完成，收起启动加载弹窗
  } catch (e) {
    // 重构前这里没有兜底：数据加载失败会一直卡在"正在加载地图…"，玩家看不到原因
    hideLoading();
    showError('交通数据加载失败：' + (e && e.message ? e.message : e));
    console.error(e);
  }
}

// ============ 3. 事件绑定（全项目唯一的 addEventListener 集中地） ============

/** 绑定的简写：元素不存在时静默跳过（避免某个按钮被删掉就整页白屏） */
function on(id, handler, evt) {
  const el = $(id);
  if (el) el.addEventListener(evt || 'click', handler);
}

function bindUiEvents() {
  // ---- 规划中的操作条 ----
  on('undo-btn', undoRoute);                  // 上一步
  on('reset-btn', resetRoute);                // 取消（重置路线）
  on('show-all-btn', toggleShowAllStops);     // 显示/关闭全图站点
  on('tower-restart-btn', resetTowerFromLayer1); // 爬塔：从第 1 层重来

  // ---- 主菜单与各模式入口 ----
  on('menu-btn', showMenu);
  on('story-btn', openStoryMenu);
  on('story-back-btn', showMenu);
  on('tower-btn', openTowerMenu);
  on('tower-back-btn', showMenu);
  on('free-btn', openFreeMenu);
  on('free-start-btn', startFreeGame);
  on('free-back-btn', showMenu);
  on('online-btn', () => setStatus('排位模式尚未开放，敬请期待'));

  // ---- 爬塔：四种畸变 ----
  on('tower-normal', () => startTower('normal'));
  on('tower-no-metro', () => startTower('noMetro'));
  on('tower-bus-boost', () => startTower('busBoost'));
  on('tower-rain', () => startTower('rain'));

  // ---- 设置面板 ----
  on('settings-btn', openSettingsPanel);
  on('settings-close', closeSettingsPanel);
  on('zoom-speed-slider', (e) => setZoomSpeed(parseFloat(e.target.value) || 0.5), 'input');
  on('amap-save-btn', () => {
    saveAmapKey($('amap-key-input').value);
    saveAmapSecurity($('amap-sec-input').value);
    showLoading('正在切换地图，请稍候…');
    location.reload(); // 换 Key 必须重新加载地图 SDK
  });

  // ---- 剧情 / 教学 ----
  on('story-dialog', storyNext);
  on('tutorial-next', tutorialNext);

  // ---- 结果弹窗 ----
  on('result-next', nextLevel);        // 下一关
  on('result-restart', restartLevel);  // 重开本关 / 下一层
  on('result-tower-reset', resetTowerFromLayer1);
  on('result-viewmap', hideResultOverlay);
  on('result-toggle-btn', () => { hide('result-toggle-btn'); show('result-overlay'); });
}

// ============ 启动 ============

bindUiEvents();
loadStoryProgress();   // 故事模式解锁进度（localStorage）
loadTowerState();      // 爬塔纪录（localStorage）
buildStoryLevels(startLevel); // 预生成关卡卡片（打开故事菜单时也会重建）
bootstrap();
