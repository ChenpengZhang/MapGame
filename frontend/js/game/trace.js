/**
 * game/trace.js —— 规划过程记录（玩家行为分析用，不参与计分）
 *
 * 每局记录一串关键操作（预览站点、选/取消线路、确认站点、乘车/步行到某站、撤回、取消、强制步行、
 * 全图显示、被拒绝的点击、完成），每条带“开局后多少毫秒”。玩家完成路线时上报一次；
 * 中途离开（回主页、开下一局、刷新/关闭页面、切到后台）时把当时的过程和半成品路线作为“放弃”上报；
 * 同一局用同一个 id，之后又完成会覆盖为“完成”（服务端按 id 更新为最新）。
 * 登录玩家的记录会关联到对应的正式对局；游客用每个浏览器一个随机匿名 id。
 *
 * 事件格式：{ t: 毫秒, e: 类型, …少量字段 }，字段名保持很短；单局最多 2000 条。
 */

import { state } from '../core/state.js';
import { EVENTS, on } from '../core/bus.js';
import { computeTotalMinutes } from './time-model.js';

const ENDPOINT = '/mapgame/api/traces';
const MAX_EVENTS = 2000;
const KEEPALIVE_LIMIT = 60000; // 页面关闭时用 keepalive 上报，浏览器限制约 64KB

let trace = null;        // 当前这一局
let sessionAnonId = null; // localStorage 不可用时，本次会话内的匿名 id

function enabled() {
  return typeof fetch === 'function'
    && typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
}

/** 每个浏览器一个随机匿名 id（不含任何个人信息） */
function anonId() {
  try {
    let id = localStorage.getItem('mg_anon_id');
    if (!/^[0-9a-f-]{36}$/.test(id || '')) {
      id = crypto.randomUUID();
      localStorage.setItem('mg_anon_id', id);
    }
    return id;
  } catch {
    return (sessionAnonId ||= crypto.randomUUID());
  }
}

function modeOf(level) {
  const online = state.onlineRound?.command?.mode;
  if (online) return online;
  if (state.towerActive) return 'tower';
  if (state.customPlay) return 'custom';
  return level?.mode === 'random' ? 'free' : 'story';
}

function scenarioFlags() {
  const s = state.scenario || {};
  const out = {};
  for (const key of ['noMetro', 'blindMap', 'realRide']) if (s[key]) out[key] = true;
  if (s.busSpeedFactor && s.busSpeedFactor !== 1) out.bus = s.busSpeedFactor;
  if (s.walkSpeedFactor && s.walkSpeedFactor !== 1) out.walk = s.walkSpeedFactor;
  return out;
}

function levelIdOf(level, mode) {
  if (mode === 'custom' && state.customPlay?.map?.code) return `${state.customPlay.map.code}:${state.customPlay.index ?? 0}`;
  if (mode === 'story') return level?.id || null;
  if (mode === 'tower') return `layer:${state.towerLayer || 1}`;
  return null;
}

const round6 = (p) => (Array.isArray(p) ? [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6] : null);

/** 记录只用于分析：任何异常都吞掉，绝不能影响游戏流程 */
function safely(fn) {
  return (...args) => {
    try { return fn(...args); }
    catch (error) { console.warn('[trace] 规划记录出错，已忽略', error); }
  };
}

/** 开始记录一局（beginGameplay 时调用）；上一局还没结束就先按“放弃”上报 */
export const startTrace = safely(function startTrace(level) {
  abandonTrace();
  if (!enabled() || state.answerView || state.editorActive || !state.ORIGIN || !state.DEST) { trace = null; return; }
  const mode = modeOf(level);
  trace = {
    id: crypto.randomUUID(),
    t0: performance.now(),
    events: [],
    dropped: 0,
    dirty: false,      // 上次上报之后有没有新操作
    sentOutcome: null, // 已上报的结果（完成后又撤回继续玩，会再次上报覆盖）
    meta: {
      mode,
      city: level?.cityId || state.currentCityId,
      scenario: scenarioFlags(),
      levelId: levelIdOf(level, mode),
      origin: round6(state.ORIGIN),
      destination: round6(state.DEST),
      runId: state.onlineRound?.run?.id || null,
      roundId: state.onlineRound?.stage?.id || null,
    },
  };
});

/** 记一条操作（没有进行中的记录时忽略） */
export const logTrace = safely(function logTrace(e, data = {}) {
  if (!trace) return;
  if (trace.events.length >= MAX_EVENTS) { trace.dropped++; return; }
  trace.events.push({ t: Math.round(performance.now() - trace.t0), e, ...data });
  trace.dirty = true;
});

