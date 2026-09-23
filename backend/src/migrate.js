import { configFromEnv } from './config.js';
import { createMail } from './infrastructure/mail.js';
import { bootstrapDatabase } from './infrastructure/bootstrap-database.js';

const config = configFromEnv();
const pool = await bootstrapDatabase(config, createMail(config));
await pool.end();
console.log('Database ready; migrations complete');
