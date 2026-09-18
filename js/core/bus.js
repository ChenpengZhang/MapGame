/**
 * core/bus.js —— 极简事件总线（约 20 行，用于打破循环依赖）
 *
 * 【为什么需要它】
 *   分层后依赖方向必须单向（game → map/ui → core）。但有一处天然是"双向"的：
 *     - game/route.js 规划完成后需要弹结算窗；
 *     - 弹什么窗取决于"当前是关卡还是爬塔"，而这个判断属于 game/session 与 game/tower。
 *   如果让 route.js 直接 import session/tower，就会形成 session → route → session 的循环。
 *   解法：route 只广播"最优路线算好了"（bus.emit），
 *         由 game/flow.js 订阅（bus.on）并决定弹哪个窗。
 *   这样两边互不认识，依赖方向保持单向。
 *
 * 【使用约定】
 *   事件名用 '对象:动作' 形式并集中登记在 EVENTS 里，避免到处写裸字符串。
 *   emit 是同步调用（和重构前直接调用函数的行为一致）。
 */

/** 全项目的事件名登记表 */
export const EVENTS = {
  /** 最优路线计算完成并已绘制（payload: 最优路线结果对象） */
  OPTIMAL_READY: 'optimal:ready',
};

const handlers = new Map(); // eventName -> Set<fn>

/** 订阅事件 */
export function on(eventName, fn) {
  if (!handlers.has(eventName)) handlers.set(eventName, new Set());
  handlers.get(eventName).add(fn);
}

/** 取消订阅 */
export function off(eventName, fn) {
  const set = handlers.get(eventName);
  if (set) set.delete(fn);
}

/** 广播事件（同步；订阅者抛错不影响其它订阅者） */
export function emit(eventName, payload) {
  const set = handlers.get(eventName);
  if (!set) return;
  for (const fn of Array.from(set)) {
    try {
      fn(payload);
    } catch (e) {
      console.error('[bus] 事件处理出错：' + eventName, e);
    }
  }
}
