import { readFile } from 'node:fs/promises';
import { createHash, randomInt } from 'node:crypto';
import router from '../../../shared/router.js';
import rivers from '../../../shared/rivers.js';
// Pure level definitions; no browser state or DOM dependencies.
import { LEVELS } from '../../../frontend/js/data/levels.js';
import { CUSTOM_LIMITS, customLimitMs } from '../../../frontend/js/data/custom-maps.js';
import { CITIES, DATA_VERSION, RULES_VERSION, SCENARIOS, ensure } from '../domain/rules.js';

/** 这段步行是否要过江（城市没有江河数据时恒为 false） */
const crosses = (graph, a, b) => !!(graph.rivers && graph.rivers.crosses(a, b));

// Anti-corruption adapter: the existing router remains independent of HTTP/database code.
const CUSTOM_OPTIMAL_CACHE_MAX = 5000;

export class Transit {
  constructor(dataDirectory = new URL('../../../data/', import.meta.url)) {
    this.directory = dataDirectory;
    this.cache = new Map();
    // 自定义关卡最优用时缓存：键含数据哈希，数据一更新旧结果自然失效。
    // 保存关卡组时没改过的关、以及每次开回合重算的同一关都直接命中，不再跑寻路。
    this.customOptimal = new Map();
  }

  async load(city) {
    ensure(CITIES.includes(city), 'UNKNOWN_CITY');
    if (!this.cache.has(city)) {
      // 哈希把题目绑定到具体数据版本：数据一变，旧哈希的对局拒绝继续验证。
      const pending = Promise.all([
        readFile(new URL(`${city}-transit.json`, this.directory)),
        // 江河中心线（可选）：有的城市禁止步行过江，见 shared/rivers.js
        readFile(new URL(`rivers/${city}.json`, this.directory)).then((raw) => JSON.parse(raw)).catch(() => null),
      ]).then(([raw, riverData]) => {
        const graph = router.buildGraph(JSON.parse(raw).lines);
        const index = rivers.buildRiverIndex(riverData);
        if (index) graph.rivers = { crosses: (a, b) => rivers.crossesRiver(index, a, b) };
        return { graph, hash: createHash('sha256').update(raw).digest('hex') };
      });
      this.cache.set(city, pending);
      pending.catch(() => this.cache.delete(city));
    }
    return this.cache.get(city);
  }

