/**
 * game/custom-editor.js —— 关卡组编辑器
 *
 * 左侧（手机为底部）面板编辑关卡组信息与关卡列表，地图保持可拖动缩放：
 *   “放置起点 / 放置终点”后点击地图落点；两点都放好后自动用本地寻路验证能否乘车到达并给出最快用时。
 *   保存时服务端会用同样的规则再校验一遍（起终点 ≥1.6km、必须有乘车路线），出错会指出第几关。
 * 编辑期间 state.editorActive = true：站点点击/悬浮不会开始规划。
 */

import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { $, setText, show, hide, toggleHidden, showCenterToast } from '../core/dom.js';
import { findOptimalRoute, haversineKm } from '../core/router-api.js';
import { CITIES, cityById } from '../data/cities.js';
import { TOWER_SCENARIOS, TOWER_KEYS } from '../data/levels.js';
import { CUSTOM_LIMITS } from '../data/custom-maps.js';
import { hideAllPanels } from '../ui/menu.js';
import { createWalkRangeCircle } from '../map/walk-range.js';
import { ensureGameDataReady } from './data-ready.js';

let draft = null;        // { code, title, description, visibility, levels }
let selected = 0;
let placing = null;      // 'origin' | 'dest' | null
let overlays = [];
let mapClickBound = false;
let checkVersion = 0;
let bound = false;

const round6 = (v) => Math.round(v * 1e6) / 1e6;

function newLevel(city) {
  return { city, origin: null, dest: null, originName: '', destName: '', scenario: 'normal', timeLimit: null, title: '', text: '' };
}

/** 服务端只接受这些字段；空字符串的可选文字不提交 */
function levelPayload(level) {
  const out = { city: level.city, origin: level.origin, dest: level.dest, scenario: level.scenario, timeLimit: level.timeLimit };
  for (const key of ['originName', 'destName', 'title', 'text']) {
    const value = (level[key] || '').trim();
    if (value) out[key] = value;
  }
  return out;
}

/** 可选城市：有交通数据的全部城市（故事专用小城市也可以用来出题） */
function cityOptions() {
  return CITIES.slice().sort((a, b) => (a.pinyin || a.id).localeCompare(b.pinyin || b.id));
}

// ============ 打开 / 关闭 ============

export function openCustomEditor(map) {
  bindEditor();
  hideAllPanels();
  state.editorActive = true;
  $('app')?.classList.add('custom-editing');
  show('custom-editor');
  draft = map
    ? { code: map.code, title: map.title, description: map.description || '', visibility: map.visibility,
      levels: map.levels.map((level) => ({ ...newLevel(level.city), ...structuredClone(level) })) }
    : { code: null, title: '', description: '', visibility: 'public', levels: [newLevel(state.loadedCityId || state.currentCityId)] };
  setText('custom-ed-heading', draft.code ? '编辑关卡组' : '创建关卡组');
  $('custom-ed-title').value = draft.title;
  $('custom-ed-desc').value = draft.description;
  $('custom-ed-visibility').value = draft.visibility;
  setText('custom-ed-status', '');
  bindMapClick();
  selectLevel(0);
}

/** 关闭编辑器（不保存）；回主菜单时 session.showMenu 也会调用 */
export function closeCustomEditor() {
  state.editorActive = false;
  placing = null;
  clearOverlays();
  $('app')?.classList.remove('custom-editing');
  hide('custom-editor');
}

// ============ 关卡列表 ============

function renderLevelList() {
  const list = $('custom-ed-levels');
  if (!list) return;
  list.replaceChildren();
  draft.levels.forEach((level, i) => {
    const row = document.createElement('li');
    row.className = 'custom-ed-level' + (i === selected ? ' active' : '');
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'custom-ed-level-pick';
    const ready = level.origin && level.dest;
    pick.textContent = `${i + 1}. ${level.title || cityById(level.city)?.name || level.city}${ready ? '' : '（未放置起终点）'}`;
    pick.addEventListener('click', () => selectLevel(i));
    row.appendChild(pick);
    const tools = [
      ['arrow-up', '上移', () => moveLevel(i, -1), i === 0],
      ['arrow-down', '下移', () => moveLevel(i, 1), i === draft.levels.length - 1],
      ['trash', '删除', () => removeLevel(i), draft.levels.length === 1],
    ];
    for (const [icon, label, action, disabled] of tools) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'custom-ed-icon';
      btn.setAttribute('aria-label', `${label}第 ${i + 1} 关`);
      btn.title = label;
      btn.disabled = disabled;
      btn.innerHTML = `<span class="icon icon-${icon}" aria-hidden="true"></span>`;
      btn.addEventListener('click', action);
      row.appendChild(btn);
    }
    list.appendChild(row);
  });
  const add = $('custom-ed-add');
  if (add) add.disabled = draft.levels.length >= CUSTOM_LIMITS.maxLevels;
}

