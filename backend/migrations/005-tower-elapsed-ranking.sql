-- Random tower puzzles are not directly comparable by route duration. Rank equal
-- layers by the player's accumulated planning time instead.
DROP INDEX tower_run_stats_rank;
ALTER TABLE tower_run_stats RENAME COLUMN total_duration_ms TO total_elapsed_ms;
ALTER TABLE tower_run_stats RENAME CONSTRAINT tower_run_stats_total_duration_ms_check TO tower_run_stats_total_elapsed_ms_check;

UPDATE tower_run_stats t
SET total_elapsed_ms = COALESCE((
  SELECT sum(s.elapsed_ms)
  FROM run_rounds r
  JOIN round_submissions s ON s.round_id=r.id
  WHERE r.run_id=t.run_id AND s.passed
),0);

CREATE INDEX tower_run_stats_rank ON tower_run_stats(cleared_layers DESC,total_elapsed_ms ASC,achieved_at)
  WHERE invalidated_at IS NULL AND cleared_layers > 0;

COMMENT ON TABLE tower_run_stats IS 'Tower-only progress and leaderboard aggregate; equal layers use accumulated elapsed planning time.';
