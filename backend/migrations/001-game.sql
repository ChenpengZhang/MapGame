CREATE TABLE daily_challenges (
  id uuid PRIMARY KEY,
  challenge_date date NOT NULL UNIQUE,
  puzzle jsonb NOT NULL CHECK (jsonb_typeof(puzzle) = 'object'),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL CHECK (closes_at > opens_at),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE game_runs (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('daily','tower')),
  daily_challenge_id uuid REFERENCES daily_challenges(id),
  city_id text NOT NULL CHECK (city_id IN ('beijing','shanghai','guangzhou','shenzhen')),
  scenario_key text NOT NULL CHECK (scenario_key IN ('normal','noMetro','busBoost','rain')),
  data_hash text NOT NULL,
  rules_version integer NOT NULL CHECK (rules_version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned','invalid')),
  cleared_layers integer NOT NULL DEFAULT 0 CHECK (cleared_layers >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK ((mode = 'daily') = (daily_challenge_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_tower ON game_runs(user_id,city_id,scenario_key) WHERE mode='tower' AND status='active';
CREATE UNIQUE INDEX one_active_daily ON game_runs(user_id,daily_challenge_id) WHERE mode='daily' AND status='active';
CREATE INDEX runs_user ON game_runs(user_id,created_at DESC);
CREATE INDEX runs_daily ON game_runs(daily_challenge_id,user_id);
CREATE INDEX runs_board ON game_runs(mode,city_id,scenario_key,data_hash,rules_version);
CREATE TABLE run_stages (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES game_runs(id) ON DELETE CASCADE,
  stage_no integer NOT NULL CHECK (stage_no > 0),
  puzzle jsonb NOT NULL CHECK (jsonb_typeof(puzzle) = 'object'),
  optimal_duration_ms bigint NOT NULL CHECK (optimal_duration_ms > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','passed','failed')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(run_id,stage_no)
);
CREATE TABLE run_submissions (
  id uuid PRIMARY KEY,
  stage_id uuid NOT NULL UNIQUE REFERENCES run_stages(id) ON DELETE CASCADE,
  request_id uuid NOT NULL UNIQUE,
  route jsonb NOT NULL CHECK (jsonb_typeof(route) = 'array'),
  duration_ms bigint NOT NULL CHECK (duration_ms > 0),
  elapsed_ms bigint NOT NULL CHECK (elapsed_ms >= 0),
  passed boolean NOT NULL,
  submitted_at timestamptz NOT NULL
);
-- One server-maintained result per run; active towers can also rank their verified cleared layers.
CREATE TABLE run_results (
  run_id uuid PRIMARY KEY REFERENCES game_runs(id) ON DELETE CASCADE,
  duration_ms bigint CHECK (duration_ms > 0),
  cleared_layers integer CHECK (cleared_layers >= 0),
  achieved_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  invalidation_reason text,
  CHECK ((duration_ms IS NULL) <> (cleared_layers IS NULL))
);