function moveLevel(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= draft.levels.length) return;
  [draft.levels[i], draft.levels[j]] = [draft.levels[j], draft.levels[i]];
  selectLevel(j);
}

function removeLevel(i) {
  if (draft.levels.length <= 1) return;
  draft.levels.splice(i, 1);
  selectLevel(Math.min(i, draft.levels.length - 1));
}

function addLevel() {
  if (draft.levels.length >= CUSTOM_LIMITS.maxLevels) return;
  draft.levels.push(newLevel(draft.levels[selected]?.city || state.currentCityId));
  selectLevel(draft.levels.length - 1);
}

// ============ 当前关表单 ============

function current() {
  return draft.levels[selected];
}

async function selectLevel(i) {
  selected = i;
  placing = null;
  renderLevelList();
  fillForm();
  const level = current();
  if (!(await ensureGameDataReady(level.city)) || current() !== level) return;
  drawLevel({ fit: true });
  void checkLevel();
}

function fillForm() {
  const level = current();
  setText('custom-ed-level-heading', `第 ${selected + 1} 关`);
  $('custom-ed-city').value = level.city;
  $('custom-ed-origin-name').value = level.originName || '';
  $('custom-ed-dest-name').value = level.destName || '';
  $('custom-ed-scenario').value = level.scenario;
  $('custom-ed-limit-type').value = level.timeLimit?.type || 'none';
  $('custom-ed-limit-value').value = level.timeLimit ? String(level.timeLimit.value) : '';
  $('custom-ed-level-title').value = level.title || '';
  $('custom-ed-level-text').value = level.text || '';
  syncLimitInput();
  renderPlaceButtons();
}

function renderPlaceButtons() {
  const level = current();
  for (const which of ['origin', 'dest']) {
    const btn = $(`custom-ed-place-${which}`);
    if (!btn) continue;
    const label = which === 'origin' ? '起点' : '终点';
    btn.classList.toggle('active', placing === which);
    btn.textContent = placing === which ? `点击地图放置${label}…` : level[which] ? `重新放置${label}` : `放置${label}`;
  }
  setText('custom-ed-hint', placing ? '在地图上点击一个位置；起终点附近 1.5 公里内要有公交或地铁站。' : '');
}

function syncLimitInput() {
  const type = $('custom-ed-limit-type').value;
  const input = $('custom-ed-limit-value');
  toggleHidden('custom-ed-limit-value', type === 'none');
  if (type === 'minutes') { input.min = CUSTOM_LIMITS.minutesMin; input.max = CUSTOM_LIMITS.minutesMax; input.step = 1; input.placeholder = '分钟'; }
  if (type === 'ratio') { input.min = CUSTOM_LIMITS.ratioMin; input.max = CUSTOM_LIMITS.ratioMax; input.step = 0.05; input.placeholder = '最速的倍数，如 1.5'; }
}

function readLimit() {
  const type = $('custom-ed-limit-type').value;
  const value = Number($('custom-ed-limit-value').value);
  if (type === 'none') return null;
  if (type === 'minutes') return { type, value: Math.round(value) };
  return { type, value: Math.round(value * 100) / 100 };
}

async function changeCity() {
  const level = current();
  const city = $('custom-ed-city').value;
  if (city === level.city) return;
  level.city = city;
  level.origin = null;
  level.dest = null;
  renderLevelList();
  renderPlaceButtons();
  if (!(await ensureGameDataReady(city)) || current() !== level) return;
  drawLevel({ fit: true });
  void checkLevel();
}

// ============ 地图：落点与标记 ============

function bindMapClick() {
  if (mapClickBound || !state.map) return;
  mapClickBound = true;
  state.map.on('click', (e) => {
    if (!state.editorActive || !placing || !e?.lnglat) return;
    const ll = e.lnglat;
    const point = [round6(ll.getLng ? ll.getLng() : ll.lng), round6(ll.getLat ? ll.getLat() : ll.lat)];
    const level = current();
    level[placing] = point;
    // 放完起点且还没有终点：接着放终点，少点一次按钮
    placing = placing === 'origin' && !level.dest ? 'dest' : null;
    renderLevelList();
    renderPlaceButtons();
    drawLevel({ fit: false });
    void checkLevel();
  });
}

