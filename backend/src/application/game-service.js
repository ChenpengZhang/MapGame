import { isDeepStrictEqual } from 'node:util';
import { randomInt } from 'node:crypto';
import { beijingDate, BIG_CITIES, ensure, RULES_VERSION, settle } from '../domain/rules.js';
import { LEVELS } from '../../../frontend/js/data/levels.js';
import { CUSTOM_LIMITS, customLevelScore } from '../../../frontend/js/data/custom-maps.js';

// 分享码字母表：去掉易混的 I/O/0/1
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newShareCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

/** 关卡组对外视图：不含内部 id、所有者 id */
export function publicCustomMap(map, viewerId = null) {
  return {
    code: map.code,
    title: map.title,
    description: map.description,
    visibility: map.visibility,
    authorName: map.author_name ?? null,
    version: map.version,
    playCount: map.play_count,
    createdAt: map.created_at,
    updatedAt: map.updated_at,
    levels: map.levels,
    isOwner: !!viewerId && map.owner_id === viewerId,
  };
}

/** 从第 1 关开始只计算连续通过的前缀；跳着完成的记录不会提前解锁。 */
export function unlockedStoryCount(completedIds) {
  const completed = new Set(completedIds || []);
  let unlocked = 1;
  for (const level of LEVELS) {
    if (!completed.has(level.id)) break;
    unlocked++;
  }
  return Math.min(unlocked, LEVELS.length + 1);
}

// 下发给客户端的关卡视图：剥离最优耗时 optimalDurationMs，避免玩家直接看到答案。
/** 每日挑战不向玩家透露最优用时（也不在前端画最优路线），其它模式照常返回 */
function optimalFor(run, stage) {
  return run.mode === 'daily' ? {} : { optimal_duration_ms: stage.optimal_duration_ms };
}

export function publicStage(stage) {
  const { optimalDurationMs, ...puzzle } = stage.puzzle;
  return {
    id: stage.id,
    runId: stage.run_id,
    stageNo: stage.stage_no,
    status: stage.status,
    startedAt: stage.started_at,
    puzzle,
  };
}

export class GameService {
  constructor(repository, transit) {
    this.repository = repository;
    this.transit = transit;
    this.dailyPending = new Map();
  }

  async ensureDaily() {
    const date = beijingDate(await this.repository.now());
    // 进程内去重：同一天并发请求复用同一个 Promise，避免重复建题。
    if (!this.dailyPending.has(date)) {
      const pending = (async () => {
        const existing = await this.repository.daily(date);
        if (existing) return existing;
        // 每天在大城市之间随机选一个出题；题目首次生成后持久化，当天所有人做同一题
        const city = BIG_CITIES[Math.floor(Math.random() * BIG_CITIES.length)];
        return this.repository.createDaily(date, await this.transit.generate(city, 'normal'));
      })();
      this.dailyPending.set(date, pending);
      pending.finally(() => this.dailyPending.delete(date)).catch(() => {});
    }
    return this.dailyPending.get(date);
  }

  async dailyInfo() {
    const daily = await this.ensureDaily();
    return {
      id: daily.id,
      date: beijingDate(daily.opens_at),
      city: daily.puzzle.city,
      scenario: daily.puzzle.scenario,
      opensAt: daily.opens_at,
      closesAt: daily.closes_at,
    };
  }

  async start(userId, { mode, city, scenario, options, levelId, map: code, restart }) {
    if (mode === 'custom') return this.startCustom(userId, code, restart);
    const daily = mode === 'daily' ? await this.ensureDaily() : null;
    if (daily) {
      city = daily.puzzle.city;
      scenario = daily.puzzle.scenario;
    }

    return this.repository.transaction(async (tx) => {
      await tx.lockUser(userId); // 行锁串行化同一用户的并发开局

      if (mode === 'story') {
        const requested = LEVELS.findIndex((level) => level.id === levelId);
        const unlocked = unlockedStoryCount(await tx.completedStoryIds(userId));
        ensure(requested >= 0 && requested < unlocked, 'STORY_LOCKED', 403);
      }

      // 随机/故事属于“练习局”：同一用户只保留最新一局，旧的直接作废。
      if (mode === 'free' || mode === 'story') {
        await tx.abandonPractice(userId);
        const flags = options ?? {};
        const freeOptions = {
          allowMetro: !flags.noMetro,
          busSpeedFactor: (flags.busBoost ? 1.2 : 1) * (flags.rain ? 0.5 : 1),
          walkSpeedFactor: flags.rain ? 0.5 : 1,
        };
        const puzzle =
          mode === 'story'
            ? await this.transit.story(levelId)
            : await this.transit.generate(city, 'custom', freeOptions);
        const run = await tx.createRun(userId, mode, puzzle, null);
        return { run, stage: publicStage(await tx.createStage(run.id, 1, puzzle)) };
      }

      if (daily) ensure(await tx.now() < daily.closes_at, 'DAILY_CLOSED', 409);

      let run = await tx.active(userId, mode, city, scenario, daily?.id ?? null);
      if (!run) {
        const puzzle = daily?.puzzle ?? (await this.transit.generate(city, scenario));
        run = await tx.createRun(userId, mode, puzzle, daily?.id ?? null);
        await tx.createStage(run.id, 1, puzzle);
      }
      return { run, stage: publicStage(await tx.latestStage(run.id)) };
    });
  }

