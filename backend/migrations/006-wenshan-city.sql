-- Story mode now uses Wenshan for its shared beginner tutorial.
-- Replace the original four-city constraint without editing applied migration 001.
ALTER TABLE game_runs DROP CONSTRAINT game_runs_city_id_check;
ALTER TABLE game_runs ADD CONSTRAINT game_runs_city_id_check
  CHECK (city_id IN ('beijing','shanghai','guangzhou','shenzhen','wenshan'));
