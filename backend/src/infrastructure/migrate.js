import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getMigrations } from 'better-auth/db/migration';

export async function migrate(pool, options) {
  const client = await pool.connect();
  try {
    // 迁移锁：多实例并发启动时只允许一个执行迁移。
    await client.query('SELECT pg_advisory_lock(73194120)');

    // Authentication schema belongs to the locked Better Auth version/configuration.
    const authMigration = await getMigrations(options);
    await authMigration.runMigrations();

    await client.query(`CREATE TABLE IF NOT EXISTS mapgame_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);

    const directory = new URL('../../migrations/', import.meta.url);
    const files = (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort();

    for (const name of files) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = (
        await client.query('SELECT checksum FROM mapgame_migrations WHERE name=$1', [name])
      ).rows[0];

      // 已应用的迁移文件内容若被改动则拒绝启动，防止悄悄篡改历史迁移。
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO mapgame_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(73194120)');
    client.release();
  }
}