/** 当前路线快照（完成时是完整路线，放弃时是半成品） */
function routeSnapshot() {
  const stops = state.routeStops || [];
  if (!stops.length) return [];
  const out = [{ k: 'start', stop: stops[0].physicalStopId ?? null, n: stops[0].logical?.name ?? null }];
  (state.routeRides || []).forEach((line, i) => {
    const to = stops[i + 1];
    if (!to) return;
    out.push(line
      ? { k: 'ride', line: String(line.id), ln: line.name, stop: to.physicalStopId ?? null, n: to.logical?.name ?? null }
      : { k: 'walk', stop: to.physicalStopId ?? null, n: to.logical?.name ?? null });
  });
  return out;
}

function summary(outcome) {
  const out = { stops: (state.routeStops || []).length, rides: (state.routeRides || []).filter(Boolean).length };
  out.walks = (state.routeRides || []).filter((r) => !r).length;
  if (trace.dropped) out.dropped = trace.dropped;
  if (outcome === 'finished') {
    try { out.playerMin = Math.round(computeTotalMinutes() * 10) / 10; } catch { /* 计时失败不影响上报 */ }
  }
  return out;
}

function send(outcome, { unloading = false } = {}) {
  if (!trace) return;
  const body = {
    id: trace.id,
    anonId: anonId(),
    ...trace.meta,
    outcome,
    durationMs: Math.max(0, Math.round(performance.now() - trace.t0)),
    events: trace.events,
    route: routeSnapshot(),
    summary: summary(outcome),
    client: {
      w: window.innerWidth, h: window.innerHeight, touch: !!state.isTouch,
      map: window.AMap?.__polyfill ? 'osm' : 'amap', walkTransfer: !!state.walkTransfer,
      v: (document.querySelector?.('script[src*="js/app.js"]')?.getAttribute('src') || '').split('v=')[1] || null,
    },
  };
  let json = JSON.stringify(body);
  if (unloading && json.length > KEEPALIVE_LIMIT) {
    // 页面关闭时请求体有上限：保留开头与结尾的操作，中间截掉
    const keep = Math.max(20, Math.floor(trace.events.length * KEEPALIVE_LIMIT / json.length / 2));
    body.events = [...trace.events.slice(0, keep), { t: body.events[keep]?.t ?? 0, e: 'truncated' }, ...trace.events.slice(-keep)];
    json = JSON.stringify(body);
  }
  trace.dirty = false;
  trace.sentOutcome = outcome;
  try {
    // 页面关闭时必须在事件处理里同步发出请求（keepalive 保证页面卸载后仍能送达）
    fetch(ENDPOINT, {
      method: 'POST', credentials: 'same-origin', keepalive: unloading,
      headers: { 'Content-Type': 'application/json' }, body: json,
    }).catch(() => { /* 记录失败不影响游戏 */ });
  } catch { /* 同上 */ }
}

/** 中途离开：有未上报的操作（或从未上报过）时按“放弃”上报 */
export const abandonTrace = safely(function abandonTrace({ unloading = false } = {}) {
  if (!trace) return;
  const finishedAndIdle = trace.sentOutcome === 'finished' && !trace.dirty;
  const nothingDone = !trace.events.length && !trace.sentOutcome;
  if (!finishedAndIdle && !nothingDone) {
    if (trace.sentOutcome === 'finished') logTrace('leave');
    send('abandoned', { unloading });
  }
  trace = null;
});

// 完成路线：记一条 finish 并上报（完成后又撤回继续玩、再次完成，会用同一 id 覆盖为最新）
on(EVENTS.ROUTE_FINISHED, safely(() => {
  if (!trace) return;
  logTrace('finish');
  send('finished');
}));

/**
 * 页面被关闭/刷新、或切到后台（手机切 App 后可能被系统直接杀掉）：先把进行中的过程按“放弃”上报，
 * 但不结束记录——页面可能恢复（后退缓存、切回前台），之后完成时用同一 id 覆盖为最新结果。
 */
const flushInProgress = safely(function flushInProgress() {
  if (!trace || (!trace.dirty && trace.sentOutcome) || (!trace.events.length && !trace.sentOutcome)) return;
  if (trace.sentOutcome === 'finished') return; // 完成后没有新操作，结果已上报
  send('abandoned', { unloading: true });
});
if (typeof window?.addEventListener === 'function' && typeof document?.addEventListener === 'function') {
  window.addEventListener('pagehide', flushInProgress);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushInProgress(); });
}
