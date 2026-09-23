ALTER TABLE game_runs DROP CONSTRAINT game_runs_mode_check;
ALTER TABLE game_runs ADD CONSTRAINT game_runs_mode_check CHECK (mode IN ('daily','tower','free','story'));
ALTER TABLE game_runs DROP CONSTRAINT game_runs_scenario_key_check;
ALTER TABLE game_runs ADD CONSTRAINT game_runs_scenario_key_check CHECK (scenario_key IN ('normal','noMetro','busBoost','rain','custom'));
ALTER TABLE game_runs ADD CONSTRAINT custom_scenario_only_free CHECK (scenario_key <> 'custom' OR mode = 'free');