function clearOverlays() {
  for (const overlay of overlays) overlay.setMap(null);
  overlays = [];
}

function drawLevel({ fit }) {
  clearOverlays();
  const level = current();
  if (!state.map) return;
  for (const [which, label] of [['origin', '起'], ['dest', '终']]) {
    const point = level[which];
    if (!point) continue;
    const circle = createWalkRangeCircle(point);
    circle.setMap(state.map);
    const pin = new AMap.Marker({
      position: point, content: `<div class="pin ${which}">${label}</div>`,
      offset: new AMap.Pixel(-12, -12), zIndex: 400,
    });
    pin.setMap(state.map);
    overlays.push(circle, pin);
  }
  if (!fit) return;
  const points = [level.origin, level.dest].filter(Boolean);
  if (points.length) {
    const pad = 0.02;
    const lngs = points.map((p) => p[0]), lats = points.map((p) => p[1]);
    state.map.setBounds(new AMap.Bounds([Math.min(...lngs) - pad, Math.min(...lats) - pad], [Math.max(...lngs) + pad, Math.max(...lats) + pad]), false, editorPadding());
  } else {
    const center = cityById(level.city)?.center;
    if (center) state.map.setZoomAndCenter(12, new AMap.LngLat(center[0], center[1]), true);
  }
}

/** 适配视野时避开编辑面板：桌面在左侧，手机是底部抽屉 */
function editorPadding() {
  const pad = [70, 40, 40, 40]; // [top, right, bottom, left]
  const rect = $('custom-editor')?.getBoundingClientRect?.();
  const map = $('map')?.getBoundingClientRect?.();
  if (!rect || !map || !rect.width) return pad;
  if (rect.left <= map.left + 1 && rect.width >= map.width - 2) pad[2] = Math.max(pad[2], map.bottom - rect.top + 20);
  else pad[3] = Math.max(pad[3], rect.right - map.left + 20);
  return pad;
}

// ============ 本地验证 ============

/** 与服务端一致：起终点够远、情景下存在乘车方案；显示最快用时供设置时限参考 */
async function checkLevel() {
  const version = ++checkVersion;
  const level = current();
  const out = (text, bad = false) => {
    if (version !== checkVersion) return;
    setText('custom-ed-check', text);
    $('custom-ed-check')?.classList.toggle('bad', bad);
  };
  if (!level.origin || !level.dest) return out('');
  if (haversineKm(level.origin, level.dest) < CUSTOM_LIMITS.minDistanceKm) return out(`起终点太近：需要相距 ${CUSTOM_LIMITS.minDistanceKm} 公里以上。`, true);
  if (state.loadedCityId !== level.city || !state.routerGraph) return out('正在加载城市数据…');
  out('正在计算最快路线…');
  const scenario = (TOWER_SCENARIOS[level.scenario] || TOWER_SCENARIOS.normal).scenario;
  const walkFactor = scenario.walkSpeedFactor || 1;
  try {
    const best = await findOptimalRoute(state.routerGraph, level.origin, level.dest,
      { allowMetro: !scenario.noMetro, busSpeedFactor: scenario.busSpeedFactor, walkSpeedFactor: walkFactor },
      async (a, b) => ({ min: (haversineKm(a, b) * 1000) / (75 * walkFactor) }));
    const rides = (best?.legs || []).filter((leg) => leg.type === 'ride').length;
    if (!best || !rides) return out('没有可行的乘车路线：起终点附近 1.5 公里内需要有能连通的公交或地铁站。', true);
    const minutes = best.totalMin;
    let text = `可以到达 · 最快约 ${minutes.toFixed(1)} 分钟，乘车 ${rides} 段`;
    const limit = level.timeLimit;
    if (limit?.type === 'minutes' && limit.value < minutes) text += ` · 注意：时限 ${limit.value} 分钟比最快还短，没人能在时限内完成`;
    out(text, limit?.type === 'minutes' && limit.value < minutes);
  } catch (error) {
    out('路线计算失败：' + error.message, true);
  }
}

// ============ 保存 ============

function collect() {
  draft.title = $('custom-ed-title').value.trim();
  draft.description = $('custom-ed-desc').value.trim();
  draft.visibility = $('custom-ed-visibility').value;
}

