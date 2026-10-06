import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { betterAuth } from 'better-auth';
import { authOptions, deleteStaleUnverifiedUsers } from '../src/infrastructure/auth.js';
import { migrate } from '../src/infrastructure/migrate.js';

const url = process.env.TEST_DATABASE_URL;
const config = { PUBLIC_ORIGIN: 'http://localhost:3001', NODE_ENV: 'test', BETTER_AUTH_SECRET: 'test-only-secret-'.repeat(4) };

test('migration renames existing duplicate nicknames and then enforces uniqueness', { skip: !url }, async (t) => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  const schema = 'names_' + randomUUID().replaceAll('-', '').slice(0, 12);
  t.after(async () => { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); client.release(); await pool.end(); });
  // 在独立 schema 里放一张同结构的 "user" 表跑迁移，不碰真实数据
  await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
    CREATE TABLE "user"(id text PRIMARY KEY, name text NOT NULL, "emailVerified" boolean NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL)`);
  const rows = [['a', 'Tom', 1, true], ['b', 'tom ', 2, true], ['c', 'TOM', 3, true], ['d', 'Tom#2', 0, true], ['e', 'Ann', 4, true], ['u', 'tom', 0, false]];
  for (const [id, name, minute, verified] of rows) {
    await client.query(`INSERT INTO "user" VALUES($1,$2,$3,timestamp '2026-01-01' + $4 * interval '1 minute', now())`, [id, name, verified, minute]);
  }
  await client.query(await readFile(new URL('../migrations/016-unique-user-names.sql', import.meta.url), 'utf8'));
  const names = Object.fromEntries((await client.query('SELECT id,name FROM "user"')).rows.map((r) => [r.id, r.name]));
  assert.equal(names.a, 'Tom', '已验证账号里最早注册的保留原名（更早的未验证账号不算）');
  assert.equal(names.u, 'tom', '未验证账号不改名');
  assert.equal(names.d, 'Tom#2', '本来就叫 Tom#2 的不受影响');
  assert.equal(names.e, 'Ann');
  assert.notEqual(names.b.toLowerCase(), names.c.toLowerCase());
  assert.ok(!['tom', 'tom#2'].includes(names.b.toLowerCase()) && !['tom', 'tom#2'].includes(names.c.toLowerCase()), JSON.stringify(names));
  await assert.rejects(client.query(`INSERT INTO "user" VALUES('f',' tom ',true,now(),now())`), /user_name_unique/, '已验证账号重名（忽略大小写和空格）被唯一索引拒绝');
  await client.query(`INSERT INTO "user" VALUES('g',' tom ',false,now(),now())`); // 未验证的同名账号可以存在
});

test('PostgreSQL + Better Auth: nicknames are unique among verified accounts; unverified ones never block a name', { skip: !url }, async (t) => {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  const auth = betterAuth(authOptions(config, pool, async () => {}));
  await migrate(pool, authOptions(config, pool, async () => {}));
  const tag = randomUUID().slice(0, 8);
  const emails = ['a', 'b', 'typo', 'fixed', 'late', 'stale'].map((k) => `${k}-${tag}@example.test`);
  const [ea, eb, eTypo, eFixed, eLate, eStale] = emails;
  t.after(async () => { await pool.query('DELETE FROM "user" WHERE email=ANY($1::text[])', [emails]); await pool.end(); });
  const name = `玩家${tag}`;
  const signUp = (email, nick) => auth.api.signUpEmail({ body: { email, password: 'correct-horse-battery', name: nick } });
  const verify = (email) => pool.query('UPDATE "user" SET "emailVerified"=true WHERE email=$1', [email]);
  const code = async (promise) => { try { await promise; return 'OK'; } catch (error) { return error.body?.code || error.message; } };
  const nameOf = async (email) => (await pool.query('SELECT name FROM "user" WHERE email=$1', [email])).rows[0]?.name;

  // 1. 注册：去掉首尾空格；非法昵称拒绝
  assert.equal(await code(signUp(ea, `  ${name}  `)), 'OK');
  assert.equal(await nameOf(ea), name, '首尾空格被去掉');
  assert.equal(await code(signUp(eb, '   ')), 'INVALID_NAME');
  assert.equal(await code(signUp(eb, 'x'.repeat(41))), 'INVALID_NAME');

  // 2. 填错邮箱、没验证的账号不占用昵称：改对邮箱后马上能用同一个昵称注册
  const typoName = `错邮箱${tag}`;
  assert.equal(await code(signUp(eTypo, typoName)), 'OK');
  assert.equal(await code(signUp(eFixed, typoName)), 'OK', '未验证账号不占用昵称');

  // 3. 昵称被已验证账号占用后，别人注册同名（忽略大小写与首尾空格）被拒
  await verify(ea);
  assert.equal(await code(signUp(eb, ` ${name.toUpperCase()} `)), 'NAME_TAKEN');
  assert.equal(await code(signUp(eb, `乙${tag}`)), 'OK');

  // 4. 两人同时注册同名、都去验证：先验证的保留，后验证的自动加 #2（走 better-auth 的验证码流程）
  assert.equal(await code(signUp(eLate, `抢名${tag}`)), 'OK');
  await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())', [randomUUID(), `抢名${tag}`, `winner-${tag}@example.test`]);
  emails.push(`winner-${tag}@example.test`);
  const otp = await new Promise((resolve) => {
    const authWithMail = betterAuth(authOptions(config, pool, async ({ otp: sent }) => resolve(sent)));
    void authWithMail.api.sendVerificationOTP({ body: { email: eLate, type: 'email-verification' } });
  });
  assert.equal(await code(auth.api.verifyEmailOTP({ body: { email: eLate, otp } })), 'OK');
  assert.equal(await nameOf(eLate), `抢名${tag}#2`, '后验证的自动加后缀');

  // 5. 改名：需要登录；不能改成已验证账号的昵称；改成自己的（含空格/大小写）可以；改名后旧名释放
  await verify(eb);
  const session = async (email) => {
    const res = await auth.api.signInEmail({ body: { email, password: 'correct-horse-battery' }, asResponse: true });
    return new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') });
  };
  const second = await session(eb);
  assert.equal(await code(auth.api.updateUser({ body: { name }, headers: second })), 'NAME_TAKEN', '不能改成别人的昵称');
  assert.equal(await code(auth.api.updateUser({ body: { name: `丙${tag}` }, headers: second })), 'OK');
  assert.equal((await auth.api.getSession({ headers: second })).user.name, `丙${tag}`, '会话里的昵称随之更新');
  const first = await session(ea);
  assert.equal(await code(auth.api.updateUser({ body: { name: ` ${name} ` }, headers: first })), 'OK', '改成自己当前的昵称不算重名');
  await verify(eFixed);
  assert.equal(await code(signUp(`free-${tag}@example.test`, `乙${tag}`)), 'OK', '改名后旧昵称释放');
  emails.push(`free-${tag}@example.test`);

  // 6. 超过 24 小时仍未验证的账号会被清理（释放邮箱）
  assert.equal(await code(signUp(eStale, `过期${tag}`)), 'OK');
  await pool.query(`UPDATE "user" SET "createdAt"=now() - interval '25 hours' WHERE email=$1`, [eStale]);
  assert.ok(await deleteStaleUnverifiedUsers(pool) >= 1);
  assert.equal(await nameOf(eStale), undefined, '过期未验证账号已删除');
  assert.equal(await nameOf(eTypo), typoName, '24 小时内的未验证账号保留');
});
