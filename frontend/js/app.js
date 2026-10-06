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

import { initializeAccount,openAccount,closeAccount,toggleAccountMenu,closeAccountMenu,submitAccount,resendAccountCode,logout,showHistory,closeHistory } from './game/account-actions.js';
import { submitOnlineResult } from './game/online.js';
import { state } from './core/state.js';
import { $, hide, show, setStatus, showError, showLoading, hideLoading, showCenterToast, loadScript, isTouchDevice, preventPagePinch } from './core/dom.js';
import { loadAmapKey, loadAmapSecurity, saveAmapKey, saveAmapSecurity, loadWalkTransfer, saveWalkTransfer, loadCityId, saveCityId } from './core/storage.js';
import { cityById } from './data/cities.js';
import { initMap, failMapSetup, fitEndpoints, focusDestination } from './map/map-init.js';
import { toggleShowAllStops } from './map/stop-layer.js';
import { onStopClick, onCandidateStopClick, finishRoute, resetRoute, undoRoute, setForceWalk, setWalkTransferEnabled } from './game/route.js';
import { showMenu,returnHome, openStoryMenu, openTowerMenu, openCityMenu, startLevel, selectCity } from './game/session.js';
import { startFreeGame } from './game/free.js';
import { startTower,openTowerResetConfirm,closeTowerResetConfirm,confirmTowerReset,exitTowerAfterResult } from './game/tower.js';
import { openTowerLeaderboard,closeTowerLeaderboard } from './game/leaderboard.js';
// 注意：import game/flow.js 会执行它的模块体，从而注册"最优路线就绪"的订阅（结算弹窗）
import { nextLevel, restartLevel } from './game/flow.js';
import { loadStoryProgress, loadTowerState } from './game/progress.js';
import { buildStoryLevels, openSettingsPanel, closeSettingsPanel, setCityLabel, setCitySelectLabel, closeCityMenu, updateStoryButton, refreshMenuChrome } from './ui/menu.js';
import { hideResultOverlay } from './ui/result.js';
import { storyNext } from './ui/story.js';
import { openDailyMenu, startDaily } from './game/daily.js';
import { logTrace } from './game/trace.js';
import { bindCustomMenu, openSharedMapFromUrl } from './game/custom-menu.js';
import { loadSettings } from './core/settings.js';
import { bindSettings, showSettingsPreview, applySavedSettings } from './ui/settings.js';

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
      // 先移除兼容层：高德脚本会在已有的 window.AMap 上合并属性而非整体替换，
      // 残留的 __polyfill 标记会让代码误以为仍在 Leaflet 上（原生拾取器不安装 → 站点点不中）。
      if (window.AMap && window.AMap.__polyfill) delete window.AMap;
      await loadScript('https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(amapKey));
      if (window.AMap) { delete window.AMap.__polyfill; window.AMap.__backend = 'amap'; }
    } else {
      // 未配置 Key → 免 Key 的 Leaflet + OSM（amap-polyfill.js 提供 AMap 兼容层）
      await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
    }
    const cityName = (cityById(state.currentCityId) || cityById('beijing')).name;
    setCityLabel(cityName);
    setCitySelectLabel(cityName);
    initMap();
    updateStoryButton(); // 故事模式在所有城市均可进入
    hideLoading(); // 地图就绪即收起遮罩；交通数据改为进入游戏时按需下载（见 game/data-ready.js）
  } catch (e) {
    failMapSetup(e);
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
  window.addEventListener?.('mapgame:session-expired',()=>openAccount('login'));
  on('account-button',toggleAccountMenu);
  on('account-register',()=>openAccount('register'));
  on('account-forgot',()=>openAccount('forgot'));on('account-close',closeAccount);
  on('account-form',submitAccount,'submit');on('account-resend',resendAccountCode);
  on('logout-button',logout);on('history-button',showHistory);on('history-close',closeHistory);
  on('rename-button',()=>openAccount('rename')); // 修改昵称（全局唯一，服务端校验）
  on('result-retry',submitOnlineResult);
  // ---- 规划中的操作条 ----
  on('undo-btn', undoRoute);                  // 上一步
  on('reset-btn', () => { logTrace('reset', { stops: state.routeStops.length }); return state.onlineRound?.submission ? restartLevel() : resetRoute(); }); // 取消（重置路线）
  on('error-close', () => hide('error'));
  on('show-all-btn', () => { toggleShowAllStops(); logTrace('show_all', { on: state.showAllStops ? 1 : 0 }); }); // 显示/关闭全图站点
  on('trip-card', () => fitEndpoints());      // 行程牌：同时看到起点和终点
  on('dest-indicator', focusDestination);     // 终点方向指示：飞到终点
  on('tower-restart-btn', openTowerResetConfirm);
  on('tower-reset-close',closeTowerResetConfirm);
  on('tower-reset-confirm',confirmTowerReset);

  // ---- 主菜单与各模式入口 ----
  on('menu-btn', returnHome);
  on('story-btn', openStoryMenu);
  on('story-back-btn', showMenu);
  on('tower-btn', openTowerMenu);
  on('tower-back-btn', showMenu);
  on('tower-leaderboard',openTowerLeaderboard);on('leaderboard-close',closeTowerLeaderboard);
  on('free-btn', () => startFreeGame()); // 全随机：直接开局（情景随机）
  on('city-select-btn', openCityMenu);
  on('daily-btn', openDailyMenu);
  on('daily-start', startDaily);
  on('daily-back-btn', showMenu);
  bindCustomMenu(showMenu); // 自定义模式：广场 / 详情 / 编辑器入口

  // ---- 爬塔：四种畸变 ----
  on('tower-normal', () => startTower('normal'));
  on('tower-no-metro', () => startTower('noMetro'));
  on('tower-bus-boost', () => startTower('busBoost'));
  on('tower-rain', () => startTower('rain'));
  on('tower-blind', () => startTower('blind'));
  on('tower-real-ride', () => startTower('realRide'));

  // ---- 设置面板 ----
  on('settings-btn', () => { openSettingsPanel(); showSettingsPreview(); });
  bindSettings(); // 设置页：左侧选项 + 右侧效果预览
  on('settings-close', closeSettingsPanel);
  on('walk-transfer-toggle', (event) => {
    const input = event.currentTarget || $('walk-transfer-toggle');
    if (state.onlineRound && state.onlineRound.command?.mode !== 'tower') {
      input.checked = false;
      setWalkTransferEnabled(false);
      saveWalkTransfer(false);
      return;
    }
    const enabled = !!input.checked;
    setWalkTransferEnabled(enabled);
    saveWalkTransfer(enabled);
    // 系统最优不计算远距离步行换乘，开启后玩家可能比“最优”更快，需要明确告知
    showCenterToast(enabled
      ? '步行换乘打开后，可能会出现比系统最优更快的路线'
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

  // ---- 剧情 ----
  on('story-next-btn', storyNext);

  // ---- 结果弹窗 ----
  on('result-next', nextLevel);        // 下一关
  on('result-exit', exitTowerAfterResult);
  on('result-home', showMenu);
  on('result-restart', restartLevel);  // 重开本关 / 下一层
  on('result-viewmap', hideResultOverlay);
  on('result-toggle-btn', () => { hide('result-toggle-btn'); show('result-overlay'); });

  // ---- 城市下拉：点击下拉区域以外的地方关闭 ----
  document.addEventListener('click', (e) => {
    const wrap = $('city-select');
    if (wrap && !wrap.contains(e.target)) closeCityMenu();
    const accountEntry = $('account-entry');
    if (accountEntry && !accountEntry.contains(e.target)) closeAccountMenu();
  });
}

// ============ 启动 ============

state.isTouch = isTouchDevice(); // 判定触摸设备：手机端启用两阶段选站 + 更大的站点热区
state.walkTransfer = loadWalkTransfer(); // 步行换乘开关（持久化在 localStorage）
state.settings = loadSettings();         // 缩放速度、公交站显示级别、地铁底图、字号
state.currentCityId = loadCityId('beijing'); // 恢复上次选的城市（默认北京）
if (!cityById(state.currentCityId) || cityById(state.currentCityId).storyOnly) state.currentCityId = 'beijing'; // 校验无效值；故事专用小城市不能作为当前城市
preventPagePinch();             // 禁用页面级双指缩放（地图自身的双指缩放保留）
trackDrawerHeight();            // 手机底部抽屉的高度 → CSS 变量，地图右下角的版权署名随之上移
// 自动化测试/调试钩子：暴露只读状态引用 + 关键动作，供浏览器回归探针驱动流程（不影响游戏逻辑）
if (typeof window !== 'undefined') {
  window.__MG = {
    state,
    startLevel,
    resetRoute,
    restartLevel,
    tap: { stop: onStopClick, candidate: onCandidateStopClick, finish: finishRoute },
  };
}
bindUiEvents();
applySavedSettings();  // 缩放速度与字号（地图相关设置在加载城市数据时读取）
loadStoryProgress();   // 故事模式解锁进度（localStorage）
loadTowerState();      // 爬塔纪录（localStorage）
buildStoryLevels(startLevel); // 预生成关卡卡片（打开故事菜单时也会重建）
refreshMenuChrome();          // 首屏即为主菜单，隐藏地图上的游戏 UI
bootstrap();
void initializeAccount().finally(openSharedMapFromUrl); // 分享链接 ?map=分享码：账户状态就绪后再打开（决定能否编辑）

/**
 * 手机端路线面板/站点卡片是贴底的抽屉，会盖住地图右下角的 OpenStreetMap 署名。
 * 把抽屉的实际高度写进 --drawer-h，CSS 据此把地图底部控件抬到抽屉上方（展开/收起时跟着移动）。
 */
function trackDrawerHeight() {
  const col = $('left-col');
  const app = $('app');
  if (!col || !app || typeof ResizeObserver !== 'function') return;
  const update = () => app.style.setProperty('--drawer-h', Math.round(col.getBoundingClientRect().height) + 'px');
  new ResizeObserver(update).observe(col);
  update();
}

