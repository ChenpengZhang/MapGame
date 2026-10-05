/**
 * game/daily-answer.js —— 查看已截止每日挑战的答案（昨日排行里的“查看昨日答案”）
 *
 * 服务端只公开已截止题目的起终点与情景（GET /daily/answer?date=）；
 * 这里复用 startLevel 摆好起终点和顶部 HUD，用与结算相同的本地寻路算出最快路线，
 * 画出路线、换乘点和上下车站名牌。state.answerView 期间不能规划（点站点、点“终”都不开始/结束路线）。
 */

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { setStatus, setText, showLoading, hideLoading, showCenterToast } from '../core/dom.js';
import { findOptimalRoute } from '../core/router-api.js';
import { TOWER_SCENARIOS } from '../data/levels.js';
import { routerWalkFn } from '../map/walk.js';
import { drawOptimalRoute, drawOptimalTransfers, drawRouteStationSigns } from '../map/optimal-layer.js';
import { ensureGameDataReady } from './data-ready.js';
import { startLevel } from './session.js';

let requestVersion = 0;

export async function showDailyAnswer(date) {
  const version = ++requestVersion;
  showLoading('正在加载每日挑战答案…');
  try {
    const answer = await api(`/daily/answer?${new URLSearchParams({ date })}`);
    if (version !== requestVersion) return;
    if (!(await ensureGameDataReady(answer.city)) || version !== requestVersion) { hideLoading(); return; }
    const preset = (TOWER_SCENARIOS[answer.scenario] || TOWER_SCENARIOS.normal);
    startLevel({
      id: 'random', mode: 'random', cityId: answer.city, answerView: true,
      title: `${answer.date} 每日挑战答案`,
      origin: { name: '起点', lng: answer.origin[0], lat: answer.origin[1] },
      dest: { name: '终点', lng: answer.destination[0], lat: answer.destination[1] },
      hudText: `${answer.date} 答案 · 正在计算最快…`,
    }, { skipStory: true, scenario: { ...preset.scenario, blindMap: false } }); // 盲棋题也显示底图
    showLoading('正在计算最快路线…');
    const result = await findOptimalRoute(state.routerGraph, state.ORIGIN, state.DEST,
      { allowMetro: !state.scenario.noMetro, busSpeedFactor: state.scenario.busSpeedFactor }, routerWalkFn);
    hideLoading();
    if (version !== requestVersion || !state.answerView) return; // 期间已回主页
    if (!result) { setStatus('未找到可行路线'); return; }
    state.optimalResult = result;
    drawOptimalRoute(result);
    drawOptimalTransfers(result);
    drawRouteStationSigns(result, state.optimalOverlays);
    const label = preset.label && answer.scenario !== 'normal' ? ` · ${preset.label}` : '';
    setText('tower-layer-label', `${answer.date} 答案 · 最快约 ${result.totalMin.toFixed(1)} 分钟${label}`);
    setStatus('最快路线（青色）；点主页按钮返回');
  } catch (error) {
    if (version !== requestVersion) return;
    hideLoading();
    showCenterToast(error.message);
  }
}