function localProblems() {
  const problems = [];
  if (!draft.title) problems.push('请填写关卡组标题');
  draft.levels.forEach((level, i) => {
    if (!level.origin || !level.dest) problems.push(`第 ${i + 1} 关还没有放置起点和终点`);
    else if (haversineKm(level.origin, level.dest) < CUSTOM_LIMITS.minDistanceKm) problems.push(`第 ${i + 1} 关起终点太近`);
    const limit = level.timeLimit;
    if (limit?.type === 'minutes' && !(limit.value >= CUSTOM_LIMITS.minutesMin && limit.value <= CUSTOM_LIMITS.minutesMax)) {
      problems.push(`第 ${i + 1} 关时限需在 ${CUSTOM_LIMITS.minutesMin}–${CUSTOM_LIMITS.minutesMax} 分钟之间`);
    }
    if (limit?.type === 'ratio' && !(limit.value >= CUSTOM_LIMITS.ratioMin && limit.value <= CUSTOM_LIMITS.ratioMax)) {
      problems.push(`第 ${i + 1} 关时限倍数需在 ${CUSTOM_LIMITS.ratioMin}–${CUSTOM_LIMITS.ratioMax} 之间`);
    }
  });
  return problems;
}

async function save() {
  collect();
  const problems = localProblems();
  if (problems.length) { setText('custom-ed-status', problems[0]); return; }
  const body = { title: draft.title, description: draft.description, visibility: draft.visibility, levels: draft.levels.map(levelPayload) };
  const button = $('custom-ed-save');
  if (button) button.disabled = true;
  setText('custom-ed-status', '正在保存并校验每一关…');
  try {
    const saved = draft.code
      ? await api(`/custom-maps/${draft.code}`, body, 'PUT')
      : await api('/custom-maps', body);
    closeCustomEditor();
    showCenterToast(`已保存 · 分享码 ${saved.code}`);
    const { openCustomDetail } = await import('./custom-menu.js');
    openCustomDetail(saved.code);
  } catch (error) {
    setText('custom-ed-status', error.message);
    const match = /^[A-Z_]+:(\d+)$/.exec(error.code || '');
    if (match) selectLevel(Number(match[1]) - 1);
  } finally {
    if (button) button.disabled = false;
  }
}

async function cancel() {
  closeCustomEditor();
  const { openCustomMenu, openCustomDetail } = await import('./custom-menu.js');
  if (draft?.code) openCustomDetail(draft.code);
  else openCustomMenu('mine');
}

// ============ 事件绑定（首次打开时一次） ============

function bindEditor() {
  if (bound) return;
  bound = true;
  const citySelect = $('custom-ed-city');
  if (citySelect) {
    citySelect.replaceChildren(...cityOptions().map((city) => new Option(city.name, city.id)));
  }
  const scenarioSelect = $('custom-ed-scenario');
  if (scenarioSelect) {
    scenarioSelect.replaceChildren(...TOWER_KEYS.map((key) => new Option(`${TOWER_SCENARIOS[key].label} · ${TOWER_SCENARIOS[key].sub}`, key)));
  }
  const on = (id, handler, evt = 'click') => $(id)?.addEventListener(evt, handler);
  on('custom-ed-add', addLevel);
  on('custom-ed-city', () => void changeCity(), 'change');
  on('custom-ed-place-origin', () => { placing = placing === 'origin' ? null : 'origin'; renderPlaceButtons(); });
  on('custom-ed-place-dest', () => { placing = placing === 'dest' ? null : 'dest'; renderPlaceButtons(); });
  const text = (id, key) => on(id, () => { current()[key] = $(id).value; if (key === 'title') renderLevelList(); }, 'input');
  text('custom-ed-origin-name', 'originName');
  text('custom-ed-dest-name', 'destName');
  text('custom-ed-level-title', 'title');
  text('custom-ed-level-text', 'text');
  on('custom-ed-scenario', () => { current().scenario = $('custom-ed-scenario').value; void checkLevel(); }, 'change');
  on('custom-ed-limit-type', () => {
    const type = $('custom-ed-limit-type').value;
    if (type === 'minutes') $('custom-ed-limit-value').value = '60';
    if (type === 'ratio') $('custom-ed-limit-value').value = '1.5';
    syncLimitInput();
    current().timeLimit = readLimit();
    void checkLevel();
  }, 'change');
  on('custom-ed-limit-value', () => { current().timeLimit = readLimit(); void checkLevel(); }, 'input');
  on('custom-ed-save', () => void save());
  on('custom-ed-cancel', () => void cancel());
}

