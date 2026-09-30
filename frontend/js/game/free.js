/**
 * game/free.js —— 随机模式（全随机）
 *
 * 【玩法】点“随机模式”直接开局：起终点随机，情景也从无尽模式的 6 种里随机抽一种
 * （普通 / 地铁瘫痪 / 一路畅通 / 大雨滂沱 / 盲棋 / 真实乘坐），无时限；局内顶部显示本局情景。
 * 起终点采样复用 game/session.js 的 sampleRandomEndpoints，与爬塔同一套规则（离站点 300~1500m）。
 * 登录玩家走服务端正式对局（mode: 'free'）：寻路相关的情景以 options 提交，
 * 盲棋 / 真实乘坐只影响前端呈现与操作，由 online.js 按 scenarioKey 在本地补上。
 */

import { account } from '../core/account.js';
import { state } from '../core/state.js';
import { startOnline } from './online.js';
import { startLevel, ensureStopsReady, sampleRandomEndpoints } from './session.js';
import { TOWER_KEYS, TOWER_SCENARIOS } from '../data/levels.js';

/** 随机抽一种情景 key */
export function pickRandomScenario() {
  return TOWER_KEYS[Math.floor(Math.random() * TOWER_KEYS.length)];
}

/** 局内顶部 HUD 只显示情景效果（情景名已在左上角标题里） */
export function scenarioHudText(key) {
  return TOWER_SCENARIOS[key]?.sub || '';
}

/** 点“随机模式”：抽情景并直接开局（可传入 key 指定情景，测试用） */
export async function startFreeGame(key = pickRandomScenario()) {
  if (account.user) {
    return startOnline(
      { mode: 'free', city: state.currentCityId, options: { noMetro: key === 'noMetro', busBoost: key === 'busBoost', rain: key === 'rain' } },
      { scenarioKey: key },
    );
  }
  return randomLevel(TOWER_SCENARIOS[key]?.scenario || {}, key);
}

/** 生成一局随机关卡并开始（startLevel 会隐藏所有菜单） */
export async function randomLevel(scenario, key = 'normal') {
  // 数据未加载完时等待，避免随机点拿到空数据（两点重合）
  if (!(await ensureStopsReady())) return;
  const [o, d] = sampleRandomEndpoints();
  const level = {
    id: 'random',
    mode: 'random',
    title: `随机模式 · ${TOWER_SCENARIOS[key]?.label || '普通'}`,
    goalText: '规划一条从随机起点到随机终点的最快路线。',
    hudText: scenarioHudText(key),
    origin: { name: '随机起点', lng: o[0], lat: o[1] },
    dest: { name: '随机终点', lng: d[0], lat: d[1] },
  };
  startLevel(level, { skipStory: true, scenario: scenario || {} });
}
