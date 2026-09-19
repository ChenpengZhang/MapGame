/**
 * game/free.js —— 自由模式（纯随机起终点）
 *
 * 【玩法】随机抽一对起终点，可选勾选情景（禁地铁 / 公交加速 / 大雨），无时限。
 * 起终点采样复用 game/session.js 的 randomPoint / sampleRandomEndpoints，
 * 与爬塔用同一套规则（离站点 300~1500m，保证步行可控）。
 */

import { setStatus, hide, $ } from '../core/dom.js';
import { startLevel, ensureStopsReady, sampleRandomEndpoints } from './session.js';
import { showPanel } from '../ui/menu.js';

/** 随机模式二级页：勾选情景 */
export function openFreeMenu() {
  showPanel('free-menu');
  setStatus('勾选情景后开始随机模式');
}

/** 读取勾选的情景并开局（多个勾选会叠乘：加速 1.2 × 雨天 0.5 = 0.6） */
export async function startFreeGame() {
  const sc = {
    noMetro: $('free-no-metro').checked,
    busSpeedFactor: 1.0,
    walkSpeedFactor: 1.0,
  };
  if ($('free-bus-boost').checked) sc.busSpeedFactor *= 1.2;
  if ($('free-rain').checked) { sc.busSpeedFactor *= 0.5; sc.walkSpeedFactor *= 0.5; }
  hide('free-menu');
  return randomLevel(sc);
}

/** 生成一局随机关卡并开始（startLevel 会隐藏所有菜单） */
export async function randomLevel(scenario) {
  // 数据未加载完时等待，避免随机点拿到空数据（两点重合）
  if (!(await ensureStopsReady())) return;
  const [o, d] = sampleRandomEndpoints();
  const level = {
    id: 'random',
    mode: 'random',
    title: '随机模式',
    goalText: '规划一条从随机起点到随机终点的最快路线。',
    origin: { name: '随机起点', lng: o[0], lat: o[1] },
    dest: { name: '随机终点', lng: d[0], lat: d[1] },
  };
  startLevel(level, { skipStory: true, scenario: scenario || {} });
}