  async generate(city, scenario, customOptions) {
    const { graph, hash } = await this.load(city);
    const options = customOptions ?? SCENARIOS[scenario];
    ensure(options, 'UNKNOWN_SCENARIO');

    const stops = graph.physList.filter(
      (p) => options.allowMetro || [...p.lineIds].some((id) => graph.lineById.get(id).mode === 'bus'),
    );

    // 随机起终点 + 重试：保证两点有连通方案且最优耗时有效。
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = stops[randomInt(stops.length)];
      const b = stops[randomInt(stops.length)];
      const origin = [a.lng, a.lat];
      const destination = [b.lng, b.lat];
      if (router.haversineKm(origin, destination) < 3) continue;

      const optimal = await router.findOptimalRoute(graph, origin, destination, options, async (x, y) => ({
        min: (router.haversineKm(x, y) * 1000) / (75 * options.walkSpeedFactor),
      }));
      if (!optimal || !Number.isFinite(optimal.totalMin) || optimal.totalMin <= 0) continue;

      return {
        city,
        scenario,
        origin,
        destination,
        dataVersion: DATA_VERSION,
        rulesVersion: RULES_VERSION,
        options,
        dataHash: hash,
        optimalDurationMs: Math.round(optimal.totalMin * 60000),
      };
    }
    throw new Error('Cannot generate connected transit puzzle');
  }

  async story(levelId) {
    const level = LEVELS.find((item) => item.id === levelId);
    ensure(level, 'UNKNOWN_STORY');
    const city = level.cityId;
    const { graph, hash } = await this.load(city);

    const config = level.scenario ?? {};
    const scenario = config.noMetro
      ? 'noMetro'
      : config.walkSpeedFactor === 0.5
        ? 'rain'
        : config.busSpeedFactor === 1.2
          ? 'busBoost'
          : 'normal';
    const options = SCENARIOS[scenario];

    const origin = [level.origin.lng, level.origin.lat];
    const destination = [level.dest.lng, level.dest.lat];
    const optimal = await router.findOptimalRoute(graph, origin, destination, options, async (a, b) => ({
      min: (router.haversineKm(a, b) * 1000) / (75 * options.walkSpeedFactor),
    }));
    ensure(optimal && Number.isFinite(optimal.totalMin) && optimal.totalMin > 0, 'STORY_UNREACHABLE', 503);

    return {
      city,
      scenario,
      options,
      origin,
      destination,
      dataVersion: DATA_VERSION,
      rulesVersion: RULES_VERSION,
      dataHash: hash,
      optimalDurationMs: Math.round(optimal.totalMin * 60000),
      storyId: level.id,
      limitMs: Number.isFinite(Number(level.timeLimitMin)) ? Number(level.timeLimitMin) * 60000 : null,
    };
  }

  /**
   * 自定义关卡 → 一回合题目。最优用时按当前数据计算并缓存（缓存键含数据哈希，数据更新后自动重算）。
   * 起终点过近、或没有可行路线时抛错（保存关卡组时用同一逻辑校验）。
   */
  async custom(level, meta = {}) {
    const { graph, hash } = await this.load(level.city);
    const options = SCENARIOS[level.scenario];
    ensure(options, 'UNKNOWN_SCENARIO');
    const origin = level.origin;
    const destination = level.dest;
    ensure(router.haversineKm(origin, destination) >= CUSTOM_LIMITS.minDistanceKm, 'LEVEL_TOO_CLOSE');
    const optimalDurationMs = await this.customOptimalMs(graph, hash, level, options);
    // 最优方案必须真的乘车（全程步行的题目无法按乘车路线提交与验证）
    ensure(optimalDurationMs !== null, 'LEVEL_UNREACHABLE');
    return {
      city: level.city,
      scenario: level.scenario,
      options,
      origin,
      destination,
      dataVersion: DATA_VERSION,
      rulesVersion: RULES_VERSION,
      dataHash: hash,
      optimalDurationMs,
      limitMs: customLimitMs(level.timeLimit, optimalDurationMs),
      ...meta,
    };
  }

  /** 关卡最优用时（毫秒）；不可达（没有乘车方案）为 null。结果按 城市+情景+起终点+数据哈希 缓存 */
  async customOptimalMs(graph, hash, level, options) {
    const key = [level.city, level.scenario, ...level.origin, ...level.dest, hash].join('|');
    if (this.customOptimal.has(key)) {
      const value = this.customOptimal.get(key);
      this.customOptimal.delete(key); // 重新插入，Map 按插入顺序淘汰最久没用的
      this.customOptimal.set(key, value);
      return value;
    }
    const optimal = await router.findOptimalRoute(graph, level.origin, level.dest, options, async (a, b) => ({
      min: (router.haversineKm(a, b) * 1000) / (75 * options.walkSpeedFactor),
    }));
    const value = optimal && Number.isFinite(optimal.totalMin) && optimal.totalMin > 0
      && (optimal.legs || []).some((leg) => leg.type === 'ride')
      ? Math.round(optimal.totalMin * 60000) : null;
    this.customOptimal.set(key, value);
    if (this.customOptimal.size > CUSTOM_OPTIMAL_CACHE_MAX) this.customOptimal.delete(this.customOptimal.keys().next().value);
    return value;
  }

  // 服务端权威重算：逐段校验物理站、乘车方向、线路衔接与步行距离，
  // 用权威速度参数重算总时长——完全不信任客户端提交的任何数值。
  async evaluate(puzzle, route, mode) {
    const { graph, hash } = await this.load(puzzle.city);
    ensure(
      puzzle.dataHash === hash &&
        puzzle.dataVersion === DATA_VERSION &&
        puzzle.rulesVersion === RULES_VERSION,
      'PUZZLE_VERSION_UNAVAILABLE',
      409,
    );

    const p = { ...router.DEFAULT_PARAMS, ...(puzzle.options ?? SCENARIOS[puzzle.scenario]) };
    let minutes = 0;
    let previousStop = null;
    let previousRideLine = null;

    for (const leg of route) {
      if (leg.type === 'walk') {
        // 步行换乘只在无尽模式与自定义模式开放，且相邻站必须在步行上限内。
        ensure(mode === 'tower' || mode === 'custom', 'WALK_TRANSFER_NOT_ALLOWED');
        const a = graph.physById.get(leg.fromStopId);
        const b = graph.physById.get(leg.toStopId);
        ensure(a && b && a.id !== b.id, 'INVALID_WALK_STOPS');

        if (previousStop) {
          ensure(previousStop.id === a.id, 'DISCONNECTED_ROUTE');
        } else {
          const startDistance = router.haversineKm(puzzle.origin, [a.lng, a.lat]) * 1000;
          ensure(startDistance <= p.maxWalkKm * 1000, 'START_TOO_FAR');
          ensure(!crosses(graph, puzzle.origin, [a.lng, a.lat]), 'RIVER_CROSSING');
          minutes += startDistance / (75 * p.walkSpeedFactor);
        }

        const distance = router.haversineKm([a.lng, a.lat], [b.lng, b.lat]) * 1000;
        ensure(distance <= p.maxWalkKm * 1000, 'WALK_TRANSFER_TOO_FAR');
        ensure(!crosses(graph, [a.lng, a.lat], [b.lng, b.lat]), 'RIVER_CROSSING');
        minutes += distance / (75 * p.walkSpeedFactor);
        previousStop = b;
        previousRideLine = null;
        continue;
      }

      const line = graph.lineById.get(leg.lineId);
      ensure(line && (p.allowMetro || line.mode !== 'metro'), 'LINE_NOT_ALLOWED');
      const from = line.stopIndex.get(leg.fromStopId);
      const to = line.stopIndex.get(leg.toStopId);
      ensure(from !== undefined && to !== undefined && from !== to, 'INVALID_STOPS');

      const a = line.stops[from];
      const b = line.stops[to];

      if (previousStop) {
        ensure(
          graph.physToLogical.get(previousStop.id) === graph.physToLogical.get(a.id),
          'DISCONNECTED_ROUTE',
        );
        if (previousRideLine) {
          minutes +=
            previousRideLine.mode !== line.mode
              ? p.busMetroTransferMin
              : line.mode === 'metro'
                ? p.metroMetroTransferMin
                : p.busBusTransferMin;
        }
      } else {
        const distance = router.haversineKm(puzzle.origin, [a.lng, a.lat]) * 1000;
        ensure(distance <= 1500, 'START_TOO_FAR');
        ensure(!crosses(graph, puzzle.origin, [a.lng, a.lat]), 'RIVER_CROSSING');
        minutes += distance / (75 * p.walkSpeedFactor);
      }

      minutes += line.mode === 'metro' ? p.metroWaitMin : p.busWaitMin;

      const costs = [];
      for (const direction of line.oneWay ? [1] : [1, -1]) {
        let index = from;
        let cost = 0;
        for (let n = 0; n < line.stops.length; n++) {
          let next = index + direction;
          const wrap = next < 0 || next >= line.stops.length;
          if (wrap && !line.isLoop) break;
          next = (next + line.stops.length) % line.stops.length;
          const lo = line.stops[index].seq <= line.stops[next].seq ? line.stops[index] : line.stops[next];
          const distance = wrap ? line.wrapDistKm : lo.d;
          if (!Number.isFinite(distance) || distance <= 0) break;
          cost += router.segmentRideMin(line, distance, p) + (line.mode === 'metro' ? p.metroDwellMin : p.busDwellMin);
          if (next === to) {
            costs.push(cost);
            break;
          }
          index = next;
        }
      }
      ensure(costs.length, 'WRONG_DIRECTION_OR_MISSING_EDGE');
      minutes += Math.min(...costs);
      previousStop = b;
      previousRideLine = line;
    }

    ensure(previousStop, 'EMPTY_ROUTE');
    const lastDistance = router.haversineKm([previousStop.lng, previousStop.lat], puzzle.destination) * 1000;
    ensure(lastDistance <= 1500, 'END_TOO_FAR');
    ensure(!crosses(graph, [previousStop.lng, previousStop.lat], puzzle.destination), 'RIVER_CROSSING');
    minutes += lastDistance / (75 * p.walkSpeedFactor);
    return Math.round(minutes * 60000);
  }
}
