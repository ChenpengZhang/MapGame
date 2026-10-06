# MapGame 后端

面向 `https://zcpenguin.com/mapgame/` 的单体 Node.js / PostgreSQL API。
前端游客玩法仍然本地运行；主页已接入账户、密码找回、游玩记录，故事/随机/爬塔/每日挑战的服务端验证，以及无尽榜与每日榜。

## 架构与边界

```text
src/domain/          纯领域规则：爬塔阈值、成绩结算、北京时间日期
src/application/     GameService：开始/恢复/推进/提交/放弃对局，依赖仓储和路线计算端口
src/infrastructure/  PostgreSQL 仓储、迁移、认证、SMTP、现有寻路器适配
src/http/            HTTP 参数校验、会话身份、Origin 检查、限流、错误映射
src/main.js          组合根：创建适配器并注入应用服务
```

以“认证”和“挑战对局”作为两个边界。Better Auth 管认证；游戏应用只接收已经认证的 user ID。
`game_runs` 是各模式共用的对局聚合根，`run_rounds`、`round_submissions` 在锁定所属对局的事务中修改。
同一用户同城市/情景只有一局进行中的爬塔；重复开始返回原关卡，不重置计时。

模式专属的成绩不塞进通用对局表：

- `timed_run_results`：每日挑战、随机和故事模式的单次用时结果；
- `tower_run_stats`：无尽模式的通关层数、已通过各层累计实际用时及成绩作废状态；
- `daily_challenges`：每日挑战题目定义，通过 `daily_challenge_id` 与 `game_runs` 关联。

因此每日挑战是独立的业务模式，只复用用户归属、版本、状态、并发提交等共通生命周期，不与无尽成绩混存。

第一版没有微服务、消息队列或 Redis。限流使用单进程内存；多个实例上线前应改为共享限流。

## 多机协作约定

所有机器运行同一套后端代码，使用常规 `mapgame` 数据库。仓库共享源码、依赖锁文件和迁移；
每台机器独立配置 `.env`，不把本机用户名、连接密码或认证密钥写进代码。
本机承担验证工作，使用 development 环境的 HTTP 和邮件预览；线上同一套代码通过环境变量启用 HTTPS 和 SMTP。
`NODE_ENV` 表示运行配置，不是另一份测试版代码。
拉取包含数据库变更的代码后执行 `npm ci` 和 `npm start`；启动时自动检查建库并执行迁移。
已经共享或应用的迁移只追加，不修改旧文件。版本控制管理代码，数据库数据另行备份。
自动化集成测试的 `_test` 数据库仅供测试脚本使用，不是应用的默认数据库。

## 环境与启动

需要 Node.js >= 22.13（推荐 24 LTS）、PostgreSQL 17。原项目的本地启动方式不受影响。
在 `backend/` 中执行：

```sh
npm ci
cp .env.example .env
# 编辑 .env，填写本机数据库连接和随机密钥
npm start
```

用 `openssl rand -hex 32` 生成 `BETTER_AUTH_SECRET`。每次启动都会先连接目标数据库，不存在时自动创建，再执行认证及游戏表迁移，全部成功后才监听 API。
已有数据库不会重建、清空或导入示例数据；多进程初始化通过数据库锁序列化。
`npm run migrate` 仍可单独运行，也包含自动建库。

PostgreSQL 服务及登录角色必须已存在。默认使用 `DATABASE_URL` 的账号连接同一服务器的 `postgres` 维护库创建数据库，
该账号需要 `CREATEDB` 权限。也可以配置 `DATABASE_ADMIN_URL` 指向同一服务器上已存在的维护库，
该初始化账号须能建库，并将目标库的所有者设为 `DATABASE_URL` 中的角色。
管理员连接仅用于缺库时建库；后续迁移和 API 都用 `DATABASE_URL`。
常规连接账号需要对目标库具有建表及修改表权限，以便自动迁移。
已有库连接失败、账号密码错误、权限不足或迁移失败时会停止启动，不会删除数据库重试。
自动建库不等于数据迁移：换服务器若要保留玩家数据，仍须备份并恢复原数据库。
本机 Postgres.app 如配置了系统用户认证，可用类似 `postgresql://你的用户名@localhost/mapgame`；
生产环境使用专用数据库用户和独立密码，不使用超级用户作为 API 运行账户。
自动迁移使用常规连接账号，需要目标库的 DDL 权限；无需为它授予 PostgreSQL 超级用户权限。

