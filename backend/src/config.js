import { z } from 'zod';

export function configFromEnv(env = process.env) {
  const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.literal('127.0.0.1').default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DATABASE_URL: z.string().url(),
    // 管理员连接只在目标库不存在时用于建库；常规运行只用上面的 DATABASE_URL。
    DATABASE_ADMIN_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().url().optional(),
    ),
    BETTER_AUTH_SECRET: z.string().min(32),
    PUBLIC_ORIGIN: z.string().url(),
    MAIL_TRANSPORT: z.enum(['preview', 'smtp', 'ses']).default('preview'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().default(465),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    // 腾讯云邮件推送（SES）API 发信。个人实名认证账号被禁止用 SMTP，只能走 API。
    TENCENT_SECRET_ID: z.string().optional(),
    TENCENT_SECRET_KEY: z.string().optional(),
    TENCENT_SES_REGION: z.string().optional(),
    TENCENT_SES_TEMPLATE_ID: z.preprocess(
      (value) => (value === '' || value === undefined ? undefined : value),
      z.coerce.number().int().positive().optional(),
    ),
    MAIL_FROM: z.string().optional(),
  });

  const result = schema.safeParse(env);
  // Never include parsed environment values (especially connection URLs) in errors.
  if (!result.success) {
    throw new Error(
      `Invalid configuration keys: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }

  const config = result.data;
  if (!['postgres:', 'postgresql:'].includes(new URL(config.DATABASE_URL).protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL');
  }
  if (
    config.DATABASE_ADMIN_URL &&
    !['postgres:', 'postgresql:'].includes(new URL(config.DATABASE_ADMIN_URL).protocol)
  ) {
    throw new Error('DATABASE_ADMIN_URL must use PostgreSQL');
  }
  if (new URL(config.PUBLIC_ORIGIN).origin !== config.PUBLIC_ORIGIN) {
    throw new Error('PUBLIC_ORIGIN must be an origin without path/trailing slash');
  }
  if (
    config.NODE_ENV === 'production' &&
    (!config.PUBLIC_ORIGIN.startsWith('https://') ||
      !['smtp', 'ses'].includes(config.MAIL_TRANSPORT) ||
      config.BETTER_AUTH_SECRET.includes('replace-'))
  ) {
    throw new Error('Production requires HTTPS, a real mail transport (smtp/ses) and a random authentication secret');
  }
  if (
    config.MAIL_TRANSPORT === 'smtp' &&
    ![config.SMTP_HOST, config.SMTP_USER, config.SMTP_PASS, config.MAIL_FROM].every(Boolean)
  ) {
    throw new Error('SMTP configuration is incomplete');
  }
  if (
    config.MAIL_TRANSPORT === 'ses' &&
    ![
      config.TENCENT_SECRET_ID,
      config.TENCENT_SECRET_KEY,
      config.TENCENT_SES_REGION,
      config.TENCENT_SES_TEMPLATE_ID,
      config.MAIL_FROM,
    ].every(Boolean)
  ) {
    throw new Error(
      'Tencent SES configuration is incomplete (secret ID, secret key, region, template ID and MAIL_FROM are required)',
    );
  }
  return config;
}
