/**
 * game/tower.js —— 无尽模式（爬塔）
 *
 * 【玩法】
 *   随机起终点，每层要求"比最优慢 ≤ 阈值"，阈值从第 1 层的 100% 逐层收紧到 1%。
 *   四种畸变（普通/地铁瘫痪/一路畅通/大雨滂沱）分别记成绩，中途退出可续玩。
 *
 * 【状态都在 core/state.js】
 *   towerActive 是否在爬塔中 / towerLayer 当前层 / towerScenarioKey 当前畸变
 *   towerLastPass 上一层是否通过（决定"重开"是进下一层还是回第 1 层）
 *   towerBest 各畸变最高层 / towerProgress 各畸变进行中的层数
 *
 * 【存档时机】通过或失败时、以及退回主菜单时（见 session.showMenu）。
 */

import { state } from '../core/state.js';
import { hide, show, setText } from '../core/dom.js';
import { TOWER_SCENARIOS } from '../data/levels.js';
import { computeTotalMinutes } from './time-model.js';
import { saveTowerState } from './progress.js';
import { startLevel, ensureStopsReady, sampleRandomEndpoints } from './session.js';
import { resetRoute } from './route.js';
import { showResultOverlay } from '../ui/result.js';

/** 爬塔难度：第 1 层要求 ≤100%（2 倍最优以内），线性收紧到第 12 层 ≤1%，之后保持 1% */
export function towerThreshold(layer) {
  if (layer <= 1) return 1.0;
  const t = 1.0 - (layer - 1) * (1.0 - 0.01) / 11;
  return Math.max(0.01, t);
}

/** 选定畸变开始爬塔（有进度则从该层继续，否则从第 1 层） */
export function startTower(key) {
  state.towerScenarioKey = key;
  state.towerLayer = state.towerProgress[key] > 0 ? state.towerProgress[key] : 1;
  state.towerLastPass = false;
  state.towerActive = true;
  hide('tower-menu');
  startTowerRound();
}

/** 从第 1 层重来（清空该畸变的进行中进度，保留最高纪录） */
export function resetTowerFromLayer1() {
  state.towerLayer = 1;
  state.towerProgress[state.towerScenarioKey] = 0;
  state.towerLastPass = false;
  saveTowerState();
  resetRoute();
  startTowerRound();
}

/** 起一层新的爬塔：随机起终点 + 当前畸变情景 + 显示 HUD */
export async function startTowerRound() {
  // 数据没加载完就先等（否则随机点会重合，见 session.ensureStopsReady 的说明）
  if (!(await ensureStopsReady())) return;
  const [o, d] = sampleRandomEndpoints();
  const cfg = TOWER_SCENARIOS[state.towerScenarioKey];
  const thr = towerThreshold(state.towerLayer);
  const level = {
    id: 'tower',
    mode: 'random',
    title: '无尽模式 · ' + cfg.label,
    goalText: '第 ' + state.towerLayer + ' 层 · 要求比最优慢 ≤ ' + Math.round(thr * 100) + '%',
    origin: { name: '随机起点', lng: o[0], lat: o[1] },
    dest: { name: '随机终点', lng: d[0], lat: d[1] },
  };
  show('tower-hud');
  setText('tower-layer-label', '第 ' + state.towerLayer + ' 层');
  setText('tower-threshold-label', '要求比最优慢 ≤ ' + Math.round(thr * 100) + '%');
  startLevel(level, { skipStory: true, scenario: cfg.scenario });
}

/** 结果弹窗内容：本层通过/止步（由 game/flow.js 在最优路线算完后调用） */
export function showTowerResult() {
  const playerTotal = computeTotalMinutes();
  const optTotal = state.optimalResult ? state.optimalResult.totalMin : 0;
  const gapRatio = optTotal > 0 ? (playerTotal - optTotal) / optTotal : 0;
  const thr = towerThreshold(state.towerLayer);
  const pass = gapRatio <= thr;
  state.towerLastPass = pass;

  let detail = '你的用时 ' + playerTotal.toFixed(0) + ' 分钟';
  if (optTotal > 0) detail += '　·　最快 ' + optTotal.toFixed(0) + ' 分钟';
  detail += '　·　比最优慢 ' + Math.round(gapRatio * 100) + '%（要求 ≤ ' + Math.round(thr * 100) + '%）';

  let title, message, restartLabel;
  if (pass) {
    title = '🗼 第 ' + state.towerLayer + ' 层通过！';
    message = '下一层要求更严苛：比最优慢 ≤ ' + Math.round(towerThreshold(state.towerLayer + 1) * 100) + '%';
    restartLabel = '下一层';
    // 通过后进度推进到下一层（退出时保存）
    state.towerProgress[state.towerScenarioKey] = state.towerLayer + 1;
    saveTowerState();
  } else {
    if (state.towerLayer > state.towerBest[state.towerScenarioKey]) {
      state.towerBest[state.towerScenarioKey] = state.towerLayer;
    }
    state.towerProgress[state.towerScenarioKey] = 0; // 失败后清空进度（重新挑战从第 1 层）
    saveTowerState();
    title = '💀 止步第 ' + state.towerLayer + ' 层';
    message = '最高纪录：第 ' + state.towerBest[state.towerScenarioKey] + ' 层';
    restartLabel = '重新挑战';
  }

  showResultOverlay({
    title, message, detail,
    restartLabel,
    showNext: false,        // 爬塔没有"下一关"，只有"下一层"
    showTowerReset: true,   // 显示"从第 1 层重来"
  });
}
