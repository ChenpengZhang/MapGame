-- A run is the common lifecycle shared by every mode. A round is one puzzle
-- inside that run: tower runs have many rounds; daily/free/story usually have one.
ALTER TABLE run_stages RENAME TO run_rounds;
ALTER TABLE run_rounds RENAME COLUMN stage_no TO round_no;
ALTER TABLE run_submissions RENAME TO round_submissions;
ALTER TABLE round_submissions RENAME COLUMN stage_id TO round_id;

-- Tower has a different score shape from timed modes, so keep its live progress
-- and leaderboard aggregate in a dedicated one-to-one table.
CREATE TABLE tower_run_stats (
  run_id uuid PRIMARY KEY REFERENCES game_runs(id) ON DELETE CASCADE,
  cleared_layers integer NOT NULL DEFAULT 0 CHECK (cleared_layers >= 0),
  total_duration_ms bigint NOT NULL DEFAULT 0 CHECK (total_duration_ms >= 0),
  achieved_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  invalidation_reason text
);

INSERT INTO tower_run_stats(run_id,cleared_layers,total_duration_ms,achieved_at,invalidated_at,invalidation_reason)
SELECT g.id,g.cleared_layers,
  COALESCE(sum(s.duration_ms) FILTER (WHERE s.passed),0),
  COALESCE(r.achieved_at,g.created_at),r.invalidated_at,r.invalidation_reason
FROM game_runs g
LEFT JOIN run_results r ON r.run_id=g.id
LEFT JOIN run_rounds q ON q.run_id=g.id
LEFT JOIN round_submissions s ON s.round_id=q.id
WHERE g.mode='tower'
GROUP BY g.id,g.cleared_layers,r.achieved_at,g.created_at,r.invalidated_at,r.invalidation_reason;

DELETE FROM run_results r USING game_runs g WHERE r.run_id=g.id AND g.mode='tower';
ALTER TABLE run_results DROP CONSTRAINT run_results_check;
ALTER TABLE run_results DROP CONSTRAINT run_results_cleared_layers_check;
ALTER TABLE run_results DROP COLUMN cleared_layers;
ALTER TABLE run_results ALTER COLUMN duration_ms SET NOT NULL;
ALTER TABLE run_results RENAME TO timed_run_results;

-- cleared_layers is tower-only state and no longer belongs in the common run row.
ALTER TABLE game_runs DROP COLUMN cleared_layers;

CREATE INDEX tower_run_stats_rank ON tower_run_stats(cleared_layers DESC,total_duration_ms ASC,achieved_at)
  WHERE invalidated_at IS NULL AND cleared_layers > 0;

COMMENT ON TABLE game_runs IS 'Common lifecycle for daily, tower, free and story runs.';
COMMENT ON TABLE run_rounds IS 'One generated puzzle within a run; tower has multiple rounds, other modes normally one.';
COMMENT ON TABLE round_submissions IS 'One authoritative route submission per round.';
COMMENT ON TABLE timed_run_results IS 'Final duration for one-round timed modes such as daily, free and story.';
COMMENT ON TABLE tower_run_stats IS 'Tower-only progress and leaderboard aggregate; ties use total_duration_ms.';
