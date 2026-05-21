import pg from 'pg';
const { Pool } = pg;
import { createLogger } from './logger.js';

const logger = createLogger('db');

const dbUrl = process.env.DB_URL || 
  `postgresql://${process.env.DB_USER || 'affiliate_user'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'affiliate_platform'}`;

const pool = new Pool({
  connectionString: dbUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => logger.debug('New client connected'));
pool.on('error', (err) => logger.error('Unexpected DB error', err));

export async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  logger.debug('Executed query', { duration, rowCount: result.rowCount });
  return result;
}

export async function transaction(queries) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const { sql, params } of queries) {
      results.push(await client.query(sql, params));
    }
    await client.query('COMMIT');
    return results;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default pool;