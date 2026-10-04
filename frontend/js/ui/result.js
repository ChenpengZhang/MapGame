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
import { state } from '../core/state.js';

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
 * @param {object} [cfg.sign]           { outcome: 'pass'|'fail'|'done' }：右上角结果牌与主按钮配色
 * @param {string} [cfg.viewMapLabel]     收起弹窗看地图的按钮文案（默认“查看最快”）
 *   传入 undefined 的字段保持原值不动（与重构前逐字段赋值的行为一致）。
 */
/** 结算站牌右上角的“线路牌”：通过绿、未通过红、完成灰 */
const SIGN_OUTCOMES = {
  pass: { name: 'PASSED', cls: 'pass' },
  fail: { name: 'FAILED', cls: 'fail' },
  done: { name: 'FINISHED', cls: 'done' },
};

/** 右上角结果牌；不传 sign（如“正在验证…”）则隐藏 */
function renderBadge(sign) {
  const cfg = sign && SIGN_OUTCOMES[sign.outcome];
  const badge = $('result-badge');
  if (badge) {
    badge.className = 'result-badge ' + (cfg ? cfg.cls : 'hidden');
    badge.textContent = cfg ? cfg.name : '';
  }
  return cfg;
}

/**
 * 明细写成站牌上的“站点列表”：竖线串起圆点，每项一行（标签在左、数值在右），第一项是红色的“本站”。
 * detail 仍以纯文本写入（无障碍与测试读取），再在真实 DOM 中替换为逐行结构。
 */
function renderRows(detail) {
  const box = $('result-times');
  if (!box) return;
  box.textContent = detail;
  // 只在真实浏览器 DOM 中改成逐行结构（测试桩只读纯文本）
  if (!detail || typeof HTMLElement === 'undefined' || !(box instanceof HTMLElement)) return;
  const parts = detail.split(/\s*·\s*/).map((part) => part.trim()).filter(Boolean);
  const rows = parts.map((part) => {
    const row = document.createElement('li');
    // 带括号的条目整行显示，不拆成“标签 + 数值”（否则括号会被拆到两边）
    const match = /[（()）]/.test(part) ? null : /^(.+?)\s+([\d.]+\s*\S*)$/.exec(part);
    if (match) {
      const label = document.createElement('span');
      label.className = 'row-label';
      label.textContent = match[1];
      const value = document.createElement('span');
      value.className = 'row-value';
      value.textContent = match[2];
      row.appendChild(label);
      row.appendChild(value);
    } else {
      row.className = 'row-note';
      row.textContent = part;
    }
    return row;
  });
  if (rows.length) box.replaceChildren(...rows);
}

/** 爬塔结算（保留旧接口）：只需要成败 */
export function towerSign(pass) {
  return { outcome: pass ? 'pass' : 'fail' };
}

export function showResultOverlay(cfg) {
  cfg = cfg || {};
  const signCfg = renderBadge(cfg.sign);
  const outcome = signCfg?.cls || 'none';
  const inner = document.querySelector?.('.result-inner');
  if (inner) inner.className = 'result-inner outcome-' + outcome;
  setText('result-sync','');hide('result-sync');hide('result-retry');show('result-restart');
  // 左上角副标题：当前关卡的名称（如“新手教程”“无尽模式 · 普通”“某关卡组 · 第 1/3 关”）
  setText('result-kicker', cfg.kicker || state.currentLevel?.title || '本次行程');
  if (cfg.title != null) setText('result-title', cfg.title);
  if (cfg.message != null) { setText('result-message', cfg.message);toggleHidden('result-message',!cfg.message); }
  if (cfg.detail != null) { renderRows(cfg.detail);toggleHidden('result-times',!cfg.detail); }
  if (cfg.restartLabel != null) setText('result-restart', cfg.restartLabel);
  if (cfg.nextLabel != null) setText('result-next', cfg.nextLabel);
  if (cfg.showNext != null) toggleHidden('result-next', !cfg.showNext);
  toggleHidden('result-exit', !cfg.showExit);
  // 没有“下一关/退出”可走时（如教程完成、每日挑战），给一个回到主页的出口
  toggleHidden('result-home', !!cfg.showNext || !!cfg.showExit);

  // “查看最快”：有最优路线可看时的默认文案；每日挑战不公布最优，改为“查看地图”
  setText('result-viewmap', cfg.viewMapLabel || '查看最快');
  show('result-viewmap');
  // 主按钮：有“下一关”时是它，否则是“重开/下一层/再试一次”；按结果着线路色
  const nextShown = !$('result-next')?.classList.contains('hidden');
  $('result-next')?.classList.toggle('primary', nextShown);
  $('result-restart')?.classList.toggle('primary', !nextShown);
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
