/**
 * core/settings.js —— 玩家设置（本地保存）
 *
 * 步行换乘与高德 Key 沿用各自原有的存储键（见 core/storage.js），这里只放新的通用设置：
 *   zoomSpeed   滚轮缩放速度 0~1（默认 0.5）
 *   busMinZoom  公交站开始显示的缩放级别 13~16（默认 15；数字越小，缩得越远也能看到公交站）
 *   metroBase   是否显示灰色地铁底图
 *   fontScale   界面字号 'normal' | 'lg' | 'xl'
 */

import { readJSON, writeJSON } from './storage.js';

const KEY = 'mg_settings';

export const DEFAULT_SETTINGS = Object.freeze({
  zoomSpeed: 0.5,
  busMinZoom: 15,
  metroBase: true,
  fontScale: 'normal',
});

export const BUS_ZOOM_CHOICES = [13, 14, 15, 16];
export const FONT_SCALES = { normal: 1, lg: 1.12, xl: 1.25 };

/** 读取设置；缺失或非法的字段回落到默认值 */
export function loadSettings() {
  const saved = readJSON(KEY) || {};
  const out = { ...DEFAULT_SETTINGS };
  if (Number.isFinite(saved.zoomSpeed) && saved.zoomSpeed >= 0 && saved.zoomSpeed <= 1) out.zoomSpeed = saved.zoomSpeed;
  if (BUS_ZOOM_CHOICES.includes(saved.busMinZoom)) out.busMinZoom = saved.busMinZoom;
  if (typeof saved.metroBase === 'boolean') out.metroBase = saved.metroBase;
  if (saved.fontScale in FONT_SCALES) out.fontScale = saved.fontScale;
  return out;
}

export function saveSettings(settings) {
  writeJSON(KEY, settings);
}
