/**
 * ui/settings.js —— 设置页：左侧选项列表，右侧效果预览（参考欧卡 2 的设置界面）
 *
 * 鼠标悬停或键盘/触摸聚焦到某一行时，右侧显示该设置的示意图与说明；改动取值后示意图立即更新。
 * 除高德 Key（需要刷新页面）外，所有设置改动即时生效并保存到本地。
 * 步行换乘开关的生效逻辑仍在 app.js（它还要处理正式对局中的限制），这里只负责预览。
 */

import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { loadAmapKey } from '../core/storage.js';
import { saveSettings, FONT_SCALES } from '../core/settings.js';
import { setZoomSpeed } from '../map/map-init.js';
import { applyScenario, refreshVisibleStops, updateStopsByZoom } from '../map/stop-layer.js';
import { PREVIEWS } from './settings-preview.js';

let activeKey = 'zoomSpeed';

/** 各设置项的当前取值（预览用） */
function valueOf(key) {
  if (key === 'walkTransfer') return !!state.walkTransfer;
  if (key === 'amapKey') return !!loadAmapKey();
  return state.settings[key];
}

function renderPreview(key = activeKey) {
  const def = PREVIEWS[key];
  if (!def) return;
  activeKey = key;
  const stage = $('settings-preview-stage');
  if (stage) {
    // 有的设置没有示意图（如缩放速度）：保留同样大小的空框占位，切换选项时版面不跳动
    stage.innerHTML = def.render ? def.render(valueOf(key)) : '';
  }
  const title = $('settings-preview-title');
  if (title) title.textContent = def.title;
  const desc = $('settings-preview-desc');
  if (desc) desc.textContent = def.desc;
  for (const row of document.querySelectorAll('#settings-panel .setting-row')) {
    row.classList.toggle('active', row.dataset.setting === key);
  }
}

/** 应用字号：给 #app 标上倍率，CSS 用 zoom 放大界面面板（地图不受影响） */
export function applyFontScale(scale = state.settings.fontScale) {
  const app = $('app');
  if (!app) return;
  app.setAttribute?.('data-font-scale', scale in FONT_SCALES ? scale : 'normal');
  app.style?.setProperty?.('--ui-zoom', String(FONT_SCALES[scale] || 1));
}

/** 启动时应用一次已保存的设置 */
export function applySavedSettings() {
  setZoomSpeed(state.settings.zoomSpeed);
  applyFontScale();
}

function update(key, value) {
  state.settings = { ...state.settings, [key]: value };
  saveSettings(state.settings);
  if (key === 'zoomSpeed') setZoomSpeed(value);
  if (key === 'fontScale') applyFontScale(value);
  // 地图相关：已加载城市数据时立即重画地铁底图与站点
  if ((key === 'busMinZoom' || key === 'metroBase') && state.map && state.linesMap?.size) {
    if (key === 'metroBase') applyScenario();
    updateStopsByZoom();
    refreshVisibleStops();
  }
  syncControls();
  renderPreview(key);
}

/** 把控件状态同步为当前设置 */
export function syncControls() {
  const slider = $('zoom-speed-slider');
  if (slider) slider.value = String(state.settings.zoomSpeed);
  const metro = $('metro-base-toggle');
  if (metro) metro.checked = !!state.settings.metroBase;
  const focus = $('focus-on-confirm-toggle');
  if (focus) focus.checked = state.settings.focusOnConfirm !== false;
  const traces = $('collect-traces-toggle');
  if (traces) traces.checked = state.settings.collectTraces !== false;
  for (const btn of document.querySelectorAll('#settings-panel [data-choice]')) {
    const [key, raw] = btn.dataset.choice.split(':');
    const current = String(state.settings[key]);
    btn.classList.toggle('active', raw === current);
    btn.setAttribute?.('aria-pressed', raw === current ? 'true' : 'false');
  }
}

/** 打开设置页时调用：同步控件并显示第一项的预览 */
export function showSettingsPreview() {
  syncControls();
  renderPreview(activeKey);
}

/** 绑定设置页交互（app.js 启动时调用一次） */
export function bindSettings() {
  const panel = $('settings-panel');
  if (!panel) return;
  for (const row of panel.querySelectorAll('.setting-row')) {
    const key = row.dataset.setting;
    row.addEventListener('mouseenter', () => renderPreview(key));
    row.addEventListener('focusin', () => renderPreview(key));
    row.addEventListener('click', () => renderPreview(key));
  }
  $('zoom-speed-slider')?.addEventListener('input', (e) => update('zoomSpeed', Math.min(1, Math.max(0, parseFloat(e.target.value) || 0))));
  $('metro-base-toggle')?.addEventListener('change', (e) => update('metroBase', !!e.target.checked));
  $('focus-on-confirm-toggle')?.addEventListener('change', (e) => update('focusOnConfirm', !!e.target.checked));
  $('collect-traces-toggle')?.addEventListener('change', (e) => update('collectTraces', !!e.target.checked));
  // 步行换乘的生效与提示由 app.js 处理；这里在它之后刷新预览
  $('walk-transfer-toggle')?.addEventListener('change', () => setTimeout(() => renderPreview('walkTransfer'), 0));
  for (const btn of panel.querySelectorAll('[data-choice]')) {
    btn.addEventListener('click', () => {
      const [key, raw] = btn.dataset.choice.split(':');
      update(key, key === 'busMinZoom' ? Number(raw) : raw);
    });
  }
}
