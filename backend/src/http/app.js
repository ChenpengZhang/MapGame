import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { GameError, CITIES, SCENARIOS } from '../domain/rules.js';

const uuid = z.string().uuid();
const city = z.enum(CITIES);
const scenario = z.enum(Object.keys(SCENARIOS));
export const startBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('daily') }).strict(),
  z.object({ mode: z.literal('tower'),city,scenario }).strict(),
  z.object({ mode: z.literal('free'),city,options:z.object({noMetro:z.boolean(),busBoost:z.boolean(),rain:z.boolean()}).strict() }).strict(),
  z.object({ mode: z.literal('story'),levelId:z.enum(['school','yizhuang','airport','metrodown','smooth','rain']) }).strict(),
]);
export const submissionBody = z.object({
  stageId: uuid, requestId: uuid,
  route: z.array(z.union([
    z.object({ type:z.literal('ride').optional(),lineId:z.string().min(1).max(256),fromStopId:z.string().min(1).max(256),toStopId:z.string().min(1).max(256) }).strict(),
    z.object({ type:z.literal('walk'),fromStopId:z.string().min(1).max(256),toStopId:z.string().min(1).max(256) }).strict(),
  ])).min(1).max(200),
}).strict();
const boardQuery = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('daily'),date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v) }).strict(),
  z.object({ mode: z.literal('tower'),city,scenario }).strict(),
]);
const empty = z.object({}).strict();
export function createApp({ auth, game, repository, config }) {
  const app = express();
  app.disable('x-powered-by');
  // Only loopback Nginx is trusted; deploy config overwrites forwarding headers.
  app.set('trust proxy','loopback');
  app.use(helmet());
  const prefix = '/mapgame/api';
  app.use(prefix, (req,res,next) => {
    res.set('Cache-Control','no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.get('origin') !== config.PUBLIC_ORIGIN) {
      return res.status(403).json({ error: 'UNTRUSTED_ORIGIN' });
    }
    next();
  });
  app.use(prefix,rateLimit({ windowMs: 60000,limit: 120,standardHeaders: 'draft-8',legacyHeaders: false }));
  app.use(`${prefix}/auth`,(req,res,next) => {
    req.headers['x-real-ip'] = req.ip;
    if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON_REQUIRED' });
    next();
  });
  // Better Call's Node adapter supports a pre-read string body; limit auth payloads too.
  app.all(`${prefix}/auth/{*path}`,express.text({ type: 'application/json',limit: '16kb' }),toNodeHandler(auth));
  app.use(prefix,express.json({ limit: '64kb' }));
  // Timestamp after body receipt, before validation/route calculation or transaction lock waits.
  app.use(prefix,async (req,res,next) => {
    if (req.method === 'POST' && /\/submit$/.test(req.path)) req.receivedAt = await repository.now();
    next();
  });
  app.get(`${prefix}/health`,async (req,res) => { await repository.now(); res.json({ ok: true }); });
  app.get(`${prefix}/daily`,async (req,res) => res.json(await game.dailyInfo()));
  app.get(`${prefix}/leaderboard`,async (req,res) => {
    const session=await auth.api.getSession({headers:fromNodeHeaders(req.headers)});
    const viewerId=session?.user?.emailVerified?session.user.id:null;
    res.json(await game.leaderboard(boardQuery.parse(req.query),viewerId));
  });
  app.use(prefix,async (req,res,next) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user?.emailVerified) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
    req.userId = session.user.id;
    next();
  });
  app.use(prefix,rateLimit({ windowMs: 60000,limit: 30,keyGenerator: req => req.userId,standardHeaders: 'draft-8',legacyHeaders: false }));
  app.get(`${prefix}/me`,(req,res) => res.json({ userId: req.userId }));
  app.get(`${prefix}/history`,async (req,res) => res.json(await game.history(req.userId)));
  app.get(`${prefix}/tower-progress`,async (req,res) => {
    const query=z.object({city}).strict().parse(req.query);
    res.json(await game.towerProgress(req.userId,query.city));
  });
  app.get(`${prefix}/saves`,async (req,res) => res.json(await game.saves(req.userId)));
  app.post(`${prefix}/runs`,async (req,res) => res.json(await game.start(req.userId,startBody.parse(req.body))));
  app.get(`${prefix}/runs/:id`,async (req,res) => res.json(await game.resume(req.userId,uuid.parse(req.params.id))));
  app.post(`${prefix}/runs/:id/next`,async (req,res) => {
    empty.parse(req.body); res.json(await game.next(req.userId,uuid.parse(req.params.id)));
  });
  app.post(`${prefix}/runs/:id/submit`,async (req,res) => res.json(await game.submit(
    req.userId,uuid.parse(req.params.id),submissionBody.parse(req.body),req.receivedAt)));
  app.post(`${prefix}/runs/:id/abandon`,async (req,res) => {
    empty.parse(req.body); await game.abandon(req.userId,uuid.parse(req.params.id)); res.status(204).end();
  });
  app.use((req,res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use((error,req,res,next) => {
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