  async resume(userId, runId) {
    return this.repository.transaction(async (tx) => {
      const run = await tx.run(runId, userId);
      ensure(run, 'RUN_NOT_FOUND', 404);
      return { run, stage: publicStage(await tx.latestStage(run.id)) };
    });
  }

  async next(userId, runId) {
    return this.repository.transaction(async (tx) => {
      const run = await tx.run(runId, userId);
      ensure(run, 'RUN_NOT_FOUND', 404);
      ensure((run.mode === 'tower' || run.mode === 'custom') && run.status === 'active', 'RUN_NOT_ACTIVE', 409);

      const latest = await tx.latestStage(run.id);
      if (latest.status === 'active') return publicStage(latest);
      if (run.mode === 'custom') {
        // 自定义：本关无论成败都进入下一关
        ensure(latest.stage_no === run.cleared_layers, 'INVALID_STAGE_SEQUENCE', 409);
        const map = await tx.customMapById(run.custom_map_id);
        ensure(map && !map.deleted_at && map.version === run.custom_map_version, 'MAP_CHANGED', 409);
        ensure(latest.stage_no < map.levels.length, 'RUN_NOT_ACTIVE', 409);
        const puzzle = await this.customPuzzle(map, latest.stage_no);
        return publicStage(await tx.createStage(run.id, latest.stage_no + 1, puzzle));
      }
      ensure(
        latest.status === 'passed' && latest.stage_no === run.cleared_layers,
        'INVALID_STAGE_SEQUENCE',
        409,
      );

      const puzzle = await this.transit.generate(run.city_id, run.scenario_key);
      ensure(
        puzzle.dataHash === run.data_hash && puzzle.rulesVersion === run.rules_version,
        'PUZZLE_VERSION_UNAVAILABLE',
        409,
      );
      return publicStage(await tx.createStage(run.id, run.cleared_layers + 1, puzzle));
    });
  }

  async submit(userId, runId, { stageId, requestId, route }, receivedAt) {
    return this.repository.transaction(async (tx) => {
      const run = await tx.run(runId, userId);
      ensure(run, 'RUN_NOT_FOUND', 404);

      const stage = await tx.stage(stageId);
      ensure(stage && stage.run_id === run.id, 'STAGE_NOT_FOUND', 404);

      // 幂等：同一 requestId 重试直接返回上次结果，网络重试不会重复结算。
      const previous = await tx.submission(requestId);
      if (previous) {
        ensure(
          previous.stage_id === stage.id && isDeepStrictEqual(previous.route, route),
          'IDEMPOTENCY_CONFLICT',
          409,
        );
        return {
          ...previous,
          ...optimalFor(run, stage),
          ...(run.mode === 'tower' ? { total_elapsed_ms: Number(run.total_elapsed_ms) || 0 } : {}),
          ...(run.mode === 'custom'
            ? { ...this.customProgress(run, stage, previous), total_score: Number(run.total_score) || 0 }
            : {}),
        };
      }

      ensure(run.status === 'active', 'RUN_NOT_ACTIVE', 409);
      ensure(
        stage.stage_no === run.cleared_layers + 1 && stage.status === 'active',
        'STAGE_ALREADY_SETTLED',
        409,
      );

      if (run.mode === 'daily') {
        const daily = await tx.dailyById(run.daily_challenge_id);
        ensure(receivedAt >= daily.opens_at && receivedAt < daily.closes_at, 'DAILY_CLOSED', 409);
      }

      // 信任边界：时长由服务端按物理站连续性重新计算，不采用客户端提交的任何时间/得分。
      const duration = await this.transit.evaluate(stage.puzzle, route, run.mode);
      const result = settle(stage, duration, receivedAt, run.mode);
      if (run.mode === 'custom') {
        result.score = customLevelScore(duration, Number(stage.optimal_duration_ms), stage.puzzle.limitMs);
      }
      const submission = await tx.record(run, stage, requestId, route, result, receivedAt);
      const totalElapsed =
        (Number(run.total_elapsed_ms) || 0) +
        (run.mode === 'tower' && submission.passed ? Number(submission.elapsed_ms) : 0);
      return {
        ...submission,
        ...optimalFor(run, stage),
        ...(run.mode === 'tower' ? { total_elapsed_ms: totalElapsed } : {}),
        ...(run.mode === 'custom' ? this.customProgress(run, stage, submission) : {}),
      };
    });
  }

  /** 自定义模式提交结果附带的整组进度：累计总分、已完成关数、总关数 */
  customProgress(run, stage, submission) {
    return {
      total_score: (Number(run.total_score) || 0) + (Number(submission.score) || 0),
      rounds_done: stage.stage_no,
      level_count: stage.puzzle.levelCount,
      limit_ms: stage.puzzle.limitMs,
    };
  }

