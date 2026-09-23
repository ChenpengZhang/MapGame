import nodemailer from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import tencentcloud from 'tencentcloud-sdk-nodejs-ses';

const SesClient = tencentcloud.ses.v20201002.Client;

/**
 * 发信适配器：三种传输方式共用同一个 sendMail({ to, url, otp, kind }) 签名。
 *
 *   preview —— 开发用：把邮件写成 backend/.mail-preview/*.json，不真发（默认）
 *   smtp    —— 标准 SMTP（nodemailer）。腾讯云个人实名认证账号会被拒绝发信
 *   ses     —— 腾讯云邮件推送 API。个人认证账号只能走这条
 *
 * 注意 ses 模式必须先在控制台「模板管理」建好模板：腾讯云 API 发信要求用模板，
 * 新账号不支持 SendEmail 的 Simple 字段。模板里用 {{action}} 和 {{code}} 取变量。
 */
export function createMail(config) {
  const transport =
    config.MAIL_TRANSPORT === 'smtp'
      ? nodemailer.createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: config.SMTP_PORT === 465,
          requireTLS: config.SMTP_PORT !== 465,
          auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
          connectionTimeout: 10000,
          socketTimeout: 15000,
        })
      : null;

  const ses =
    config.MAIL_TRANSPORT === 'ses'
      ? new SesClient({
          credential: { secretId: config.TENCENT_SECRET_ID, secretKey: config.TENCENT_SECRET_KEY },
          region: config.TENCENT_SES_REGION,
          profile: { httpProfile: { endpoint: 'ses.tencentcloudapi.com', reqTimeout: 15 } },
        })
      : null;

  return async ({ to, url, otp, kind }) => {
    const isResetCode = kind === 'forget-password';
    const isVerificationCode = kind === 'email-verification';
    const action = isResetCode ? '重置密码' : '邮箱验证';

    const subject = isResetCode
      ? 'MapGame：重置密码验证码'
      : isVerificationCode
        ? 'MapGame：邮箱验证码'
        : 'MapGame：账户邮件';
    const text = otp
      ? `${action}验证码：${otp}\n验证码 10 分钟内有效。如果不是你发起的请求，请忽略此邮件。`
      : `请打开以下链接：\n${url}\n如果不是你发起的请求，请忽略此邮件。`;

    if (ses) {
      // 正文由控制台模板决定，这里只传变量；Subject 走请求字段，不依赖模板。
      await ses.SendEmail({
        FromEmailAddress: config.MAIL_FROM,
        Destination: [to],
        Subject: subject,
        TriggerType: 1, // 触发类：验证码等即时邮件，走即时通道
        Template: {
          TemplateID: config.TENCENT_SES_TEMPLATE_ID,
          TemplateData: JSON.stringify({ action, code: otp ?? '', url: url ?? '' }),
        },
      });
      return;
    }

    const message = { from: config.MAIL_FROM, to, subject, text };

    if (transport) {
      await transport.sendMail(message);
      return;
    }

    const directory = new URL('../../.mail-preview/', import.meta.url);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      new URL(`${randomUUID()}.json`, directory),
      JSON.stringify(message, null, 2),
      { mode: 0o600 },
    );
  };
}
