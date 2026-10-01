/**
 * ui/trip-card.js —— 顶栏正中的本局行程牌（起点 → 终点 · 直线距离）
 *
 * 哑组件：只负责显示/隐藏与填字；点击行为由 app.js 绑定。
 */

import { $, setText, formatKm } from '../core/dom.js';

/** 显示行程牌。km 为起终点直线距离。 */
export function showTripCard({ originName, destName, km }) {
  setText('trip-origin', originName || '起点');
  setText('trip-dest', destName || '终点');
  setText('trip-dist', Number.isFinite(km) ? `直线 ${formatKm(km)}` : '');
  $('trip-card')?.classList.remove('hidden');
  $('app')?.classList.add('trip-on');
}

export function hideTripCard() {
  $('trip-card')?.classList.add('hidden');
  $('app')?.classList.remove('trip-on');
}
