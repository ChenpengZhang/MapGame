-- Endless mode gains two presentation-only scenarios: blind (no basemap) and realRide (no undo).
ALTER TABLE game_runs DROP CONSTRAINT game_runs_scenario_key_check;
ALTER TABLE game_runs ADD CONSTRAINT game_runs_scenario_key_check
  CHECK (scenario_key IN ('normal','noMetro','busBoost','rain','blind','realRide','custom'));
