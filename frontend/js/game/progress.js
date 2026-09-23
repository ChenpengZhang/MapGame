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

import { account } from '../core/account.js';
import { api } from '../core/api.js';
import { updateTowerMenuBest } from '../ui/menu.js';
import { setStatus } from '../core/dom.js';
import { state } from '../core/state.js';
import { readText, writeText, readJSON, writeJSON,removeKey } from '../core/storage.js';
import { DATA_VERSION } from '../core/config.js';
import { LEVELS } from '../data/levels.js';
import { CITIES } from '../data/cities.js';

/**
 * 开发者调试开关：true 时直接解锁所有故事关卡（仅代码内开关，无 UI；自由模式本来就不上锁）。
 * ⚠ 发布前记得改成 false。
 */
const DEV_DEBUG_MODE = true;

const KEY_STORY = 'mg_story_unlocked';
// 爬塔存档按城市分开（否则切换城市后深圳会读到北京的起终点缓存，一点进去就"传送"回北京）：
// 每个城市一个 key，如 mg_tower_state_beijing / mg_tower_state_shenzhen
const towerKey = () => 'mg_tower_state_' + (state.currentCityId || 'beijing');

export function clearGuestTowerState() {
  for(const city of CITIES)removeKey('mg_tower_state_'+city.id);
  for(const key of Object.keys(state.towerBest)){
    state.towerBest[key]=0;state.towerProgress[key]=0;state.towerElapsed[key]=0;state.towerRound[key]=null;
  }
}

// ============ 故事模式解锁进度 ============

/** 读存档：已解锁关卡数（读不到则为 1） */
export function loadStoryProgress() {
  const v = parseInt(readText(KEY_STORY, ''), 10);
  if (v > 0) state.storyUnlocked = v;
  if (DEV_DEBUG_MODE) state.storyUnlocked = LEVELS.length + 1; // 调试模式：全部解锁
}

/** 写存档：已解锁关卡数 */
export function saveStoryProgress() {
  if(account.user)return;
  writeText(KEY_STORY, String(state.storyUnlocked));
}

// ============ 爬塔纪录 ============

/** 读存档：best（各畸变最高层）+ progress（各畸变进行中的层数）+ round（本轮起终点） */
export function loadTowerState() {
  for(const key of Object.keys(state.towerBest)) {
    state.towerBest[key]=0;state.towerProgress[key]=0;state.towerElapsed[key]=0;state.towerRound[key]=null;
  }
  if(account.user) {
    const owner=account.user.id,city=state.currentCityId;
    return api('/tower-progress?city='+encodeURIComponent(city)).then(rows=>{
      if(account.user?.id!==owner || state.currentCityId!==city)return;
      for(const row of rows) if(Object.hasOwn(state.towerBest,row.scenario_key)) {
        state.towerBest[row.scenario_key]=Number(row.best);
        state.towerProgress[row.scenario_key]=Number(row.current_layer);
      }
      updateTowerMenuBest();
    }).catch(error=>setStatus(error.message));
  }
  const v = readJSON(towerKey()) || {};
  const b = v.best || {}, p = v.progress || {}, e = v.elapsed || {}, r = v.round || {};
  // 数据版本变更后，旧存档里的随机起终点可能落在「已删除的线路 / 孤岛」上
  //（边界裁剪、删未完工线都会让站点变），此时丢弃 round（下次开局重新随机），
  // best/progress 只是层数，与站点无关，仍保留。
  const roundValid = v.dataVersion === DATA_VERSION;
  for (const k of Object.keys(state.towerBest)) {
    const bn = parseInt(b[k], 10);
    if (bn > 0) state.towerBest[k] = bn;
    const pn = parseInt(p[k], 10);
    if (pn > 0) state.towerProgress[k] = pn;
    const en = Number(e[k]);
    if (Number.isFinite(en) && en > 0) state.towerElapsed[k] = en;
    if (!roundValid) continue;
    // 校验本轮起终点结构，忽略旧版/损坏的存档，避免污染状态
    const round = r[k];
    if (round && typeof round.layer === 'number' &&
        Array.isArray(round.origin) && Array.isArray(round.dest)) {
      state.towerRound[k] = { layer: round.layer, origin: round.origin, dest: round.dest,startedAt:Number(round.startedAt)||Date.now() };
    }
  }
}

/** 写存档：best + progress + round + dataVersion（按当前城市分开存） */
export function saveTowerState() {
  if(account.user)return;
  writeJSON(towerKey(), { best: state.towerBest, progress: state.towerProgress, elapsed:state.towerElapsed, round: state.towerRound, dataVersion: DATA_VERSION });
}
