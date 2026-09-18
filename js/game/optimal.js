/**
 * game/optimal.js —— 最优路线计算与展示编排
 *
 * 【流程】
 *   玩家完成后 → 用本地寻路器（js/router.js 的 Dijkstra）算最优 → 画出来 → 刷新路线面板
 *   → 广播「最优路线就绪」事件。
 *
 * 【为什么这里只广播、不直接弹结算窗】
 *   结算窗内容取决于"当前是故事/自由模式还是爬塔"，
 *   那个判断属于 game/flow.js 与 game/tower.js。
 *   如果在这里直接调用它们，就会形成 session → route → session 的循环依赖。
 *   所以这里用 core/bus.js 广播事件，由 game/flow.js 订阅后决定弹什么（见 flow.js 末尾）。
 *
 * 【重要】最优点与玩家点必须用同一套步行与成本口径，
 *   否则会出现"最优比玩家还慢"的不变式破坏（项目有 test-optimal-invariant.js 守这条）。
 */

import { state } from '../core/state.js';
import { showLoading, hideLoading, setStatus } from '../core/dom.js';
import { findOptimalRoute } from '../core/router-api.js';
import { routerWalkFn } from '../map/walk.js';
import { drawOptimalRoute, drawOptimalTransfers } from '../map/optimal-layer.js';
import { renderRoutePanel } from '../ui/route-panel.js';
import { EVENTS, emit } from '../core/bus.js';

/** 计算并绘制最优路线（玩家点完"终"之后调用；也可用于重算） */
export function computeOptimal() {
  if (!state.routerGraph) return;
  showLoading('正在计算最优路线…');
  findOptimalRoute(
    state.routerGraph,
    state.ORIGIN,
    state.DEST,
    { allowMetro: !state.scenario.noMetro, busSpeedFactor: state.scenario.busSpeedFactor },
    routerWalkFn
  )
    .then((result) => {
      hideLoading();
      if (!result) { setStatus('未找到可行路线'); return; }
      state.optimalResult = result;
      drawOptimalRoute(result);
      drawOptimalTransfers(result);
      renderRoutePanel();
      // 结算弹窗由订阅者决定（game/flow.js）：爬塔 → 层数判定；其它 → 关卡成败
      emit(EVENTS.OPTIMAL_READY, result);
      setStatus('规划完成 · 已对比最优路线');
    })
    .catch((e) => {
      hideLoading();
      console.error(e);
      setStatus('最优路线计算失败');
    });
}
