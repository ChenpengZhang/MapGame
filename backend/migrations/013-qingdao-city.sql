-- Qingdao (1600+ bus/metro lines): playable in every mode and part of the daily-challenge city rotation.
ALTER TABLE game_runs DROP CONSTRAINT game_runs_city_id_check;
ALTER TABLE game_runs ADD CONSTRAINT game_runs_city_id_check
  CHECK (city_id IN ('beijing','shanghai','guangzhou','shenzhen','wenshan','shuanghe','kokdala','datong',
    'chengdu','chongqing','hangzhou','wuhan','nanjing','tianjin','qingdao'));
