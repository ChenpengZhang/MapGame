import { isDeepStrictEqual } from 'node:util';
import { beijingDate, ensure, RULES_VERSION, settle } from '../domain/rules.js';

export function publicStage(stage) {
  const { optimalDurationMs, ...puzzle } = stage.puzzle;
  return { id: stage.id, runId: stage.run_id, stageNo: stage.stage_no, status: stage.status,
    startedAt: stage.started_at, puzzle };
}
export class GameService {
  constructor(repository, transit) { this.repository = repository; this.transit = transit; this.dailyPending = new Map(); }
  async ensureDaily() {
    const date = beijingDate(await this.repository.now());
    if (!this.dailyPending.has(date)) {
      const pending = (async () => {
        const existing = await this.repository.daily(date);
        if (existing) return existing;
        return this.repository.createDaily(date,await this.transit.generate('beijing','normal'));
      })();
      this.dailyPending.set(date,pending);
      pending.finally(()=>this.dailyPending.delete(date)).catch(()=>{});
    }
    return this.dailyPending.get(date);
  }

  async dailyInfo() {
    const daily = await this.ensureDaily();
    return { id: daily.id, date: beijingDate(daily.opens_at), city: daily.puzzle.city,
      scenario: daily.puzzle.scenario, opensAt: daily.opens_at, closesAt: daily.closes_at };
  }
  async start(userId, { mode, city, scenario, options, levelId }) {
    const daily = mode === 'daily' ? await this.ensureDaily() : null;
    if (daily) { city = daily.puzzle.city; scenario = daily.puzzle.scenario; }
    return this.repository.transaction(async tx => {
      await tx.lockUser(userId);
      if (mode === 'free' || mode === 'story') {
        await tx.abandonPractice(userId);
        const flags = options ?? {};
        const freeOptions = { allowMetro: !flags.noMetro, busSpeedFactor: (flags.busBoost ? 1.2 : 1) * (flags.rain ? 0.5 : 1), walkSpeedFactor: flags.rain ? 0.5 : 1 };
        const puzzle = mode === 'story' ? await this.transit.story(levelId) : await this.transit.generate(city,'custom',freeOptions);
        const run = await tx.createRun(userId,mode,puzzle,null);
        return { run,stage: publicStage(await tx.createStage(run.id,1,puzzle)) };
      }
      if (daily) ensure(await tx.now() < daily.closes_at, 'DAILY_CLOSED',409);
      let run = await tx.active(userId,mode,city,scenario,daily?.id ?? null);
      if (!run) {
        const puzzle = daily?.puzzle ?? await this.transit.generate(city,scenario);
        run = await tx.createRun(userId,mode,puzzle,daily?.id ?? null);
        await tx.createStage(run.id,1,puzzle);
      }
      return { run, stage: publicStage(await tx.latestStage(run.id)) };
    });
  }
  async resume(userId, runId) {
    return this.repository.transaction(async tx => {
      const run = await tx.run(runId,userId);
      ensure(run,'RUN_NOT_FOUND',404);
      return { run, stage: publicStage(await tx.latestStage(run.id)) };
    });
  }
  async next(userId, runId) {
    return this.repository.transaction(async tx => {
      const run = await tx.run(runId,userId);
      ensure(run,'RUN_NOT_FOUND',404);
      ensure(run.mode === 'tower' && run.status === 'active','RUN_NOT_ACTIVE',409);
      const latest = await tx.latestStage(run.id);
      if (latest.status === 'active') return publicStage(latest);
      ensure(latest.status === 'passed' && latest.stage_no === run.cleared_layers,'INVALID_STAGE_SEQUENCE',409);
      const puzzle = await this.transit.generate(run.city_id,run.scenario_key);
      ensure(puzzle.dataHash === run.data_hash && puzzle.rulesVersion === run.rules_version,'PUZZLE_VERSION_UNAVAILABLE',409);
      return publicStage(await tx.createStage(run.id,run.cleared_layers + 1,puzzle));
    });
  }
  async submit(userId, runId, { stageId, requestId, route }, receivedAt) {
    return this.repository.transaction(async tx => {
      const run = await tx.run(runId,userId);
      ensure(run,'RUN_NOT_FOUND',404);
      const stage = await tx.stage(stageId);
      ensure(stage && stage.run_id === run.id,'STAGE_NOT_FOUND',404);
      const previous = await tx.submission(requestId);
      if (previous) {
        ensure(previous.stage_id === stage.id && isDeepStrictEqual(previous.route,route),'IDEMPOTENCY_CONFLICT',409);
        return { ...previous, optimal_duration_ms:stage.optimal_duration_ms,
          ...(run.mode==='tower'?{total_elapsed_ms:Number(run.total_elapsed_ms)||0}:{}) };
      }
      ensure(run.status === 'active','RUN_NOT_ACTIVE',409);
      ensure(stage.stage_no === run.cleared_layers + 1 && stage.status === 'active','STAGE_ALREADY_SETTLED',409);
      if (run.mode === 'daily') {
        const daily = await tx.dailyById(run.daily_challenge_id);
        ensure(receivedAt >= daily.opens_at && receivedAt < daily.closes_at,'DAILY_CLOSED',409);
      }
      const duration = await this.transit.evaluate(stage.puzzle,route,run.mode);
      const submission = await tx.record(run,stage,requestId,route,settle(stage,duration,receivedAt,run.mode),receivedAt);
      const totalElapsed=(Number(run.total_elapsed_ms)||0)+(run.mode==='tower' && submission.passed?Number(submission.elapsed_ms):0);
      return { ...submission,optimal_duration_ms:stage.optimal_duration_ms,
        ...(run.mode==='tower'?{total_elapsed_ms:totalElapsed}:{}) };
    });
  }
  async abandon(userId,runId) {
    return this.repository.transaction(async tx => {
      const run = await tx.run(runId,userId);
      ensure(run,'RUN_NOT_FOUND',404);
      if (run.status === 'active') await tx.abandon(run.id);
    });
  }
  history(userId) { return this.repository.history(userId); }
  towerProgress(userId,city) { return this.repository.towerProgress(userId,city); }
  saves(userId) { return this.repository.saves(userId); }
  async leaderboard(query,viewerId=null) {
    const hash = query.mode === 'tower' ? (await this.transit.load(query.city)).hash : null;
    const rows=await this.repository.leaderboard({ ...query,hash,rulesVersion:RULES_VERSION,viewerId });
    const clean=row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='position'));
    const leaders=rows.filter(row=>Number(row.position)<=20).map(clean);
    const own=rows.find(row=>row.is_me && Number(row.position)>20);
    return { leaders,player:own?clean(own):null };
  }
}
