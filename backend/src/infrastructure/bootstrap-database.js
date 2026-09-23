import pg from 'pg';
import { migrate } from './migrate.js';
import { authOptions } from './auth.js';

export function quoteIdentifier(value) {
  if (!value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 63) {
    throw new Error('Database and role names must contain 1–63 UTF-8 bytes and no NUL');
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export async function ensureDatabase(config) {
  const target = new pg.Client({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  const params = target.connectionParameters;

  // CREATE DATABASE cannot bind identifiers as SQL values. Validate and quote them explicitly.
  const databaseIdentifier = quoteIdentifier(params.database);
  const ownerIdentifier = quoteIdentifier(params.user);

  try {
    await target.connect();
    await target.query('SELECT 1');
    return { created: false };
  } catch (error) {
    // Only "database does not exist" allows creation. Bad credentials/network errors never do.
    if (error.code !== '3D000') {
      throw new Error(
        `Cannot connect to PostgreSQL (${error.code ?? 'connection error'}); check DATABASE_URL and server availability`,
      );
    }
  } finally {
    await target.end().catch(() => {});
  }

  const admin = config.DATABASE_ADMIN_URL
    ? new pg.Client({ connectionString: config.DATABASE_ADMIN_URL, connectionTimeoutMillis: 5000 })
    : new pg.Client({
        host: params.host,
        port: params.port,
        user: params.user,
        password: params.password,
        ssl: params.ssl,
        database: 'postgres',
        connectionTimeoutMillis: 5000,
      });

  if (
    admin.connectionParameters.host !== params.host ||
    admin.connectionParameters.port !== params.port
  ) {
    throw new Error('DATABASE_ADMIN_URL must point to the same PostgreSQL host and port as DATABASE_URL');
  }

  try {
    await admin.connect();
    // Session lock: CREATE DATABASE is not allowed inside a transaction.
    await admin.query('SELECT pg_advisory_lock(73194121, hashtext($1))', [params.database]);

    const exists = async () =>
      (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [params.database])).rowCount > 0;

    if (await exists()) return { created: false };

    try {
      await admin.query(`CREATE DATABASE ${databaseIdentifier} OWNER ${ownerIdentifier}`);
      return { created: true };
    } catch (error) {
      // Also tolerate another provisioning tool racing with this application.
      if (['42P04', '23505'].includes(error.code) && (await exists())) return { created: false };
      throw error;
    }
  } catch (error) {
    if (error.code === '42501') {
      throw new Error(
        'Database creation requires CREATEDB and permission to assign the DATABASE_URL role as owner; configure DATABASE_ADMIN_URL or grant those permissions',
      );
    }
    throw new Error(
      `Cannot create PostgreSQL database (${error.code ?? 'connection error'}); check DATABASE_ADMIN_URL and the existing login role`,
    );
  } finally {
    // Disconnect releases the session lock, including when creation fails.
    await admin.end().catch(() => {});
  }
}

export async function bootstrapDatabase(config, sendMail) {
  await ensureDatabase(config);
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
  });
  pool.on('error', () => console.error('Database pool connection error'));
  try {
    await migrate(pool, authOptions(config, pool, sendMail));
    return pool;
  } catch (error) {
    await pool.end();
    throw new Error(
      `Database migration failed (${error.code ?? 'schema or migration mismatch'}); API startup stopped. Check database DDL permissions and migration files`,
    );
  }
}
