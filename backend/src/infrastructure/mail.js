import nodemailer from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export function createMail(config) {
  const transport = config.MAIL_TRANSPORT === 'smtp' ? nodemailer.createTransport({
    host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_PORT === 465,
    requireTLS: config.SMTP_PORT !== 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    connectionTimeout: 10000, socketTimeout: 15000,
  }) : null;
  return async ({ to, url, otp, kind }) => {
    const isResetCode=kind === 'forget-password';
    const isVerificationCode=kind === 'email-verification';
    const message = { from: config.MAIL_FROM, to,
      subject: isResetCode ? 'MapGame：重置密码验证码' : isVerificationCode ? 'MapGame：邮箱验证码' : 'MapGame：账户邮件',
      text: otp
        ? `${isResetCode ? '重置密码' : '邮箱验证'}验证码：${otp}\n验证码 10 分钟内有效。如果不是你发起的请求，请忽略此邮件。`
        : `请打开以下链接：\n${url}\n如果不是你发起的请求，请忽略此邮件。`,
    };
    if (transport) { await transport.sendMail(message); return; }
    const directory = new URL('../../.mail-preview/', import.meta.url);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(new URL(`${randomUUID()}.json`,directory),JSON.stringify(message,null,2),{ mode: 0o600 });
  };
}
