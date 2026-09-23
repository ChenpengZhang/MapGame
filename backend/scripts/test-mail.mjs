// 发信自测：直接调用生产代码里的 createMail()，用当前 .env 的配置真发一封测试邮件。
//
// 用法（在 backend/ 目录下）：
//   node --env-file=.env scripts/test-mail.mjs 收件人@example.com
//
// 它走的是和注册/找回密码完全相同的代码路径，所以通过就代表线上发信没问题。
// preview 模式下不会真发，只会在 backend/.mail-preview/ 写一个 json 文件。

import { configFromEnv } from '../src/config.js';
import { createMail } from '../src/infrastructure/mail.js';

const to = process.argv[2];
if (!to) {
  console.error('用法：node --env-file=.env scripts/test-mail.mjs 收件人邮箱');
  process.exit(1);
}

const config = configFromEnv();
console.log(`发信方式：${config.MAIL_TRANSPORT}`);
console.log(`发件人：${config.MAIL_FROM ?? '(未配置)'}`);
if (config.MAIL_TRANSPORT === 'ses') {
  console.log(`地域：${config.TENCENT_SES_REGION}，模板 ID：${config.TENCENT_SES_TEMPLATE_ID}`);
}

// 用一句随机验证码，模拟真实的注册/找回密码邮件。
const otp = String(Math.floor(100000 + Math.random() * 900000));
const sendMail = createMail(config);

try {
  await sendMail({ to, otp, kind: 'email-verification' });
} catch (error) {
  console.error('❌ 发信失败：', error.message);
  if (error.code) console.error('   错误码：', error.code);
  if (config.MAIL_TRANSPORT === 'ses') {
    console.error('   常见原因：SecretId/SecretKey 不对、地域(region)与发信域名所在地域不一致、');
    console.error('             模板 ID 不存在或未审核通过、MAIL_FROM 不属于已验证的发信域名。');
  } else if (config.MAIL_TRANSPORT === 'smtp') {
    console.error('   常见原因：主机/端口不对、密码填成了登录密码、腾讯云个人认证账号被禁止 SMTP 发信。');
  }
  process.exit(1);
}

console.log(`✅ 已提交发送（验证码 ${otp}）`);
if (config.MAIL_TRANSPORT === 'preview') {
  console.log('   preview 模式不会真发，去看 backend/.mail-preview/ 里最新的 json。');
} else {
  console.log('   去收件箱确认（不在收件箱就翻垃圾箱，新发信域名前几封容易被判定为垃圾邮件）。');
}
