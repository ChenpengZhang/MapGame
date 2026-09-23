export class GameError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const ensure = (condition, code, status = 400) => {
  if (!condition) throw new GameError(code, status);
};
export const SCENARIOS = Object.freeze({
  normal: { allowMetro: true, busSpeedFactor: 1, walkSpeedFactor: 1 },
  noMetro: { allowMetro: false, busSpeedFactor: 1, walkSpeedFactor: 1 },
  busBoost: { allowMetro: true, busSpeedFactor: 1.2, walkSpeedFactor: 1 },
  rain: { allowMetro: true, busSpeedFactor: 0.5, walkSpeedFactor: 0.5 },
});
export const CITIES = ['beijing', 'shanghai', 'guangzhou', 'shenzhen'];
export const RULES_VERSION = 1;
export const DATA_VERSION = 6;
export const threshold = layer => Math.max(0.01, 1 - (layer - 1) * 0.99 / 11);
export function settle(stage, durationMs, receivedAt, mode) {
  ensure(stage.status === 'active', 'STAGE_ALREADY_SETTLED', 409);
  const elapsedMs = receivedAt.getTime() - new Date(stage.started_at).getTime();
  ensure(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0, 'INVALID_SERVER_CLOCK', 503);
  ensure(Number.isSafeInteger(durationMs) && durationMs > 0, 'INVALID_ROUTE_DURATION');
  const passed = mode === 'story' ? durationMs <= stage.puzzle.limitMs : mode !== 'tower' || durationMs <= Math.ceil(Number(stage.optimal_duration_ms) * (1 + threshold(stage.stage_no)));
  return { durationMs, elapsedMs, passed };
}
export const beijingDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
