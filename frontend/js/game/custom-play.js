/**
 * game/custom-play.js —— 自定义关卡组的游玩流程
 *
 * 一组 1~10 关，依次游玩，每关计分（满分 5000，见 data/custom-maps.js），结束后回到关卡组详情页看总分与排行。
 *   登录玩家：走服务端正式对局（mode:'custom'），路线由服务端重算、计分、进排行；回合推进用 /runs/:id/next。
 *   游客：本地游玩，用本地最优路线计分，不上传、不进排行。
 * 进行中的状态放在 state.customPlay = { map, index, total, scores, online }；回主菜单时清空。
 */

import { state } from '../core/state.js';
import { account } from '../core/account.js';
import { TOWER_SCENARIOS } from '../data/levels.js';
import { MAX_LEVEL_SCORE, customLevelScore, customLimitMs, describeTimeLimit } from '../data/custom-maps.js';
import { computeTotalMinutes } from './time-model.js';
import { startLevel, showMenu } from './session.js';
import { startOnline, advanceOnlineRound } from './online.js';
import { showResultOverlay } from '../ui/result.js';

/** 关卡组第 index 关 → startLevel 用的关卡对象 */
export function customLevelView(map, index, totalScore = 0) {
  const def = map.levels[index];
  const count = map.levels.length;
  const scenario = TOWER_SCENARIOS[def.scenario] || TOWER_SCENARIOS.normal;
  const hud = [`第 ${index + 1}/${count} 关`, `累计 ${totalScore} 分`];
  if (def.timeLimit) hud.push(describeTimeLimit(def.timeLimit));
  if (def.scenario !== 'normal') hud.push(scenario.label);
  const story = def.title || def.text
    ? [{ type: 'narration', text: [def.title, def.text].filter(Boolean).join('\n') }]
    : null;
  return {
    id: 'custom',
    mode: 'random',
    cityId: def.city,
    title: `${map.title} · 第 ${index + 1}/${count} 关`,
    hudText: hud.join(' · '),
    goalText: def.title || '规划最快的路线',
    origin: { name: def.originName || '起点', lng: def.origin[0], lat: def.origin[1] },
    dest: { name: def.destName || '终点', lng: def.dest[0], lat: def.dest[1] },
    story,
    customTimeLimit: def.timeLimit || null,
    customScenarioKey: def.scenario,
  };
}

/** 情景 key → startLevel 的 scenario 覆盖（含盲棋/真实乘坐这类只影响呈现的标志） */
export function customScenario(key) {
  return { ...(TOWER_SCENARIOS[key] || TOWER_SCENARIOS.normal).scenario };
}

export function isCustomPlaying() {
  return !!state.customPlay;
}

/** 开始（或继续）一个关卡组 */
export function startCustomRun(map, { restart = false } = {}) {
  const online = !!account.user;
  state.customPlay = { map, index: 0, total: 0, scores: [], online };
  if (online) return startOnline({ mode: 'custom', map: map.code, ...(restart ? { restart: true } : {}) }, { customMap: map });
  playLocalLevel(0);
}

function playLocalLevel(index) {
  const play = state.customPlay;
  play.index = index;
  const level = customLevelView(play.map, index, play.total);
  startLevel(level, { skipStory: !level.story, scenario: customScenario(level.customScenarioKey) });
}

/** 游客本地结算：本地最优路线算好后调用（game/flow.js 订阅 OPTIMAL_READY） */
export function showLocalCustomResult() {
  const play = state.customPlay;
  if (!play || play.online) return;
  const durationMs = Math.round(computeTotalMinutes() * 60000);
  const optimalMs = Math.round((state.optimalResult?.totalMin || 0) * 60000);
  const limitMs = customLimitMs(play.map.levels[play.index].timeLimit, optimalMs);
  const score = customLevelScore(durationMs, optimalMs, limitMs);
  play.scores[play.index] = score;
  play.total = play.scores.reduce((sum, value) => sum + (value || 0), 0);
  showCustomLevelResult({
    score, durationMs, optimalMs, limitMs, passed: limitMs == null || durationMs <= limitMs,
    totalScore: play.total, index: play.index, count: play.map.levels.length, guest: true,
  });
}

/** 服务端结算结果（online.js 收到 /submit 响应后调用） */
export function showOnlineCustomResult(result, stage) {
  const play = state.customPlay;
  if (!play) return;
  const index = stage.puzzle.levelIndex;
  play.index = index;
  play.scores[index] = Number(result.score) || 0;
  play.total = Number(result.total_score) || 0;
  showCustomLevelResult({
    score: play.scores[index],
    durationMs: Number(result.duration_ms),
    optimalMs: Number(result.optimal_duration_ms),
    limitMs: result.limit_ms == null ? null : Number(result.limit_ms),
    passed: !!result.passed,
    totalScore: play.total,
    index,
    count: Number(result.level_count) || play.map.levels.length,
  });
}

function showCustomLevelResult({ score, durationMs, optimalMs, limitMs, passed, totalScore, index, count, guest }) {
  const minutes = (ms) => (ms / 60000).toFixed(1);
  const last = index + 1 >= count;
  let detail = `你的用时 ${minutes(durationMs)} 分钟`;
  if (optimalMs > 0) detail += ` · 最快 ${minutes(optimalMs)} 分钟`;
  if (limitMs != null) detail += ` · 时限 ${minutes(limitMs)} 分钟`;
  detail += ` · 累计 ${totalScore} 分`;
  if (guest) detail += ' · 游客成绩不计入排行';
  showResultOverlay({
    title: `本关 ${score} 分`,
    message: passed ? `本关得分 ${score} / ${MAX_LEVEL_SCORE}` : `超出时限，本关 0 分`,
    detail,
    sign: { outcome: passed ? 'pass' : 'fail' },
    nextLabel: last ? '查看总分' : '下一关',
    showNext: true,
    restartLabel: '重玩整组',
    showExit: false,
  });
}

/** “下一关 / 查看总分” */
export async function nextCustomLevel() {
  const play = state.customPlay;
  if (!play) return;
  const count = play.map.levels.length;
  if (play.index + 1 >= count) return finishCustomRun();
  if (play.online) return advanceOnlineRound();
  playLocalLevel(play.index + 1);
}

/** “重玩整组”：从第 1 关重新开始（登录玩家会作废进行中的对局） */
export function restartCustomRun() {
  const play = state.customPlay;
  if (!play) return;
  return startCustomRun(play.map, { restart: true });
}

/** 整组完成：回到关卡组详情页，展示本次总分与排行 */
async function finishCustomRun() {
  const play = state.customPlay;
  const summary = { total: play.total, scores: play.scores.slice(), count: play.map.levels.length, guest: !play.online };
  const code = play.map.code;
  showMenu();
  const { openCustomDetail } = await import('./custom-menu.js');
  if (code) openCustomDetail(code, { summary });
  else openCustomDetail(null, { summary, draft: play.map });
}