所有真实密码、数据库 URL、SMTP 密钥只放 `.env` 或服务器环境变量，不能提交 GitHub（包括私有仓库）。
仓库仅提交 `.env.example` 占位符。若曾泄漏真实 URL，应立即轮换密码，删文件不能消除历史泄漏。

认证表由固定版本 Better Auth 配置迁移；游戏 SQL 在 `migrations/`。
游戏迁移带校验和、事务和迁移锁；已应用的 SQL 不要修改，后续新增迁移文件。
升级认证库前应在备份恢复出的测试库验证迁移。

## 邮件

开发默认 `MAIL_TRANSPORT=preview`：邮件写入 `backend/.mail-preview/`，文件仅本机用户可读，且已忽略 Git。
不向外部发送邮件，也不把验证码打印到日志。开发时可在该目录的最新邮件 JSON 中查看 6 位验证码。

生产必须配置 `MAIL_TRANSPORT=smtp` 或 `ses`，否则拒绝启动。两种方式的取舍：

**`smtp`** —— 通用，接任何支持 SMTP 的服务商：

- 服务商中已验证的发信域名和发信地址；
- `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`MAIL_FROM`；
- 按服务商要求配置 SPF / DKIM 等 DNS，实测 QQ / 163 收件。

465 使用 TLS；其他端口要求 STARTTLS，默认验证证书。

> ⚠️ **腾讯云个人实名认证账号已被禁止通过 SMTP 发信**（会直接报错），必须改用下面的 `ses`。

**`ses`** —— 腾讯云邮件推送 API，个人认证账号可用：

- `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`（访问管理 CAM 的 API 密钥，建议用只授 SES 发信权限的子账号）；
- `TENCENT_SES_REGION`（发信域名所在地域，如 `ap-guangzhou` / `ap-hongkong`）；
- `TENCENT_SES_TEMPLATE_ID`（控制台模板管理里的模板 ID）、`MAIL_FROM`；
- 腾讯云 API 发信**强制使用模板**（新账号不支持 `SendEmail` 的 `Simple` 字段），正文在控制台维护，
  变量为 `action` 与 `code`，内容见 [`templates/email/`](templates/email/)。

两种方式连接失败时认证请求都会报错，客户端可重试重发邮件。
密钥直接填写服务器环境，不要通过 Git 或聊天发送。

自测发信（走的是和注册完全相同的代码路径）：

```sh
node --env-file=.env scripts/test-mail.mjs 你的邮箱@example.com
```

## API

基础路径 `/mapgame/api`。写请求使用 JSON，必须有与 `PUBLIC_ORIGIN` 精确匹配的 Origin。
浏览器同域请求携带 Cookie；本地运行根目录 `npm run dev`，前端 8080 端口自动代理 API 到 3001；设置 `PUBLIC_ORIGIN=http://localhost:8080`。
先在仓库根目录执行 `npm run build:web`，将 `dist/mapgame/` 部署为网站 `/mapgame/`。
前端源码现在在 `frontend/`，共用寻路器在 `shared/router.js`；不能仅复制前端源码目录。
生产示例在 `deploy/nginx.conf.example`；代理路径保留完整 `/mapgame/api/`，不要删除前缀。

认证接口由 Better Auth 提供：

| 方法与路径 | JSON 字段 |
|---|---|
| POST `/auth/sign-up/email` | `email`, `password`, `name` |
| POST `/auth/sign-in/email` | `email`, `password` |
| POST `/auth/sign-out` | `{}` |
| GET `/auth/get-session` | 无 |
| POST `/auth/email-otp/send-verification-otp` | `email`, `type: "email-verification"` |
| POST `/auth/email-otp/verify-email` | `email`, `otp` |
| POST `/auth/email-otp/request-password-reset` | `email` |
| POST `/auth/email-otp/check-verification-otp` | `email`, `type: "forget-password"`, `otp` |
| POST `/auth/email-otp/reset-password` | `email`, `otp`, `password` |

