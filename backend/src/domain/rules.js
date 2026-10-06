export class GameError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export const ensure = (condition, code, status = 400) => {
  if (!condition) throw new GameError(code, status);
};

export const SCENARIOS = Object.freeze({
  normal: { allowMetro: true, busSpeedFactor: 1, walkSpeedFactor: 1 },
  noMetro: { allowMetro: false, busSpeedFactor: 1, walkSpeedFactor: 1 },
  busBoost: { allowMetro: true, busSpeedFactor: 1.2, walkSpeedFactor: 1 },
  rain: { allowMetro: true, busSpeedFactor: 0.5, walkSpeedFactor: 0.5 },
  // 以下两种只改变前端呈现/操作限制，寻路与计时同普通模式：
  blind: { allowMetro: true, busSpeedFactor: 1, walkSpeedFactor: 1 },    // 盲棋：不显示底图，只有城市轮廓
  realRide: { allowMetro: true, busSpeedFactor: 1, walkSpeedFactor: 1 }, // 真实乘坐：不能撤回、不能全图显示
});

export const CITIES = ['beijing', 'shanghai', 'guangzhou', 'shenzhen', 'wenshan', 'shuanghe', 'kokdala', 'datong',
  'chengdu', 'chongqing', 'hangzhou', 'wuhan', 'nanjing', 'tianjin', 'qingdao',
  'kunming', 'xiamen', 'jinan', 'zhengzhou', 'changchun'];
// 大城市（公交 + 地铁 500 条线以上）：每日挑战每天在其中随机选一个城市出题
export const BIG_CITIES = ['beijing', 'shanghai', 'guangzhou', 'shenzhen', 'chengdu', 'chongqing', 'hangzhou', 'wuhan', 'nanjing', 'tianjin', 'qingdao',
  'kunming', 'xiamen', 'jinan', 'zhengzhou', 'changchun'];
export const RULES_VERSION = 1;
export const DATA_VERSION = 9;

// 爬塔难度曲线：第 1 层允许比最优慢 ≤100%（即 2 倍最优以内），
// 线性收紧到第 12 层 ≤1%，之后保持 1%。
export const threshold = (layer) => Math.max(0.01, 1 - (layer - 1) * 0.99 / 11);

export function settle(stage, durationMs, receivedAt, mode) {
  ensure(stage.status === 'active', 'STAGE_ALREADY_SETTLED', 409);
  const elapsedMs = receivedAt.getTime() - new Date(stage.started_at).getTime();
  ensure(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0, 'INVALID_SERVER_CLOCK', 503);
  ensure(Number.isSafeInteger(durationMs) && durationMs > 0, 'INVALID_ROUTE_DURATION');

  // 通过判定：带时限的故事关与自定义关看绝对时限；无时限教学关与每日/随机恒为 true；
  // 无尽模式看“≤ 最优 × (1 + 本层阈值)”。
  const passed =
    mode === 'story' || mode === 'custom'
      ? stage.puzzle.limitMs == null || durationMs <= stage.puzzle.limitMs
      : mode !== 'tower' ||
        durationMs <= Math.ceil(Number(stage.optimal_duration_ms) * (1 + threshold(stage.stage_no)));

  return { durationMs, elapsedMs, passed };
}

// 北京时间日期（YYYY-MM-DD）：用 en-CA locale 稳定输出，避免手拼字符串的时区坑。
export const beijingDate = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
