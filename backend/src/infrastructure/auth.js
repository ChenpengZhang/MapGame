import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';

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
