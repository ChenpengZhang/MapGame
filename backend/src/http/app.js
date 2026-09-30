import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { GameError, CITIES, SCENARIOS } from '../domain/rules.js';
import { LEVELS } from '../../../frontend/js/data/levels.js';
import { CUSTOM_LIMITS as L, CUSTOM_SCENARIO_KEYS } from '../../../frontend/js/data/custom-maps.js';

const uuid = z.string().uuid();
const city = z.enum(CITIES);
const scenario = z.enum(Object.keys(SCENARIOS));

const shareCode = z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/);
const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const shortText = (max) => z.string().trim().max(max);

/** 一个自定义关卡：只接受这些字段（最优用时等由服务端计算，不接受客户端提供） */
export const customLevel = z.object({
  city,
  origin: lngLat,
  dest: lngLat,
  originName: shortText(L.placeNameMax).optional(),
  destName: shortText(L.placeNameMax).optional(),
  scenario: z.enum(CUSTOM_SCENARIO_KEYS),
  timeLimit: z.union([
    z.null(),
    z.object({ type: z.literal('minutes'), value: z.number().int().min(L.minutesMin).max(L.minutesMax) }).strict(),
    z.object({ type: z.literal('ratio'), value: z.number().min(L.ratioMin).max(L.ratioMax) }).strict(),
  ]),
  title: shortText(L.levelTitleMax).optional(),
  text: shortText(L.levelTextMax).optional(),
}).strict();

export const customMapBody = z.object({
  title: z.string().trim().min(1).max(L.titleMax),
  description: shortText(L.descriptionMax).default(''),
  visibility: z.enum(['public', 'unlisted']),
  levels: z.array(customLevel).min(1).max(L.maxLevels),
}).strict();

const customListQuery = z.object({
  sort: z.enum(['popular', 'new']).default('popular'),
  q: z.string().max(40).default(''),
  page: z.coerce.number().int().min(0).max(50).default(0),
}).strict();

export const startBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('custom'), map: shareCode, restart: z.boolean().optional() }).strict(),
  z.object({ mode: z.literal('daily') }).strict(),
  z.object({ mode: z.literal('tower'), city, scenario }).strict(),
  z.object({
    mode: z.literal('free'),
    city,
    options: z.object({ noMetro: z.boolean(), busBoost: z.boolean(), rain: z.boolean() }).strict(),
  }).strict(),
  z.object({
    mode: z.literal('story'),
    levelId: z.enum(LEVELS.map((level) => level.id)),
  }).strict(),
]);

export const submissionBody = z.object({
  stageId: uuid,
  requestId: uuid,
  route: z.array(
    z.union([
      z.object({
        type: z.literal('ride').optional(),
        lineId: z.string().min(1).max(256),
        fromStopId: z.string().min(1).max(256),
        toStopId: z.string().min(1).max(256),
      }).strict(),
      z.object({
        type: z.literal('walk'),
        fromStopId: z.string().min(1).max(256),
        toStopId: z.string().min(1).max(256),
      }).strict(),
    ]),
  ).min(1).max(200),
}).strict();

const boardQuery = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('daily'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
      (v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
    ),
  }).strict(),
  z.object({ mode: z.literal('tower'), city, scenario }).strict(),
  z.object({ mode: z.literal('custom'), map: shareCode }).strict(),
]);

const empty = z.object({}).strict();

