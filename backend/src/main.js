import { bootstrapDatabase } from './infrastructure/bootstrap-database.js';
import { configFromEnv } from './config.js';
import { createMail } from './infrastructure/mail.js';
import { createAuth } from './infrastructure/auth.js';
import { Repository } from './infrastructure/repository.js';
import { Transit } from './infrastructure/transit.js';
import { GameService } from './application/game-service.js';
import { createApp } from './http/app.js';

const config = configFromEnv();
const sendMail = createMail(config);
const pool = await bootstrapDatabase(config,sendMail);
const repository = new Repository(pool);
const auth = createAuth(config,pool,sendMail);
const game = new GameService(repository,new Transit());
await repository.now();
const server = createApp({ auth,game,repository,config }).listen(config.PORT,config.HOST, () => {
  console.log(`MapGame API listening on ${config.HOST}:${config.PORT}/mapgame/api`);
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => {
  server.close(async () => { await pool.end(); process.exit(0); });
});
