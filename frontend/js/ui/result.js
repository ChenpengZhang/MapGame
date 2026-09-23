/**
 * ui/result.js —— 结果弹窗（哑渲染层）
 *
 * 【设计要点】
 *   弹窗只有一套 DOM（#result-overlay），两类内容共用它：
 *     关卡结算（game/flow.js）：成败文案 + 时限 + "下一关"
 *     爬塔结算（game/tower.js）：层数判定 + "下一层/重新挑战" + "从第 1 层重来"
 *   所以本模块只提供"设哪些字段、显哪些按钮"，判定逻辑一律在 game 层。
 *   这样将来加新模式（排位等）不需要再改这里。
 *
 * 【三个显隐函数的分工】
 *   showResultOverlay  开弹窗
 *   hideResultOverlay  "查看地图"：只收弹窗，保留右下角的"查看结果"按钮
 *   clearResult        彻底清掉（切关卡/回菜单时用，连按钮一起收）
 */

import { show, hide, setText, toggleHidden } from '../core/dom.js';

/**
 * 显示结果弹窗。
 * @param {object} cfg
 * @param {string} [cfg.title]            标题（🎉 恭喜！/ 💀 止步第 N 层）
 * @param {string} [cfg.message]          主文案（成败台词 / 下一层要求 / 最高纪录）
 * @param {string} [cfg.detail]           明细行（用时、最快、时限…）
 * @param {string} [cfg.restartLabel]     "重开"按钮文案（下一层 / 重新挑战）
 * @param {string} [cfg.nextLabel]        "下一关"按钮文案
 * @param {boolean} [cfg.showNext]        是否显示"下一关"（爬塔恒不显示）
 * @param {boolean} [cfg.showExit]        是否显示立即退出
 *   传入 undefined 的字段保持原值不动（与重构前逐字段赋值的行为一致）。
 */
export function showResultOverlay(cfg) {
  cfg = cfg || {};
  setText('result-sync','');hide('result-sync');hide('result-retry');show('result-restart');
  if (cfg.title != null) setText('result-title', cfg.title);
  if (cfg.message != null) { setText('result-message', cfg.message);toggleHidden('result-message',!cfg.message); }
  if (cfg.detail != null) { setText('result-times', cfg.detail);toggleHidden('result-times',!cfg.detail); }
  if (cfg.restartLabel != null) setText('result-restart', cfg.restartLabel);
  if (cfg.nextLabel != null) setText('result-next', cfg.nextLabel);
  if (cfg.showNext != null) toggleHidden('result-next', !cfg.showNext);
  toggleHidden('result-exit', !cfg.showExit);

  show('result-viewmap');
  hide('result-toggle-btn');
  show('result-overlay');
}

/** "查看地图"：收起弹窗，留下"查看结果"按钮以便再打开 */
export function hideResultOverlay() {
  hide('result-overlay');
  show('result-toggle-btn');
}

/** 彻底清掉弹窗与"查看结果"按钮（重开一局、回菜单时调用） */
export function clearResult() {
  hide('result-overlay');
  hide('result-toggle-btn');
}