  async abandon(userId, runId) {
    return this.repository.transaction(async (tx) => {
      const run = await tx.run(runId, userId);
      ensure(run, 'RUN_NOT_FOUND', 404);
      if (run.status === 'active') await tx.abandon(run.id);
    });
  }

  history(userId) {
    return this.repository.history(userId);
  }

  async storyProgress(userId) {
    return { unlocked: unlockedStoryCount(await this.repository.completedStoryIds(userId)) };
  }

  towerProgress(userId, city) {
    return this.repository.towerProgress(userId, city);
  }

  saves(userId) {
    return this.repository.saves(userId);
  }

  async leaderboard(query, viewerId = null) {
    if (query.mode === 'custom') {
      const map = await this.repository.customMapByCode(query.map);
      ensure(map, 'MAP_NOT_FOUND', 404);
      return this.board(await this.repository.customLeaderboard(map.id, map.version, viewerId));
    }
    // 爬塔榜按当前地图数据哈希过滤，旧数据版本的成绩不参与排名。
    const hash = query.mode === 'tower' ? (await this.transit.load(query.city)).hash : null;
    const rows = await this.repository.leaderboard({
      ...query,
      hash,
      rulesVersion: RULES_VERSION,
      viewerId,
    });
    return this.board(rows);
  }

  /** 排行结果：前 20 名 + 不在前 20 时单独附带查看者自己的名次 */
  board(rows) {
    const clean = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'position'));
    const leaders = rows.filter((row) => Number(row.position) <= 20).map(clean);
    const own = rows.find((row) => row.is_me && Number(row.position) > 20);
    return { leaders, player: own ? clean(own) : null };
  }

  // ============ 自定义关卡组 ============

  customPuzzle(map, index) {
    return this.transit.custom(map.levels[index], {
      customMapId: map.id,
      customMapVersion: map.version,
      levelIndex: index,
      levelCount: map.levels.length,
    });
  }

  /** 保存前逐关校验：城市数据存在、起终点够远、有可行的乘车路线；返回规范化后的关卡 */
  async validateLevels(levels) {
    for (let i = 0; i < levels.length; i++) {
      try {
        await this.transit.custom(levels[i]);
      } catch (error) {
        if (error?.code) error.code = `${error.code}:${i + 1}`; // 带上关卡序号，前端据此定位出错的关
        throw error;
      }
    }
    return levels;
  }

  async getCustomMap(code, viewerId = null) {
    const map = await this.repository.customMapByCode(code);
    ensure(map, 'MAP_NOT_FOUND', 404);
    return publicCustomMap(map, viewerId);
  }

  listCustomMaps({ sort = 'popular', q = '', page = 0 }) {
    const limit = 20;
    return this.repository.listCustomMaps({ sort, q: q.trim(), offset: page * limit, limit });
  }

  myCustomMaps(userId) {
    return this.repository.myCustomMaps(userId);
  }

  async createCustomMap(userId, body) {
    await this.validateLevels(body.levels);
    return this.repository.transaction(async (tx) => {
      await tx.lockUser(userId);
      ensure((await tx.countCustomMaps(userId)) < CUSTOM_LIMITS.maxMapsPerUser, 'MAP_LIMIT_REACHED', 409);
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newShareCode();
        if (await tx.customMapByCode(code)) continue;
        return publicCustomMap(await tx.createCustomMap(userId, code, body), userId);
      }
      throw new Error('Cannot allocate share code');
    });
  }

  async updateCustomMap(userId, code, body) {
    const map = await this.repository.customMapByCode(code);
    ensure(map, 'MAP_NOT_FOUND', 404);
    ensure(map.owner_id === userId, 'NOT_MAP_OWNER', 403);
    await this.validateLevels(body.levels);
    const updated = await this.repository.updateCustomMap(map.id, body);
    return publicCustomMap({ ...updated, author_name: map.author_name }, userId);
  }

  async deleteCustomMap(userId, code) {
    const map = await this.repository.customMapByCode(code);
    ensure(map, 'MAP_NOT_FOUND', 404);
    ensure(map.owner_id === userId, 'NOT_MAP_OWNER', 403);
    await this.repository.deleteCustomMap(map.id);
  }

  /** 开始 / 继续一组自定义关卡：同一关卡组同一用户只保留一局进行中；restart 或关卡组已更新则重开 */
  async startCustom(userId, code, restart = false) {
    const map = await this.repository.customMapByCode(code);
    ensure(map, 'MAP_NOT_FOUND', 404);
    return this.repository.transaction(async (tx) => {
      await tx.lockUser(userId);
      const active = await tx.activeCustom(userId, map.id);
      if (active && !restart && active.custom_map_version === map.version) {
        return { run: active, stage: publicStage(await tx.latestStage(active.id)), map: publicCustomMap(map, userId) };
      }
      if (active) await tx.abandonCustom(userId, map.id);
      const puzzle = await this.customPuzzle(map, 0);
      const run = await tx.createCustomRun(userId, map, puzzle);
      return { run, stage: publicStage(await tx.createStage(run.id, 1, puzzle)), map: publicCustomMap(map, userId) };
    });
  }
}
