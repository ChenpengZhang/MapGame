import { readFile } from 'node:fs/promises';
import { createHash, randomInt } from 'node:crypto';
import router from '../../../shared/router.js';
// Pure level definitions; no browser state or DOM dependencies.
import { LEVELS } from '../../../frontend/js/data/levels.js';
import { CITIES, DATA_VERSION, RULES_VERSION, SCENARIOS, ensure } from '../domain/rules.js';

// Anti-corruption adapter: the existing router remains independent of HTTP/database code.
export class Transit {
  constructor(dataDirectory = new URL('../../../data/', import.meta.url)) {
    this.directory = dataDirectory;
    this.cache = new Map();
  }

  async load(city) {
    ensure(CITIES.includes(city), 'UNKNOWN_CITY');
    if (!this.cache.has(city)) {
      // 哈希把题目绑定到具体数据版本：数据一变，旧哈希的对局拒绝继续验证。
      const pending = readFile(new URL(`${city}-transit.json`, this.directory)).then((raw) => ({
        graph: router.buildGraph(JSON.parse(raw).lines),
        hash: createHash('sha256').update(raw).digest('hex'),
      }));
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
    const city = 'beijing';
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
      limitMs: level.timeLimitMin * 60000,
    };
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
        // 步行换乘只在无尽模式开放，且相邻站必须在步行上限内。
        ensure(mode === 'tower', 'WALK_TRANSFER_NOT_ALLOWED');
        const a = graph.physById.get(leg.fromStopId);
        const b = graph.physById.get(leg.toStopId);
        ensure(a && b && a.id !== b.id, 'INVALID_WALK_STOPS');

        if (previousStop) {
          ensure(previousStop.id === a.id, 'DISCONNECTED_ROUTE');
        } else {
          const startDistance = router.haversineKm(puzzle.origin, [a.lng, a.lat]) * 1000;
          ensure(startDistance <= p.maxWalkKm * 1000, 'START_TOO_FAR');
          minutes += startDistance / (75 * p.walkSpeedFactor);
        }

        const distance = router.haversineKm([a.lng, a.lat], [b.lng, b.lat]) * 1000;
        ensure(distance <= p.maxWalkKm * 1000, 'WALK_TRANSFER_TOO_FAR');
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
    minutes += lastDistance / (75 * p.walkSpeedFactor);
    return Math.round(minutes * 60000);
  }
}
