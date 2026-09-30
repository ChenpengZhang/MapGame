/**
 * game/custom-menu.js —— 自定义模式的菜单：广场 / 我的关卡组 / 分享码 / 关卡组详情与排行
 *
 * 广场与详情对游客公开；“我的”、创建与编辑需要登录。
 * 分享链接形如 ?map=ABCD2345：页面启动时 openSharedMapFromUrl() 直接打开对应详情。
 */

import { api } from '../core/api.js';
import { account } from '../core/account.js';
import { $, setText, toggleHidden, hide, showCenterToast } from '../core/dom.js';
import { cityById } from '../data/cities.js';
import { TOWER_SCENARIOS } from '../data/levels.js';
import { MAX_LEVEL_SCORE, describeTimeLimit } from '../data/custom-maps.js';
import { showPanel } from '../ui/menu.js';
import { openAccount } from './account-actions.js';
import { startCustomRun } from './custom-play.js';

const SHARE_CODE = /^[A-HJ-NP-Z2-9]{8}$/;
let tab = 'plaza';
let listVersion = 0;
let detailVersion = 0;
let currentMap = null;
let searchTimer = null;

const cityNames = (ids) => (ids || []).map((id) => cityById(id)?.name || id).join('、');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ============ 列表：广场 / 我的 ============

export function openCustomMenu(which = tab) {
  showPanel('custom-menu');
  setTab(which);
}

function setTab(which) {
  tab = which;
  $('custom-tab-plaza')?.classList.toggle('active', tab === 'plaza');
  $('custom-tab-mine')?.classList.toggle('active', tab === 'mine');
  toggleHidden('custom-plaza-tools', tab !== 'plaza');
  void loadList();
}

function listMessage(text) {
  const list = $('custom-list');
  if (!list) return;
  list.replaceChildren(el('p', 'custom-empty', text));
}

async function loadList() {
  const version = ++listVersion;
  if (tab === 'mine' && !account.user) {
    listMessage('登录后可以创建和管理自己的关卡组。');
    return;
  }
  listMessage('正在加载…');
  try {
    const rows = tab === 'mine'
      ? await api('/my/custom-maps')
      : await api(`/custom-maps?${new URLSearchParams({ sort: $('custom-sort')?.value || 'popular', q: $('custom-search')?.value?.trim() || '' })}`);
    if (version !== listVersion) return;
    renderList(rows || []);
  } catch (error) {
    if (version === listVersion) listMessage(error.message);
  }
}

function renderList(rows) {
  const list = $('custom-list');
  if (!list) return;
  if (!rows.length) {
    listMessage(tab === 'mine' ? '你还没有关卡组，点下方“创建关卡组”开始制作。' : '没有找到关卡组。');
    return;
  }
  list.replaceChildren();
  for (const row of rows) {
    const item = el('button', 'custom-item');
    item.type = 'button';
    const head = el('div', 'custom-item-head');
    head.appendChild(el('span', 'custom-item-title', row.title));
    if (tab === 'mine') head.appendChild(el('span', 'custom-badge', row.visibility === 'public' ? '公开' : '仅链接'));
    item.appendChild(head);
    const meta = [`${row.level_count} 关`, cityNames(row.cities), `${row.play_count} 次游玩`];
    if (row.author_name) meta.unshift(row.author_name);
    item.appendChild(el('div', 'custom-item-meta', meta.join(' · ')));
    if (row.description) item.appendChild(el('div', 'custom-item-desc', row.description));
    item.addEventListener('click', () => openCustomDetail(row.code));
    list.appendChild(item);
  }
}

// ============ 详情 ============

/** 打开关卡组详情；summary 为刚打完一组时的本次成绩 */
export async function openCustomDetail(code, { summary = null } = {}) {
  const version = ++detailVersion;
  showPanel('custom-detail');
  currentMap = null;
  setText('custom-detail-title', '正在加载…');
  setText('custom-detail-meta', '');
  setText('custom-detail-desc', '');
  $('custom-detail-levels')?.replaceChildren();
  renderSummary(summary);
  for (const id of ['custom-edit', 'custom-delete']) hide(id);
  toggleHidden('custom-guest-notice', !!account.user);
  const play = $('custom-play');
  if (play) play.disabled = true;
  try {
    const map = await api(`/custom-maps/${code}`);
    if (version !== detailVersion) return;
    currentMap = map;
    renderDetail(map);
    if (play) {
      play.disabled = false;
      play.textContent = summary ? '再玩一次' : '开始挑战';
    }
    void loadBoard(map.code, version);
  } catch (error) {
    if (version === detailVersion) setText('custom-detail-title', error.message);
  }
}

function renderSummary(summary) {
  const box = $('custom-summary');
  if (!box) return;
  toggleHidden('custom-summary', !summary);
  if (!summary) return;
  box.replaceChildren();
  box.appendChild(el('div', 'custom-summary-total', `本次总分 ${summary.total}`));
  box.appendChild(el('div', 'custom-summary-max', `满分 ${summary.count * MAX_LEVEL_SCORE}`));
  const per = el('div', 'custom-summary-levels');
  summary.scores.forEach((score, i) => per.appendChild(el('span', '', `第 ${i + 1} 关 ${score ?? 0}`)));
  box.appendChild(per);
  if (summary.guest) box.appendChild(el('p', 'custom-summary-note', '游客成绩不计入排行，登录后再玩一次即可上榜。'));
}

