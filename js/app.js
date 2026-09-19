/**
 * app.js —— 应用入口（组合根 / Composition Root）
 *
 * 【这个文件只做三件事】
 *   1) 引导（bootstrap）：按"有没有配高德 Key"决定加载哪一个地图 SDK，
 *      然后初始化地图。交通数据不在这里加载——改为玩家进入某个模式菜单时
 *      按需下载（见 game/data-ready.js 的 ensureGameDataReady，幂等懒加载）；
 *   2) 事件绑定（bindUiEvents）：把界面按钮接到各层的函数上——全项目唯一写
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
import { $, hide, show, setStatus, showError, showLoading, hideLoading, showCenterToast, loadScript, isTouchDevice, preventPagePinch } from './core/dom.js';
import { loadAmapKey, loadAmapSecurity, saveAmapKey, saveAmapSecurity, loadWalkTransfer, saveWalkTransfer } from './core/storage.js';
import { initMap, setZoomSpeed } from './map/map-init.js';
import { toggleShowAllStops } from './map/stop-layer.js';
import { onStopClick, onCandidateStopClick, finishRoute, resetRoute, undoRoute, confirmStart, setForceWalk } from './game/route.js';
import { showMenu, openStoryMenu, openTowerMenu, startLevel } from './game/session.js';
import { openFreeMenu, startFreeGame } from './game/free.js';
import { startTower, resetTowerFromLayer1 } from './game/tower.js';
// 注意：import game/flow.js 会执行它的模块体，从而注册"最优路线就绪"的订阅（结算弹窗）
import { nextLevel, restartLevel } from './game/flow.js';
import { loadStoryProgress, loadTowerState } from './game/progress.js';
import { buildStoryLevels, openSettingsPanel, closeSettingsPanel, setCityLabel, refreshMenuChrome } from './ui/menu.js';
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
    hideLoading(); // 地图就绪即收起遮罩；交通数据改为进入游戏时按需下载（见 game/data-ready.js）
  } catch (e) {
    hideLoading();
    showError('初始化失败：' + (e && e.message ? e.message : e));
  }
}

// ============ 2. 事件绑定（全项目唯一的 addEventListener 集中地） ============

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
  on('walk-transfer-toggle', () => {
    const on = !!$('walk-transfer-toggle').checked;
    state.walkTransfer = on;
    saveWalkTransfer(on);
    showCenterToast(on
      ? '已开启步行换乘：玩家可能规划出比系统最优更快的路线'
      : '已关闭步行换乘');
  }, 'change');
  on('force-walk-toggle', () => {
    setForceWalk($('force-walk-toggle').checked);
  }, 'change');
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

state.isTouch = isTouchDevice(); // 判定触摸设备：手机端启用两阶段选站 + 更大的站点热区
state.walkTransfer = loadWalkTransfer(); // 步行换乘开关（持久化在 localStorage）
preventPagePinch();             // 禁用页面级双指缩放（地图自身的双指缩放保留）
// 自动化测试/调试钩子：暴露只读状态引用 + 关键动作，供浏览器回归探针驱动流程（不影响游戏逻辑）
if (typeof window !== 'undefined') {
  window.__MG = {
    state,
    startLevel,
    resetRoute,
    restartLevel,
    tap: { stop: onStopClick, candidate: onCandidateStopClick, finish: finishRoute, confirm: confirmStart },
  };
}
bindUiEvents();
loadStoryProgress();   // 故事模式解锁进度（localStorage）
loadTowerState();      // 爬塔纪录（localStorage）
buildStoryLevels(startLevel); // 预生成关卡卡片（打开故事菜单时也会重建）
refreshMenuChrome();          // 首屏即为主菜单，隐藏地图上的游戏 UI
bootstrap();
