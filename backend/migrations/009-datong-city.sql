-- Story level 4 (express vs local bus tutorial) uses Datong.
ALTER TABLE game_runs DROP CONSTRAINT game_runs_city_id_check;
ALTER TABLE game_runs ADD CONSTRAINT game_runs_city_id_check
  CHECK (city_id IN ('beijing','shanghai','guangzhou','shenzhen','wenshan','shuanghe','kokdala','datong'));