function renderDetail(map) {
  setText('custom-detail-title', map.title);
  const cities = [...new Set(map.levels.map((level) => level.city))];
  const meta = [`${map.levels.length} 关`, cityNames(cities), `${map.playCount} 次游玩`, `分享码 ${map.code}`];
  if (map.authorName) meta.unshift(`作者 ${map.authorName}`);
  if (map.visibility === 'unlisted') meta.push('仅链接');
  setText('custom-detail-meta', meta.join(' · '));
  setText('custom-detail-desc', map.description || '');
  toggleHidden('custom-detail-desc', !map.description);
  const list = $('custom-detail-levels');
  if (list) {
    list.replaceChildren();
    map.levels.forEach((level, i) => {
      const li = el('li', 'custom-level-row');
      li.appendChild(el('span', 'custom-level-no', String(i + 1)));
      li.appendChild(el('span', 'custom-level-name', level.title || `${cityById(level.city)?.name || level.city} · ${level.originName || '起点'} → ${level.destName || '终点'}`));
      const tags = [cityById(level.city)?.name || level.city];
      if (level.scenario !== 'normal') tags.push(TOWER_SCENARIOS[level.scenario]?.label || level.scenario);
      tags.push(describeTimeLimit(level.timeLimit));
      li.appendChild(el('span', 'custom-level-tags', tags.join(' · ')));
      list.appendChild(li);
    });
  }
  toggleHidden('custom-edit', !map.isOwner);
  toggleHidden('custom-delete', !map.isOwner);
}

function formatElapsed(ms) {
  const seconds = Math.round(Number(ms) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒` : `${seconds}秒`;
}

function boardRow(list, row, own) {
  const tr = el('tr', 'leaderboard-row' + (own ? ' leaderboard-own' : ''));
  for (const value of [`#${row.rank}`, row.name, String(row.total_score), formatElapsed(row.total_elapsed_ms)]) tr.appendChild(el('td', '', value));
  list.appendChild(tr);
}

function boardMessage(text) {
  const list = $('custom-board');
  if (!list) return;
  const tr = el('tr');
  const td = el('td', 'leaderboard-empty', text);
  td.colSpan = 4;
  tr.appendChild(td);
  list.replaceChildren(tr);
}

async function loadBoard(code, version) {
  boardMessage('正在加载排行…');
  try {
    const board = await api(`/leaderboard?${new URLSearchParams({ mode: 'custom', map: code })}`);
    if (version !== detailVersion) return;
    const list = $('custom-board');
    list.replaceChildren();
    const leaders = board?.leaders || [];
    if (!leaders.length && !board?.player) return boardMessage('还没有人完成这个关卡组');
    for (const row of leaders) boardRow(list, row, !!row.is_me);
    if (board?.player) {
      const tr = el('tr');
      const td = el('td', 'leaderboard-divider', '···');
      td.colSpan = 4;
      tr.appendChild(td);
      list.appendChild(tr);
      boardRow(list, board.player, true);
    }
  } catch (error) {
    if (version === detailVersion) boardMessage(error.message);
  }
}

function shareUrl(code) {
  const url = new URL(location.href);
  url.search = `?map=${code}`;
  url.hash = '';
  return url.href;
}

async function copyShareLink() {
  if (!currentMap) return;
  const link = shareUrl(currentMap.code);
  try {
    await navigator.clipboard.writeText(link);
    showCenterToast('已复制分享链接');
  } catch {
    showCenterToast(`分享码 ${currentMap.code}`);
  }
}

async function deleteCurrentMap() {
  if (!currentMap?.isOwner) return;
  if (!confirm(`确定删除“${currentMap.title}”？删除后分享链接失效，排行也会一起删除。`)) return;
  try {
    await api(`/custom-maps/${currentMap.code}`, undefined, 'DELETE');
    showCenterToast('已删除');
    openCustomMenu('mine');
  } catch (error) {
    showCenterToast(error.message);
  }
}

async function openEditor(map) {
  if (!account.user) { openAccount('login'); return; }
  const { openCustomEditor } = await import('./custom-editor.js');
  openCustomEditor(map);
}

/** 页面启动时：URL 带 ?map=分享码 则直接打开该关卡组 */
export function openSharedMapFromUrl() {
  if (typeof location === 'undefined') return;
  const code = new URLSearchParams(location.search).get('map')?.toUpperCase();
  if (code && SHARE_CODE.test(code)) void openCustomDetail(code);
}

/** 绑定自定义菜单的按钮（app.js 启动时调用一次） */
export function bindCustomMenu(showMenu) {
  const on = (id, handler, evt = 'click') => $(id)?.addEventListener(evt, handler);
  on('custom-btn', () => openCustomMenu());
  on('custom-back-btn', showMenu);
  on('custom-tab-plaza', () => setTab('plaza'));
  on('custom-tab-mine', () => setTab('mine'));
  on('custom-sort', () => void loadList(), 'change');
  on('custom-search', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadList(), 300);
  }, 'input');
  on('custom-code-form', (event) => {
    event.preventDefault();
    const code = ($('custom-code-input')?.value || '').trim().toUpperCase();
    if (!SHARE_CODE.test(code)) { showCenterToast('分享码是 8 位字母或数字'); return; }
    void openCustomDetail(code);
  }, 'submit');
  on('custom-create', () => void openEditor(null));
  on('custom-detail-back', () => openCustomMenu());
  on('custom-play', () => { if (currentMap) startCustomRun(currentMap); });
  on('custom-share', copyShareLink);
  on('custom-edit', () => { if (currentMap) void openEditor(currentMap); });
  on('custom-delete', deleteCurrentMap);
}