注册后必须输入邮件中的 6 位验证码才能登录；密码最少 12 字符。验证码有效期 10 分钟、最多尝试 5 次，服务端仅保存哈希。找回密码按“邮箱 → 验证码 → 新密码”完成，成功后撤销旧会话。

游戏接口（除 health、daily、leaderboard 和自定义关卡组的列表/详情，其余均需已验证邮箱的登录用户）：

| 方法与路径 | 行为 |
|---|---|
| GET `/health` | 检查数据库可连接 |
| GET `/daily` | 每日题目概况；不返回起终点或最优答案 |
| GET `/me` | 当前登录用户 ID |
| GET `/saves` | 当前账户可恢复的爬塔对局 |
| POST `/runs` | `{"mode":"daily"}` 或 `{"mode":"tower","city":"beijing","scenario":"normal"}`；无尽 scenario 可选 `normal / noMetro / busBoost / rain / blind / realRide` |
| GET `/runs/:id` | 恢复原对局和计时 |
| POST `/runs/:id/next` | `{}`；通过后领取下一层，重复请求返回同一层 |
| POST `/runs/:id/submit` | 提交路线，见下例 |
| POST `/runs/:id/abandon` | `{}`；放弃当前对局 |
| GET `/leaderboard?mode=daily&date=2026-09-22` | 每日榜（用时升序，同用时按完成时刻） |
| GET `/leaderboard?mode=tower&city=beijing&scenario=normal` | 当前地图哈希/规则版本的爬塔榜 |
| GET `/custom-maps?sort=popular&q=&page=0` | 自定义关卡组广场（仅公开的；`sort` 为 `popular` 或 `new`，每页 20 个） |
| GET `/custom-maps/:code` | 关卡组详情（8 位分享码，公开与仅链接的都可访问） |
| GET `/my/custom-maps` | 我创建的关卡组 |
| POST `/custom-maps` | 创建：`{title, description, visibility:"public"\|"unlisted", levels:[…]}`，每人最多 30 个 |
| PUT `/custom-maps/:code` | 作者修改；关卡内容变化时版本 +1，旧版本的对局作废、排行重新开始 |
| DELETE `/custom-maps/:code` | 作者删除（软删除），进行中的对局一并作废 |
| POST `/runs` `{"mode":"custom","map":"分享码","restart"?:true}` | 开始/继续一组自定义关卡；每关一个回合，`/runs/:id/next` 领取下一关（本关成败都可继续） |
| GET `/leaderboard?mode=custom&map=分享码` | 关卡组当前版本的排行（总分降序，同分按累计用时） |

自定义关卡（`levels` 数组元素，1–10 个）：`{city, origin:[lng,lat], dest:[lng,lat], scenario, timeLimit, originName?, destName?, title?, text?}`。
`scenario` 为无尽模式的 6 种之一；`timeLimit` 为 `null`、`{"type":"minutes","value":1–300}` 或 `{"type":"ratio","value":1.01–5}`（最速用时的倍数）。
保存时服务端逐关校验：起终点至少相距 1.6 km，且存在乘车路线；出错返回 `LEVEL_TOO_CLOSE:2` 这类带关卡序号的错误码。
最优用时由服务端在每个回合开局时按当前数据重算，客户端不能提交。每关得分 = 5000 × 最优用时 / 路线用时（上限 5000，超时 0 分），规则在 `frontend/js/data/custom-maps.js`，前后端共用。

```json
{
  "stageId": "服务端返回的 UUID",
  "requestId": "客户端为本次最终提交生成的 UUID，网络重试保持不变",
  "route": [
    { "lineId": "线路 ID", "fromStopId": "线路上的物理站点 ID", "toStopId": "线路上的物理站点 ID" }
  ]
}
```

允许情景 `normal`、`noMetro`、`busBoost`、`rain`；允许城市北京、上海、广州、深圳、文山州。
每条 ride 是一段同线连续乘车，后端检查方向、边距离、换乘连通性和起终点步行距离。
相邻同线段允许分开，按前端规则分别计算候车和换乘；最多 200 段，JSON 请求上限 64KB。
无尽模式允许 1.5km 内的站间步行换乘，路线中乘车段和步行段分别标记。服务端检查每个物理站、乘车方向、线路衔接和步行距离，再用权威速度参数逐段重算时间。客户端不提交自己计算的总时间。
起终点步行最多 1.5km，同逻辑站的普通换乘仍按固定换乘成本处理。

