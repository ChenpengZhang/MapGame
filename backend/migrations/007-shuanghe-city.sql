-- Story level 2 (transfer tutorial) uses Shuanghe, a city with exactly two crossing bus lines.
ALTER TABLE game_runs DROP CONSTRAINT game_runs_city_id_check;
ALTER TABLE game_runs ADD CONSTRAINT game_runs_city_id_check
  CHECK (city_id IN ('beijing','shanghai','guangzhou','shenzhen','wenshan','shuanghe'));
