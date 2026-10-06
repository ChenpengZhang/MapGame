import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins';

// 昵称：在“已验证邮箱的账号”之间全局唯一（忽略大小写与首尾空格；数据库有同样口径的部分唯一索引兜底）。
// 未验证的账号（例如邮箱填错、一直没验证）不占用昵称：谁先完成邮箱验证谁得到这个昵称。
export const NAME_MAX_LENGTH = 40;
export function normalizeName(name) {
  return String(name ?? '').trim();
}
function invalidName(name) {
  return !name || [...name].length > NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(name);
}
async function nameTaken(pool, name, exceptUserId = null) {
  const taken = await pool.query(
    'SELECT 1 FROM "user" WHERE "emailVerified" AND lower(btrim(name))=lower($1) AND id IS DISTINCT FROM $2 LIMIT 1',
    [name, exceptUserId],
  );
  return taken.rowCount > 0;
}
async function checkName(pool, rawName, exceptUserId = null) {
  const name = normalizeName(rawName);
  if (invalidName(name)) throw new APIError('BAD_REQUEST', { code: 'INVALID_NAME', message: `昵称需为 1–${NAME_MAX_LENGTH} 个字符` });
  if (await nameTaken(pool, name, exceptUserId)) throw new APIError('BAD_REQUEST', { code: 'NAME_TAKEN', message: '这个昵称已被使用' });
  return name;
}
/**
 * 邮箱刚通过验证：若昵称在此期间已被另一个已验证账号用掉（极少见：两人同时注册同名），
 * 自动改成“昵称#2”“昵称#3”…，之后可在「修改昵称」里改。返回需要写入的新昵称，无冲突时返回 null。
 */
async function nameOnVerification(pool, email) {
  const user = (await pool.query('SELECT id,name FROM "user" WHERE lower(email)=lower($1)', [email])).rows[0];
  if (!user) return null;
  const base = normalizeName(user.name);
  if (!(await nameTaken(pool, base, user.id))) return null;
  for (let n = 2; ; n++) {
    const candidate = `${base}#${n}`;
    if (!(await nameTaken(pool, candidate, user.id))) return candidate;
  }
}

/** 清理超过 24 小时仍未验证邮箱的账号：释放被占用的邮箱（例如别人填错成了你的邮箱）。返回删除数量 */
export async function deleteStaleUnverifiedUsers(pool, olderThanHours = 24) {
  const result = await pool.query(
    `DELETE FROM "user" WHERE NOT "emailVerified" AND "createdAt" < now() - make_interval(hours => $1)`,
    [olderThanHours],
  );
  return result.rowCount;
}

export function authOptions(config, pool, sendMail) {
  return {
    appName: 'MapGame',
    database: pool,
    baseURL: config.PUBLIC_ORIGIN,
    basePath: '/mapgame/api/auth',
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.PUBLIC_ORIGIN],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 1800,
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      expiresIn: 600,
    },
    plugins: [
      emailOTP({
        overrideDefaultEmailVerification: true,
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        sendVerificationOTP: async ({ email, otp, type }) => sendMail({ to: email, otp, kind: type }),
      }),
    ],
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    databaseHooks: {
      user: {
        // 注册：校验并去掉首尾空格后再入库
        create: { before: async (user) => ({ data: { ...user, name: await checkName(pool, user.name) } }) },
        update: {
          before: async (data, ctx) => {
            // 修改昵称（/auth/update-user）
            if (data.name !== undefined) {
              return { data: { ...data, name: await checkName(pool, data.name, ctx?.context?.session?.user?.id ?? null) } };
            }
            // 邮箱通过验证（注册验证、验证码登录、找回密码等各条路径都带着邮箱）：昵称撞了就自动加后缀
            const email = data.email ?? ctx?.body?.email;
            if (data.emailVerified === true && email) {
              const renamed = await nameOnVerification(pool, email);
              if (renamed) return { data: { ...data, name: renamed } };
            }
            return { data };
          },
        },
      },
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    advanced: {
      cookiePrefix: 'mapgame',
      useSecureCookies: config.NODE_ENV === 'production',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/mapgame' },
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
    },
  };
}

export const createAuth = (config, pool, sendMail) => betterAuth(authOptions(config, pool, sendMail));