## 计分、计时和存档

- 游客不建数据库账户，不接收游客存档/层数导入。登录后从服务端恢复。
- 服务器发题并保存开始时间，收到完整提交后取数据库时间；验证和事务锁等待不计入答题耗时。
- `duration_ms` 是服务端重算的路线模拟耗时；`elapsed_ms` 是答题用时，包含网络延迟，不是纯手速。
- 每层开始时由 PostgreSQL `clock_timestamp()` 写入，结束时取服务端收到提交的时刻；结算响应返回本层与累计 `elapsed_ms`，前端只用于同步显示。
- 客户端不能提交用户 ID、得分、层数、开始/结束时刻、本层/累计计时、题目或规则。SQL 使用参数绑定。
- 一关只能结算一次，重试 request ID 幂等；同一 request ID 换答案返回 409。
- 同用户并发开始通过用户行锁序列化；提交/下一层通过对局行锁序列化，唯一索引再次兜底。
- 爬塔每次验证通过即保存，最高层数按实际通过层数记录。通过后点 next 才开始下一题计时。
- 服务器保存关卡和进度，不保存客户端未提交的半成品路线。半成品仍可本地缓存。
- 每日按北京时间切日，每天从大城市（`BIG_CITIES`：北京、上海、广州、深圳、成都、重庆、杭州、武汉、南京、天津、青岛、昆明、厦门、济南、郑州、长春）中随机选一个城市出一道普通模式题，首次访问生成并唯一持久化。允许多次尝试，取最好成绩。
- 每日挑战不向玩家公布最优路线：提交结果里不返回 `optimal_duration_ms`，前端也不计算、不绘制最优路线。
- 每日榜排名第一键为公共交通用时（升序），第二键为该成绩的完成时刻（同用时更早完成者靠前）。
- 每日榜按路线耗时；爬塔先按已验证通过层数降序，同层再按已通过各层的累计实际游玩时间 `elapsed_ms` 升序。接口返回前 20 名；已登录玩家不在前 20 时额外返回其本人名次。随机起终点的路线模拟耗时 `duration_ms` 不参与无尽同层排名。
- 固定每日题不用于严格手速排名：提前看题、脚本解题无法仅靠计时排除。
- 地图使用 SHA-256 与规则版本固定题目；当前进程缓存已加载地图。更新数据必须重启服务。
- 第一版只加载当前版本数据，旧哈希对局拒绝继续验证；更新前需安排旧局结束或放弃。后续可加多版本数据存储。
- 未提供独立手速竞技模式、排行榜赛季、管理界面；成绩表预留后台作废字段。

## 验证

```sh
npm test
# 必须使用独立、以 _test 结尾的数据库；会建表和测试数据，不能指向业务库。
TEST_DATABASE_URL=postgresql://你的用户名@localhost/mapgame_backend_test npm test
```

无 TEST_DATABASE_URL 时集成测试明确跳过。集成测试覆盖真实认证/重置、Cookie、越权、伪造字段、
并发开始/提交/推进、重复请求、挑战过期、成绩作废和榜单。路线验证单独使用合成及真实北京数据测试。

部署前备份数据库；启动会自动执行迁移。API 仅绑定 loopback；不要在防火墙开放 PostgreSQL。
Nginx 静态目录只复制前端资源，绝不能指向含后端和 .env 的整个仓库。

## 已接入的游玩记录

- `GET /history[?cursor=]`：当前账户已验证记录，新→旧每页 50 条，返回 `{ rows, next }`；把 `next` 作为 `cursor` 取下一页（`null` 表示没有更多）。
- `GET /tower-progress?city=beijing`：各情景最高层数及进行中层数。
- `POST /runs` 支持 `{ "mode":"story", "levelId":"wenshan_intro" }`；当前仅开放这一教学关，故事定义由服务端读取纯数据模块，不接受客户端关卡内容或时限。
- 随机模式请求 `{ "mode":"free", "city":"beijing", "options":{ "noMetro":false, "busBoost":false, "rain":false } }`；仅接受这些布尔选项，速度由服务端推导。
- 故事和随机模式完成后保存记录，不保存故事解锁进度；新的练习对局会放弃旧的未完成练习。
- `002-play-history.sql` 增量扩展模式约束；不能修改已应用迁移。
- 上传失败保留原路线和请求 ID 重试，服务器只结算一次。客户端的显示值不作为成绩依据。

