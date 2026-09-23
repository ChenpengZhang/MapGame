import { randomUUID } from 'node:crypto';
export class Repository {
  constructor(connection) { this.db = connection; }
  async one(sql, args = []) { return (await this.db.query(sql, args)).rows[0]; }
  async transaction(fn) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new Repository(client));
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async lockUser(userId) { await this.one('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]); }
  async now() { return (await this.one('SELECT clock_timestamp() AS now')).now; }
  daily(date) { return this.one('SELECT * FROM daily_challenges WHERE challenge_date=$1', [date]); }
  async createDaily(date, puzzle) {
    await this.db.query(`INSERT INTO daily_challenges(id,challenge_date,puzzle,opens_at,closes_at)
      VALUES($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '24 hours') ON CONFLICT(challenge_date) DO NOTHING`,
    [randomUUID(), date, puzzle, `${date}T00:00:00+08:00`]);
    return this.daily(date);
  }
  async active(userId, mode, city, scenario, dailyId) {
    return this.one(`SELECT g.*,COALESCE(t.cleared_layers,0) AS cleared_layers,
      COALESCE(t.total_elapsed_ms,0) AS total_elapsed_ms FROM game_runs g
      LEFT JOIN tower_run_stats t ON t.run_id=g.id WHERE g.user_id=$1 AND g.mode=$2 AND g.status='active'
      AND g.city_id=$3 AND g.scenario_key=$4 AND g.daily_challenge_id IS NOT DISTINCT FROM $5::uuid`, [userId,mode,city,scenario,dailyId]);
  }
  async createRun(userId, mode, puzzle, dailyId) {
    const run=await this.one(`INSERT INTO game_runs(id,user_id,mode,daily_challenge_id,city_id,scenario_key,data_hash,rules_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [randomUUID(),userId,mode,dailyId,puzzle.city,puzzle.scenario,puzzle.dataHash,puzzle.rulesVersion]);
    if(mode==='tower') {
      await this.db.query('INSERT INTO tower_run_stats(run_id,achieved_at) VALUES($1,$2)',[run.id,run.created_at]);
      return {...run,cleared_layers:0,total_elapsed_ms:0};
    }
    return run;
  }
  run(id, userId) { return this.one(`SELECT g.*,COALESCE(t.cleared_layers,0) AS cleared_layers,
    COALESCE(t.total_elapsed_ms,0) AS total_elapsed_ms FROM game_runs g
    LEFT JOIN tower_run_stats t ON t.run_id=g.id WHERE g.id=$1 AND g.user_id=$2 FOR UPDATE OF g`, [id,userId]); }
  stage(id) { return this.one('SELECT *,round_no AS stage_no FROM run_rounds WHERE id=$1', [id]); }
  latestStage(runId) { return this.one('SELECT *,round_no AS stage_no FROM run_rounds WHERE run_id=$1 ORDER BY round_no DESC LIMIT 1', [runId]); }
  createStage(runId, number, puzzle) {
    return this.one(`INSERT INTO run_rounds(id,run_id,round_no,puzzle,optimal_duration_ms)
      VALUES($1,$2,$3,$4,$5) RETURNING *,round_no AS stage_no`, [randomUUID(),runId,number,puzzle,puzzle.optimalDurationMs]);
  }
  submission(requestId) { return this.one('SELECT *,round_id AS stage_id FROM round_submissions WHERE request_id=$1', [requestId]); }
  dailyById(id) { return this.one('SELECT * FROM daily_challenges WHERE id=$1', [id]); }
  async record(run, stage, requestId, route, result, receivedAt) {
    const submission = await this.one(`INSERT INTO round_submissions(id,round_id,request_id,route,duration_ms,elapsed_ms,passed,submitted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *,round_id AS stage_id`,
    [randomUUID(),stage.id,requestId,JSON.stringify(route),result.durationMs,result.elapsedMs,result.passed,receivedAt]);
    await this.db.query('UPDATE run_rounds SET status=$2 WHERE id=$1', [stage.id,result.passed ? 'passed' : 'failed']);
    const cleared = run.mode === 'tower' && result.passed ? stage.stage_no : run.cleared_layers;
    const status = run.mode !== 'tower' || !result.passed ? 'completed' : 'active';
    await this.db.query(`UPDATE game_runs SET status=$2,finished_at=CASE WHEN $2='completed' THEN $3::timestamptz ELSE NULL END WHERE id=$1`,
      [run.id,status,receivedAt]);
    if (run.mode === 'tower' && result.passed) {
      await this.db.query(`UPDATE tower_run_stats SET cleared_layers=$2,total_elapsed_ms=total_elapsed_ms+$3,achieved_at=$4 WHERE run_id=$1`,
        [run.id,cleared,result.elapsedMs,receivedAt]);
    } else if (run.mode !== 'tower') {
      await this.db.query(`INSERT INTO timed_run_results(run_id,duration_ms,achieved_at)
        VALUES($1,$2,$3) ON CONFLICT(run_id) DO UPDATE SET duration_ms=EXCLUDED.duration_ms,achieved_at=EXCLUDED.achieved_at`,
      [run.id,result.durationMs,receivedAt]);
    }
    return submission;
  }
  async abandon(id) { await this.db.query("UPDATE game_runs SET status='abandoned',finished_at=clock_timestamp() WHERE id=$1", [id]); }
  async abandonPractice(userId) {
    await this.db.query("UPDATE game_runs SET status='abandoned',finished_at=clock_timestamp() WHERE user_id=$1 AND mode IN ('free','story') AND status='active'",[userId]);
  }
  async history(userId) {
    return (await this.db.query(`SELECT g.id AS run_id,g.mode,g.city_id,g.scenario_key,s.round_no AS stage_no,
      s.puzzle->>'storyId' AS story_id,r.duration_ms,r.elapsed_ms,r.passed,r.submitted_at
      FROM game_runs g JOIN run_rounds s ON s.run_id=g.id JOIN round_submissions r ON r.round_id=s.id
      WHERE g.user_id=$1 ORDER BY r.submitted_at DESC,r.id LIMIT 50`,[userId])).rows;
  }
  async towerProgress(userId,city) {
    return (await this.db.query(`SELECT g.scenario_key,
      COALESCE(max(t.cleared_layers) FILTER(WHERE t.invalidated_at IS NULL AND g.status<>'invalid'),0) AS best,
      COALESCE(max(t.cleared_layers+1) FILTER(WHERE g.status='active'),0) AS current_layer
      FROM game_runs g JOIN tower_run_stats t ON t.run_id=g.id
      WHERE g.user_id=$1 AND g.city_id=$2 AND g.mode='tower' GROUP BY g.scenario_key`,[userId,city])).rows;
  }
  async saves(userId) {
    return (await this.db.query(`SELECT g.id,g.mode,g.city_id,g.scenario_key,t.cleared_layers,g.created_at
      FROM game_runs g JOIN tower_run_stats t ON t.run_id=g.id
      WHERE g.user_id=$1 AND g.mode='tower' AND g.status='active' ORDER BY g.created_at DESC`, [userId])).rows;
  }
  async leaderboard({ mode, date, city, scenario, hash, rulesVersion,viewerId }) {
    if(mode==='tower') return (await this.db.query(`WITH personal AS (
      SELECT g.user_id,u.name,t.cleared_layers,t.total_elapsed_ms,t.achieved_at,
        row_number() OVER(PARTITION BY g.user_id ORDER BY t.cleared_layers DESC,t.total_elapsed_ms ASC,t.achieved_at,g.id) AS choice
      FROM tower_run_stats t JOIN game_runs g ON g.id=t.run_id JOIN "user" u ON u.id=g.user_id
      WHERE g.mode='tower' AND g.status<>'invalid' AND t.invalidated_at IS NULL AND t.cleared_layers>0
        AND g.city_id=$1 AND g.scenario_key=$2 AND g.data_hash=$3 AND g.rules_version=$4
    ), ranked AS (SELECT user_id,name,cleared_layers,total_elapsed_ms,achieved_at,
      rank() OVER(ORDER BY cleared_layers DESC,total_elapsed_ms ASC) AS rank,
      row_number() OVER(ORDER BY cleared_layers DESC,total_elapsed_ms ASC,achieved_at,user_id) AS position
      FROM personal WHERE choice=1)
      SELECT name,cleared_layers,total_elapsed_ms,achieved_at,rank,position,user_id=$5 AS is_me
      FROM ranked WHERE position<=20 OR user_id=$5
      ORDER BY cleared_layers DESC,total_elapsed_ms ASC,achieved_at,user_id`,
      [city,scenario,hash,rulesVersion,viewerId ?? ''])).rows;
    return (await this.db.query(`WITH personal AS (
      SELECT g.user_id,u.name,r.duration_ms,r.achieved_at,
        row_number() OVER(PARTITION BY g.user_id ORDER BY r.duration_ms ASC,r.achieved_at,g.id) AS choice
      FROM timed_run_results r JOIN game_runs g ON g.id=r.run_id JOIN "user" u ON u.id=g.user_id
      JOIN daily_challenges d ON d.id=g.daily_challenge_id
      WHERE g.mode='daily' AND g.status<>'invalid' AND r.invalidated_at IS NULL AND d.challenge_date=$1::date
    ), ranked AS (SELECT user_id,name,duration_ms,achieved_at,rank() OVER(ORDER BY duration_ms ASC) AS rank,
      row_number() OVER(ORDER BY duration_ms ASC,achieved_at,user_id) AS position
      FROM personal WHERE choice=1)
      SELECT name,duration_ms,achieved_at,rank,position,user_id=$2 AS is_me FROM ranked
      WHERE position<=20 OR user_id=$2 ORDER BY duration_ms ASC,achieved_at,user_id`,[date,viewerId ?? ''])).rows;
  }
}
