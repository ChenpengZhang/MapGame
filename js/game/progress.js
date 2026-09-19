/**
 * game/progress.js —— 进度持久化（故事解锁数 / 爬塔纪录）
 *
 * 【为什么要单独一个文件】
 *   存档是"玩法的记忆"：故事模式解锁到第几关、爬塔各畸变的最好成绩与进行中的层数。
 *   重构前这些读写散在 app.js 的菜单、爬塔、结算三处，很容易出现
 *   "菜单里读了、结算里忘了写"的存档不一致。现在读写各只有一个出口。
 *
 * 底层 localStorage 的异常处理在 core/storage.js。
 */

import { state } from '../core/state.js';
import { readText, writeText, readJSON, writeJSON } from '../core/storage.js';
import { LEVELS } from '../data/levels.js';

/**
 * 开发者调试开关：true 时直接解锁所有故事关卡（仅代码内开关，无 UI；自由模式本来就不上锁）。
 * ⚠ 发布前记得改成 false。
 */
const DEV_DEBUG_MODE = true;

const KEY_STORY = 'mg_story_unlocked';
// 爬塔存档按城市分开（否则切换城市后深圳会读到北京的起终点缓存，一点进去就"传送"回北京）：
// 每个城市一个 key，如 mg_tower_state_beijing / mg_tower_state_shenzhen
const towerKey = () => 'mg_tower_state_' + (state.currentCityId || 'beijing');

// ============ 故事模式解锁进度 ============

/** 读存档：已解锁关卡数（读不到则为 1） */
export function loadStoryProgress() {
  const v = parseInt(readText(KEY_STORY, ''), 10);
  if (v > 0) state.storyUnlocked = v;
  if (DEV_DEBUG_MODE) state.storyUnlocked = LEVELS.length + 1; // 调试模式：全部解锁
}

/** 写存档：已解锁关卡数 */
export function saveStoryProgress() {
  writeText(KEY_STORY, String(state.storyUnlocked));
}

// ============ 爬塔纪录 ============

/** 读存档：best（各畸变最高层）+ progress（各畸变进行中的层数）+ round（本轮起终点） */
export function loadTowerState() {
  const v = readJSON(towerKey()) || {};
  const b = v.best || {}, p = v.progress || {}, r = v.round || {};
  for (const k of Object.keys(state.towerBest)) {
    const bn = parseInt(b[k], 10);
    if (bn > 0) state.towerBest[k] = bn;
    const pn = parseInt(p[k], 10);
    if (pn > 0) state.towerProgress[k] = pn;
    // 校验本轮起终点结构，忽略旧版/损坏的存档，避免污染状态
    const round = r[k];
    if (round && typeof round.layer === 'number' &&
        Array.isArray(round.origin) && Array.isArray(round.dest)) {
      state.towerRound[k] = { layer: round.layer, origin: round.origin, dest: round.dest };
    }
  }
}

/** 写存档：best + progress + round（按当前城市分开存） */
export function saveTowerState() {
  writeJSON(towerKey(), { best: state.towerBest, progress: state.towerProgress, round: state.towerRound });
}