真实浏览器账户回归（仓库根目录执行，需 Playwright 和系统 Chrome）：
```sh
TEST_DATABASE_URL=postgresql://你的用户名@localhost/mapgame_backend_test node backend/test/e2e-account.mjs
```
可用 `PLAYWRIGHT_MODULE` 指定 Playwright 模块路径。覆盖游客入口、注册验证、登录、真实路线入库、伪造线路拒绝、响应丢失幂等重试、历史记录、退出和密码重置。邮件在测试内存中捕获，不发送到外部邮箱。

## 玩家规划记录（`play_traces`，行为分析用）

每局一行，记录玩家“怎么规划的”，不参与计分。前端 `frontend/js/game/trace.js` 采集，`POST /mapgame/api/traces` 上报（游客也可以，按 IP 限频）：
完成路线时上报一次；中途回主页、开下一局、刷新/关闭页面、切到后台时按“放弃”上报当时的过程与半成品路线（同一局同一 id，之后完成会覆盖为最新）。
设置页「隐私 → 匿名记录规划过程」可关闭。

| 字段 | 说明 |
|---|---|
| `user_id` / `anon_id` | 登录玩家的账号（删号后置空）/ 每个浏览器一个随机匿名 id |
| `run_id` / `round_id` | 登录玩家的正式对局与关卡（可与 `round_submissions` 的最终成绩关联） |
| `mode` `city_id` `scenario` `level_id` | 模式（free/story/tower/daily/custom）、城市、情景开关、关卡（故事关 id、无尽 `layer:N`、自定义 `分享码:序号`） |
| `outcome` `duration_ms` | `finished` / `abandoned`，开局到上报的毫秒数 |
| `events` | 操作序列 `{t: 开局后毫秒, e: 类型, …}`，见下表 |
| `route` | 完成或放弃时的路线：`start` 首站、`ride` 乘某线到某站、`walk` 步行换乘到某站 |
| `summary` `client` | 站数/乘车段/步行段/玩家用时；屏幕尺寸、触屏、底图、步行换乘开关、前端版本 |

事件类型：`preview`（预览站点，`first:1` 为首站）、`start`（确定首站）、`direct`（从图钉/站点选择框直接确定）、
`ride` / `walk`（乘车或步行到某站）、`line`（选中/取消线路 `on`）、`cancel`（点空白取消预览）、`undo`、`reset`、
`force_walk`、`show_all`、`reject`（点了不允许的站，`why`: far/river）、`finish`、`leave`、`truncated`（页面关闭时过长被截断）。

常用查询：

```sql
-- 各模式的完成率与平均用时
SELECT mode, count(*) AS games, round(avg((outcome='finished')::int)*100,1) AS finish_pct,
       round(avg(duration_ms)/1000) AS avg_sec
FROM play_traces GROUP BY mode ORDER BY games DESC;

-- 放弃的局卡在第几步（放弃时已确定的站数）
SELECT (summary->>'stops')::int AS stops_when_left, count(*) FROM play_traces
WHERE outcome='abandoned' GROUP BY 1 ORDER BY 1;

-- 每局平均预览、撤回次数（犹豫程度）
SELECT mode,
  round(avg((SELECT count(*) FROM jsonb_array_elements(events) e WHERE e->>'e'='preview')),1) AS previews,
  round(avg((SELECT count(*) FROM jsonb_array_elements(events) e WHERE e->>'e'='undo')),1) AS undos
FROM play_traces GROUP BY mode;

-- 登录玩家：规划过程 + 服务端核定的成绩
SELECT t.events, s.duration_ms, s.passed, r.optimal_duration_ms
FROM play_traces t JOIN round_submissions s ON s.round_id=t.round_id JOIN run_rounds r ON r.id=t.round_id;
```