export function createApp({ auth, game, repository, config }) {
  const app = express();
  app.disable('x-powered-by');

  // Only loopback Nginx is trusted; deploy config overwrites forwarding headers.
  app.set('trust proxy', 'loopback');
  app.use(helmet());

  const prefix = '/mapgame/api';

  // 同源校验：写请求必须携带与 PUBLIC_ORIGIN 完全一致的 Origin，防止跨站伪造。
  app.use(prefix, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== config.PUBLIC_ORIGIN) {
      return res.status(403).json({ error: 'UNTRUSTED_ORIGIN' });
    }
    next();
  });

  app.use(prefix, rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

  app.use(`${prefix}/auth`, (req, res, next) => {
    req.headers['x-real-ip'] = req.ip;
    if (req.method === 'POST' && !req.is('application/json')) {
      return res.status(415).json({ error: 'JSON_REQUIRED' });
    }
    next();
  });

  // Better Auth's Node adapter supports a pre-read string body; limit auth payloads too.
  app.all(`${prefix}/auth/{*path}`, express.text({ type: 'application/json', limit: '16kb' }), toNodeHandler(auth));

  app.use(prefix, express.json({ limit: '64kb' }));

  // 在读完 body 之后、进入校验/寻路/事务锁之前打点：
  // 这样答题耗时不含网络传输与事务排队等待，只算“实际答题时间”。
  app.use(prefix, async (req, res, next) => {
    if (req.method === 'POST' && /\/submit$/.test(req.path)) req.receivedAt = await repository.now();
    next();
  });

  app.get(`${prefix}/health`, async (req, res) => {
    await repository.now();
    res.json({ ok: true });
  });

  app.get(`${prefix}/daily`, async (req, res) => res.json(await game.dailyInfo()));

  app.get(`${prefix}/leaderboard`, async (req, res) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    const viewerId = session?.user?.emailVerified ? session.user.id : null;
    res.json(await game.leaderboard(boardQuery.parse(req.query), viewerId));
  });

  // 自定义关卡组：广场列表与详情对游客公开（游客可以本地游玩，但不计入排行）
  const viewer = async (req) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    return session?.user?.emailVerified ? session.user.id : null;
  };
  app.get(`${prefix}/custom-maps`, async (req, res) =>
    res.json(await game.listCustomMaps(customListQuery.parse(req.query))));
  app.get(`${prefix}/custom-maps/:code`, async (req, res) =>
    res.json(await game.getCustomMap(shareCode.parse(req.params.code), await viewer(req))));

  // 以下路由都要求“已登录且邮箱已验证”；游客只能访问上面的公开接口。
  app.use(prefix, async (req, res, next) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user?.emailVerified) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
    req.userId = session.user.id;
    next();
  });

  app.use(prefix, rateLimit({ windowMs: 60000, limit: 30, keyGenerator: (req) => req.userId, standardHeaders: 'draft-8', legacyHeaders: false }));

  app.get(`${prefix}/me`, (req, res) => res.json({ userId: req.userId }));
  app.get(`${prefix}/history`, async (req, res) => res.json(await game.history(req.userId)));
  app.get(`${prefix}/story-progress`, async (req, res) => res.json(await game.storyProgress(req.userId)));

  app.get(`${prefix}/tower-progress`, async (req, res) => {
    const query = z.object({ city }).strict().parse(req.query);
    res.json(await game.towerProgress(req.userId, query.city));
  });

  app.get(`${prefix}/saves`, async (req, res) => res.json(await game.saves(req.userId)));

  app.get(`${prefix}/my/custom-maps`, async (req, res) => res.json(await game.myCustomMaps(req.userId)));
  app.post(`${prefix}/custom-maps`, async (req, res) =>
    res.json(await game.createCustomMap(req.userId, customMapBody.parse(req.body))));
  app.put(`${prefix}/custom-maps/:code`, async (req, res) =>
    res.json(await game.updateCustomMap(req.userId, shareCode.parse(req.params.code), customMapBody.parse(req.body))));
  app.delete(`${prefix}/custom-maps/:code`, async (req, res) => {
    await game.deleteCustomMap(req.userId, shareCode.parse(req.params.code));
    res.status(204).end();
  });

  app.post(`${prefix}/runs`, async (req, res) =>
    res.json(await game.start(req.userId, startBody.parse(req.body))),
  );

  app.get(`${prefix}/runs/:id`, async (req, res) =>
    res.json(await game.resume(req.userId, uuid.parse(req.params.id))),
  );

  app.post(`${prefix}/runs/:id/next`, async (req, res) => {
    empty.parse(req.body);
    res.json(await game.next(req.userId, uuid.parse(req.params.id)));
  });

  app.post(`${prefix}/runs/:id/submit`, async (req, res) =>
    res.json(await game.submit(
      req.userId,
      uuid.parse(req.params.id),
      submissionBody.parse(req.body),
      req.receivedAt,
    )),
  );

  app.post(`${prefix}/runs/:id/abandon`, async (req, res) => {
    empty.parse(req.body);
    await game.abandon(req.userId, uuid.parse(req.params.id));
    res.status(204).end();
  });

  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

  // 统一错误映射：校验错 400、业务错用 GameError 自带状态码、
  // 唯一约束冲突（并发兜底）409、其余 500；日志不打印任何敏感字段。
  app.use((error, req, res, next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'INVALID_INPUT' });
    if (error instanceof GameError) return res.status(error.status).json({ error: error.code });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'BODY_TOO_LARGE' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'INVALID_JSON' });
    if (error.code === '23505') return res.status(409).json({ error: 'CONCURRENT_CONFLICT' });
    // Do not log SQL parameters, connection strings, routes, cookies or reset URLs.
    console.error('Request failed', { type: error.constructor.name, code: error.code ?? 'INTERNAL' });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  return app;
}
