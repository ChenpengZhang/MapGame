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

import { $, show, hide, setText, toggleHidden } from '../core/dom.js';

/**
 * 显示结果弹窗。
 * @param {object} cfg
 * @param {string} [cfg.title]            标题（恭喜！/ 止步第 N 层）
 * @param {string} [cfg.message]          主文案（成败台词 / 下一层要求 / 最高纪录）
 * @param {string} [cfg.detail]           明细行（用时、最快、时限…）
 * @param {string} [cfg.restartLabel]     "重开"按钮文案（下一层 / 重新挑战）
 * @param {string} [cfg.nextLabel]        "下一关"按钮文案
 * @param {boolean} [cfg.showNext]        是否显示"下一关"（爬塔恒不显示）
 * @param {boolean} [cfg.showExit]        是否显示立即退出
 * @param {object} [cfg.sign]           结算站牌（见 renderSign）
 * @param {string} [cfg.viewMapLabel]     收起弹窗看地图的按钮文案（默认“查看最快”）
 *   传入 undefined 的字段保持原值不动（与重构前逐字段赋值的行为一致）。
 */
/** 站牌三种结果：站名、拼音读音、罗马字（英文） */
const SIGN_OUTCOMES = {
  pass: { name: '通过', en: 'Passed', cls: 'pass' },
  fail: { name: '未通过', en: 'Failed', cls: 'fail' },
  done: { name: '完成', en: 'Finished', cls: 'pass' },
};

/**
 * 结算站牌。cfg.sign = { outcome: 'pass'|'fail'|'done', left, right, leftEn, rightEn }；
 * 不传 sign（如“正在验证…”“记录尚未确认保存”）则隐藏站牌、显示普通标题。
 */
function renderSign(sign) {
  const el = $('result-sign');
  if (!el) return null;
  const cfg = sign && SIGN_OUTCOMES[sign.outcome];
  if (!cfg) { el.classList.add('hidden'); return null; }
  el.className = 'result-sign ' + cfg.cls;
  setText('result-sign-name', cfg.name);
  setText('result-sign-reading', cfg.en); // 站名下方的英文（原为拼音）
  return cfg;
}

/** 按钮文案对应的罗马字（显示在线带下方，与站牌“相邻站”的英文位置一致） */
const BUTTON_EN = {
  下一关: 'Next', 下一层: 'Next floor', 重新开始: 'Restart', 重新挑战: 'Retry', 再试一次: 'Try again',
  退出: 'Exit', '通关·回菜单': 'Finish', 查看最快: 'View fastest', 查看地图: 'View map',
};
function buttonEn(btn) {
  return btn ? (BUTTON_EN[btn.textContent.trim()] || '') : '';
}

/**
 * 把按钮、说明和用时放进站牌：线带三段就是按钮。
 *   主操作（有“下一关”时是它，否则是“重开/下一层/再试一次/重新挑战”）放在箭头一侧：通过在右、未通过在左；
 *   次操作（有下一关时的“重新开始”，或爬塔通过后的“退出”）放在另一侧；中间方块是“查看地图/最快”。
 * 没有站牌（“正在验证…”等）时把它们放回普通按钮区。
 */
function placeIntoSign(cfg) {
  const inner = document.querySelector?.('.result-inner');
  const btns = document.querySelector?.('.result-btns');
  const next = $('result-next'), restart = $('result-restart'), viewmap = $('result-viewmap'), exit = $('result-exit');
  const message = $('result-message'), times = $('result-times');
  if (!inner || !btns || !next || !restart) return;
  inner.classList.toggle('has-sign', !!cfg);
  if (!cfg) {
    const title = $('result-title');
    if (title && message) title.after?.(message);
    if (message && times) message.after?.(times);
    for (const b of [restart, viewmap, next, exit]) if (b) btns.appendChild(b);
    return;
  }
  $('result-slot-message')?.appendChild(message);
  $('result-slot-times')?.appendChild(times);
  const shown = (b) => b && !b.classList.contains('hidden');
  const primary = shown(next) ? next : restart;
  const secondary = shown(next) ? restart : (shown(exit) ? exit : null);
  const [left, right] = cfg.cls === 'pass' ? [secondary, primary] : [primary, secondary];
  const slotL = $('result-slot-left'), slotR = $('result-slot-right'), slotC = $('result-slot-center');
  slotL.replaceChildren(); slotR.replaceChildren(); slotC.replaceChildren();
  // 用不到的按钮仍保留在普通按钮区（该区在站牌模式下隐藏）
  for (const b of [restart, viewmap, next, exit]) if (b) btns.appendChild(b);
  if (left) slotL.appendChild(left);
  if (right) slotR.appendChild(right);
  if (viewmap) slotC.appendChild(viewmap);
  setText('result-sign-left-en', buttonEn(left));
  setText('result-sign-right-en', buttonEn(right));
  setText('result-sign-en', shown(viewmap) ? buttonEn(viewmap) : '');
}

/** 爬塔结算站牌：通过 = 第 n 层 → 第 n+1 层（箭头向右）；未通过 = 箭头向左退回第 1 层 */
export function towerSign(pass, layer) {
  return pass
    ? { outcome: 'pass', left: `第 ${layer} 层`, right: `第 ${layer + 1} 层`, leftEn: `Floor ${layer}`, rightEn: `Floor ${layer + 1}` }
    : { outcome: 'fail', left: '第 1 层', right: `第 ${layer} 层`, leftEn: 'Floor 1', rightEn: `Floor ${layer}` };
}

export function showResultOverlay(cfg) {
  cfg = cfg || {};
  const signCfg = renderSign(cfg.sign);
  const outcome = SIGN_OUTCOMES[cfg.sign?.outcome]?.cls || 'none';
  const inner = document.querySelector?.('.result-inner');
  if (inner) inner.className = 'result-inner outcome-' + outcome;
  setText('result-sync','');hide('result-sync');hide('result-retry');show('result-restart');
  if (cfg.title != null) setText('result-title', cfg.title);
  if (cfg.message != null) { setText('result-message', cfg.message);toggleHidden('result-message',!cfg.message); }
  if (cfg.detail != null) { setText('result-times', cfg.detail);toggleHidden('result-times',!cfg.detail); }
  if (cfg.restartLabel != null) setText('result-restart', cfg.restartLabel);
  if (cfg.nextLabel != null) setText('result-next', cfg.nextLabel);
  if (cfg.showNext != null) toggleHidden('result-next', !cfg.showNext);
  toggleHidden('result-exit', !cfg.showExit);

  // “查看最快”：有最优路线可看时的默认文案；每日挑战不公布最优，改为“查看地图”
  setText('result-viewmap', cfg.viewMapLabel || '查看最快');
  show('result-viewmap');
  // 主按钮：有“下一关”时是它，否则是“重开/下一层/再试一次”；按结果着线路色（无站牌时使用）
  const nextShown = !$('result-next')?.classList.contains('hidden');
  $('result-next')?.classList.toggle('primary', nextShown);
  $('result-restart')?.classList.toggle('primary', !nextShown);
  placeIntoSign(signCfg);
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
