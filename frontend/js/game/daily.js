/**
 * game/daily.js —— 每日挑战入口面板
 *
 * 每天（北京时间切日）全站同一道题，由服务端生成并持久化；只有登录玩家能挑战，
 * 每天可多次尝试，排行榜按个人当日最好成绩排名。
 * 本模块只负责面板：今日题目概况、倒计时、我的成绩与当日排行，以及“开始挑战”。
 * 真正开局、提交与结算复用 online.js 的正式对局流程（mode: 'daily'）。
 */

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { account } from '../core/account.js';
import { $, setText, toggleHidden, showCenterToast } from '../core/dom.js';
import { cityById } from '../data/cities.js';
import { showPanel } from '../ui/menu.js';
import { openAccount } from './account-actions.js';
import { startOnline } from './online.js';
import { showDailyAnswer } from './daily-answer.js';

let dailyInfo = null;     // GET /daily 的结果（缓存到切日）
let countdownTimer = null;
let requestVersion = 0;

/** 今日题目概况；已过截止时间则重新获取（进入新的一天） */
export async function fetchDaily() {
  if (dailyInfo && Date.now() < Date.parse(dailyInfo.closesAt)) return dailyInfo;
  dailyInfo = await api('/daily');
  return dailyInfo;
}

function formatMinutes(ms) {
  return (Math.max(0, Number(ms) || 0) / 60000).toFixed(1) + ' 分钟';
}

function formatRemaining(closesAt) {
  const left = Math.max(0, Date.parse(closesAt) - Date.now());
  const hours = Math.floor(left / 3600000);
  const minutes = Math.floor(left / 60000) % 60;
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

function renderInfo() {
  if (!dailyInfo) return;
  const city = cityById(dailyInfo.city)?.name || dailyInfo.city;
  setText('daily-info', `${dailyInfo.date} · ${city} · 距本题截止还有 ${formatRemaining(dailyInfo.closesAt)}`);
}

/** 完成时刻（第二排名键：同用时更早完成者靠前），统一按北京时间（UTC+8）显示 时:分:秒，与每日题目的日期边界一致 */
function formatAchieved(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function boardRow(list, row, own) {
  const tr = document.createElement('tr');
  tr.className = 'leaderboard-row' + (own ? ' leaderboard-own' : '');
  for (const value of [`#${row.rank}`, row.name, formatMinutes(row.duration_ms), formatAchieved(row.achieved_at)]) {
    const td = document.createElement('td');
    td.textContent = value;
    tr.appendChild(td);
  }
  list.appendChild(tr);
}

function boardMessage(text, listId = 'daily-board') {
  const list = $(listId);
  if (!list) return;
  list.replaceChildren();
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 4;
  td.className = 'leaderboard-empty';
  td.textContent = text;
  tr.appendChild(td);
  list.appendChild(tr);
}

/** 拉取某日排行并填入表格；返回服务端结果（失败时在表格里显示错误并返回 null） */
async function fillBoard(listId, date, version, emptyText) {
  boardMessage('正在加载排行…', listId);
  try {
    const board = await api(`/leaderboard?${new URLSearchParams({ mode: 'daily', date })}`);
    if (version !== requestVersion) return null;
    const list = $(listId);
    list.replaceChildren();
    const leaders = board?.leaders || [];
    if (!leaders.length && !board?.player) boardMessage(emptyText, listId);
    for (const row of leaders) boardRow(list, row, !!row.is_me);
    if (board?.player) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'leaderboard-divider';
      td.textContent = '···';
      tr.appendChild(td);
      list.appendChild(tr);
      boardRow(list, board.player, true);
    }
    return board;
  } catch (error) {
    if (version === requestVersion) boardMessage(error.message, listId);
    return null;
  }
}

/** 当日排行 + 我的最好成绩（服务端只返回前 20 名；我不在前 20 时单独附带我的名次） */
async function loadBoard(version) {
  const board = await fillBoard('daily-board', dailyInfo.date, version, '今天还没有人完成，来当第一个吧');
  if (!board) return;
  const mine = board.player || (board.leaders || []).find((row) => row.is_me);
  setText('daily-mine', mine ? `今日最好 ${formatMinutes(mine.duration_ms)} · 第 ${mine.rank} 名` : '');
}

/** 题目日期的前一天（YYYY-MM-DD，按日历日计算，与时区无关） */
export function previousDate(date) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 昨日排行（侧栏，已截止的最终名次） */
async function loadYesterdayBoard(version) {
  const date = previousDate(dailyInfo.date);
  setText('daily-yesterday-date', date);
  await fillBoard('daily-yesterday-board', date, version, '昨天没有人完成');
}

// ============ 昨日排行侧栏：可折叠到屏幕右缘 ============
const YESTERDAY_COLLAPSED_KEY = 'mg_daily_yesterday_collapsed';

function setYesterdayCollapsed(collapsed) {
  const aside = $('daily-yesterday');
  if (!aside) return;
  aside.classList.toggle('collapsed', collapsed);
  const toggle = $('daily-yesterday-toggle');
  if (toggle) {
    toggle.setAttribute?.('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute?.('aria-label', collapsed ? '展开昨日排行' : '收起昨日排行');
  }
  try { localStorage.setItem(YESTERDAY_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* 存储不可用时只影响本次 */ }
}

function initYesterdayPanel() {
  const toggle = $('daily-yesterday-toggle');
  if (!toggle || toggle.__bound) return;
  toggle.__bound = true;
  let saved = null;
  try { saved = localStorage.getItem(YESTERDAY_COLLAPSED_KEY); } catch { /* 忽略 */ }
  // 默认：宽屏展开；手机或窄窗口收起（侧栏会盖住中间的今日排行）
  const narrow = typeof window !== 'undefined' && window.innerWidth < 1180;
  setYesterdayCollapsed(saved != null ? saved === '1' : (!!state.isTouch || narrow));
  toggle.addEventListener('click', () => setYesterdayCollapsed(!$('daily-yesterday').classList.contains('collapsed')));
  // 查看昨日答案：地图上画出最快路线（服务端只公开已截止的题目）
  $('daily-yesterday-answer')?.addEventListener('click', () => {
    if (dailyInfo) void showDailyAnswer(previousDate(dailyInfo.date));
  });
}

/** 打开每日挑战面板 */
export async function openDailyMenu() {
  const version = ++requestVersion;
  showPanel('daily-menu');
  setText('daily-mine', '');
  toggleHidden('daily-guest-notice', !!account.user);
  const start = $('daily-start');
  if (start) {
    start.textContent = account.user ? '开始挑战' : '登录后挑战';
    start.disabled = true;
  }
  try {
    await fetchDaily();
    if (version !== requestVersion) return;
    renderInfo();
    if (start) start.disabled = false;
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      if ($('daily-menu')?.classList.contains('hidden')) { clearInterval(countdownTimer); countdownTimer = null; return; }
      renderInfo();
    }, 30000);
    initYesterdayPanel();
    await Promise.all([loadBoard(version), loadYesterdayBoard(version)]);
  } catch (error) {
    if (version === requestVersion) setText('daily-info', '今日题目获取失败：' + error.message);
  }
}

/** 开始（或再次）挑战今日题目；游客先登录 */
export async function startDaily() {
  if (!account.user) { openAccount('login'); return; }
  try {
    const info = await fetchDaily();
    if (Date.now() >= Date.parse(info.closesAt)) {
      showCenterToast('今日题目已截止，请重新打开每日挑战');
      return;
    }
    await startOnline({ mode: 'daily' }, { city: info.city, date: info.date });
  } catch (error) {
    showCenterToast(error.message);
  }
}
