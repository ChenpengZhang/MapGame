import { bootstrapDatabase } from './infrastructure/bootstrap-database.js';
import { configFromEnv } from './config.js';
import { createMail } from './infrastructure/mail.js';
import { createAuth, deleteStaleUnverifiedUsers } from './infrastructure/auth.js';
import { Repository } from './infrastructure/repository.js';
import { Transit } from './infrastructure/transit.js';
import { GameService } from './application/game-service.js';
import { createApp } from './http/app.js';

// 组合根：按依赖顺序装配——先建库迁移，再建仓储/认证/服务，最后监听。
// 顺序不能乱：bootstrapDatabase 成功返回才说明迁移完成，之后才安全对外服务。
const config = configFromEnv();
const sendMail = createMail(config);
const pool = await bootstrapDatabase(config, sendMail);

const repository = new Repository(pool);
const auth = createAuth(config, pool, sendMail);
const game = new GameService(repository, new Transit());
await repository.now();

const server = createApp({ auth, game, repository, config }).listen(config.PORT, config.HOST, () => {
  console.log(`MapGame API listening on ${config.HOST}:${config.PORT}/mapgame/api`);
});
// 每小时清理超过 24 小时仍未验证邮箱的账号（释放被占用的邮箱；昵称本来就只在已验证账号间唯一）
const cleanStaleAccounts = () => deleteStaleUnverifiedUsers(pool)
  .then((n) => { if (n) console.log(`已清理 ${n} 个超过 24 小时未验证邮箱的账号`); })
  .catch((error) => console.error('清理未验证账号失败', error));
void cleanStaleAccounts();
setInterval(cleanStaleAccounts, 60 * 60 * 1000).unref();
server.requestTimeout = 15000;
server.headersTimeout = 10000;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
