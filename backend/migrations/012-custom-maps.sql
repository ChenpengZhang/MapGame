-- Custom mode: player-made level groups ("maps"), shared by code or on the public plaza.
CREATE TABLE custom_maps (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 40),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  visibility text NOT NULL CHECK (visibility IN ('public','unlisted')),
  levels jsonb NOT NULL CHECK (jsonb_typeof(levels) = 'array' AND jsonb_array_length(levels) BETWEEN 1 AND 10),
  -- Bumped whenever the levels change: runs and leaderboard rows are bound to one version.
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  play_count integer NOT NULL DEFAULT 0 CHECK (play_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);
CREATE INDEX custom_maps_public_new ON custom_maps(created_at DESC)
  WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX custom_maps_public_popular ON custom_maps(play_count DESC, created_at DESC)
  WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX custom_maps_owner ON custom_maps(owner_id, updated_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE game_runs DROP CONSTRAINT game_runs_mode_check;
ALTER TABLE game_runs ADD CONSTRAINT game_runs_mode_check CHECK (mode IN ('daily','tower','free','story','custom'));
ALTER TABLE game_runs ADD COLUMN custom_map_id uuid REFERENCES custom_maps(id) ON DELETE CASCADE;
ALTER TABLE game_runs ADD COLUMN custom_map_version integer;
ALTER TABLE game_runs ADD CONSTRAINT custom_run_has_map
  CHECK ((mode = 'custom') = (custom_map_id IS NOT NULL AND custom_map_version IS NOT NULL));
CREATE UNIQUE INDEX one_active_custom ON game_runs(user_id, custom_map_id) WHERE mode = 'custom' AND status = 'active';
CREATE INDEX runs_custom_board ON game_runs(custom_map_id, custom_map_version) WHERE mode = 'custom';

ALTER TABLE round_submissions ADD COLUMN score integer CHECK (score IS NULL OR score >= 0);

-- Custom runs: rounds done doubles as the "cleared" counter used to sequence rounds.
CREATE TABLE custom_run_stats (
  run_id uuid PRIMARY KEY REFERENCES game_runs(id) ON DELETE CASCADE,
  rounds_done integer NOT NULL DEFAULT 0 CHECK (rounds_done >= 0),
  total_score integer NOT NULL DEFAULT 0 CHECK (total_score >= 0),
  total_elapsed_ms bigint NOT NULL DEFAULT 0 CHECK (total_elapsed_ms >= 0),
  achieved_at timestamptz NOT NULL,
  invalidated_at timestamptz
);

COMMENT ON TABLE custom_maps IS 'Player-made level groups; levels jsonb holds 1-10 validated level definitions.';
COMMENT ON TABLE custom_run_stats IS 'Custom-mode progress and leaderboard aggregate (total score, then elapsed time).';
