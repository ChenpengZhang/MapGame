-- Six more big cities (500+ bus/metro lines) for endless mode and the rotating daily challenge.
ALTER TABLE game_runs DROP CONSTRAINT game_runs_city_id_check;
ALTER TABLE game_runs ADD CONSTRAINT game_runs_city_id_check
  CHECK (city_id IN ('beijing','shanghai','guangzhou','shenzhen','wenshan','shuanghe','kokdala','datong',
    'chengdu','chongqing','hangzhou','wuhan','nanjing','tianjin'));
