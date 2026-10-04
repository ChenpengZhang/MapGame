// 玩家设置：本地读写与非法值回落
import assert from 'node:assert/strict';
import { installAllStubs } from './stubs.mjs';

installAllStubs();
const { loadSettings, saveSettings, DEFAULT_SETTINGS } = await import('../frontend/js/core/settings.js');

localStorage.removeItem('mg_settings');
assert.deepEqual(loadSettings(), { ...DEFAULT_SETTINGS }, '没有保存过时使用默认值');

saveSettings({ zoomSpeed: 0.8, busMinZoom: 13, metroBase: false, fontScale: 'xl', focusOnConfirm: false });
assert.deepEqual(loadSettings(), { zoomSpeed: 0.8, busMinZoom: 13, metroBase: false, fontScale: 'xl', focusOnConfirm: false });

localStorage.setItem('mg_settings', JSON.stringify({ zoomSpeed: 7, busMinZoom: 11, metroBase: 'yes', fontScale: 'huge', focusOnConfirm: 'no' }));
assert.deepEqual(loadSettings(), { ...DEFAULT_SETTINGS }, '非法值逐项回落到默认');

localStorage.setItem('mg_settings', '{broken');
assert.deepEqual(loadSettings(), { ...DEFAULT_SETTINGS }, '损坏的存储不影响启动');
localStorage.removeItem('mg_settings');

console.log('\n=== 设置：通过 ===\n');
