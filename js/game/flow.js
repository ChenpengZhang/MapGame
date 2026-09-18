/**
 * game/flow.js —— 结算与关卡衔接（把"玩法结果"接回"界面流程"）
 *
 * 【它在链路里的位置】
 *   最优路线算完 → core/bus 广播 EVENTS.OPTIMAL_READY → 本模块决定弹哪个结算窗：
 *     爬塔   → game/tower.showTowerResult（按层数阈值判定）
 *     其它   → showLevelResult（按时限判定成败、解锁下一关）
 *   再把弹窗上的三个按钮接到对应动作：下一关 / 重开 / 从第 1 层重来。
 *
 * 【为什么要这一层】
 *   结算内容依赖"模式"，按钮动作依赖"关卡列表 + 爬塔状态"。
 *   把这些放在这里，可以让 route.js 完全不认识爬塔与关卡，避免循环依赖（详见 core/bus.js）。
 */

import { state } from '../core/state.js';
import { LEVELS } from '../data/levels.js';
import { computeTotalMinutes } from './time-model.js';
import { saveStoryProgress } from './progress.js';
import { startLevel, beginGameplay, showMenu } from './session.js';
import { startTowerRound, showTowerResult } from './tower.js';
import { resetRoute } from './route.js';
import { showResultOverlay } from '../ui/result.js';
import { EVENTS, on } from '../core/bus.js';

/**
 * 关卡结算弹窗（故事模式 / 自由模式）：
 *   时限内完成 → 恭喜 + 解锁下一关；超时 → 失败文案 + 隐藏"下一关"。
 */
export function showLevelResult() {
  const playerTotal = computeTotalMinutes();
  const optTotal = state.optimalResult ? state.optimalResult.totalMin : 0;
  const level = state.currentLevel;
  const limit = level ? level.timeLimitMin : null;
  const win = limit == null || playerTotal <= limit;

  const title = win ? '🎉 恭喜！' : '🥲 抱歉…';
  const message = win
    ? ((level && level.success) || '恭喜！你完成了任务！')
    : ((level && level.fail) || '抱歉——再试试更快一点的路线？');

  let detail = '你的用时 ' + playerTotal.toFixed(0) + ' 分钟';
  if (optTotal > 0) detail += '　·　最快 ' + optTotal.toFixed(0) + ' 分钟';
  if (limit != null) detail += '　·　时限 ' + limit + ' 分钟';

  const idx = LEVELS.indexOf(level);
  const hasNext = idx >= 0 && idx + 1 < LEVELS.length;
  // 通关才解锁下一关；失败时隐藏"下一关"
  if (win && idx >= 0) {
    if (state.storyUnlocked < idx + 2) {
      state.storyUnlocked = idx + 2;
      saveStoryProgress();
    }
  }

  showResultOverlay({
    title,
    message,
    detail,
    nextLabel: hasNext ? '下一关' : '通关·回菜单',
    showNext: win,
    showTowerReset: false,
  });
}

/** "下一关"：进入下一关；已是最后一关则解锁自由模式并回菜单 */
export function nextLevel() {
  const idx = LEVELS.indexOf(state.currentLevel);
  if (idx >= 0 && idx + 1 < LEVELS.length) {
    startLevel(LEVELS[idx + 1]);
  } else {
    // 通关全部 → 解锁自由模式
    if (state.storyUnlocked < LEVELS.length + 1) {
      state.storyUnlocked = LEVELS.length + 1;
      saveStoryProgress();
    }
    showMenu();
  }
}

/** "重开"：爬塔按通过与否决定进下一层还是回第 1 层；其它模式重玩本关 */
export function restartLevel() {
  resetRoute();
  if (state.towerActive) {
    // 爬塔：通过 → 下一层；未通过 → 重新挑战（回到第 1 层）
    state.towerLayer = state.towerLastPass ? state.towerLayer + 1 : 1;
    startTowerRound();
  } else {
    beginGameplay(state.currentLevel);
  }
}

// 订阅"最优路线就绪"：这是全项目唯一的跨层通知（见 core/bus.js 顶部说明）
on(EVENTS.OPTIMAL_READY, () => {
  if (state.towerActive) showTowerResult();
  else showLevelResult();
});
