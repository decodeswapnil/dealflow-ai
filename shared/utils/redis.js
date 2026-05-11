import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { createLogger } from './logger.js';

const logger = createLogger('redis');

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // BullMQ requires null for proper retry handling
  enableReadyCheck: false,    // BullMQ requires false to avoid blocking commands
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error('Redis error', err));

export function createQueue(name) {
  return new Queue(name, {
    connection: redis.options,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 50,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    },
  });
}

export async function scheduleJob(queue, name, data, cron) {
  logger.info(`Scheduling ${name} with pattern ${cron}`);
  await queue.upsertJobScheduler(name, { cron }, {
    name, data, opts: { priority: 1 }
  });
}

export default redis;