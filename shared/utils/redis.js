import Redis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { createLogger } from './logger.js';

const logger = createLogger('redis');

const redisUrl = process.env.REDIS_URL || 
  (process.env.REDIS_HOST ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}` : 'redis://localhost:6379');

export const redis = new Redis(redisUrl, {
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

export function createWorker(queueName, processor, options = {}) {
  return new Worker(queueName, processor, {
    connection: redis.options,
    concurrency: options.concurrency || 1,
    ...options,
  });
}

export async function scheduleJob(queue, name, data, cron) {
  logger.info(`Scheduling ${name} with pattern ${cron}`);
  await queue.upsertJobScheduler(name, { cron }, {
    name, data, opts: { priority: 1 }
  });
}

export default redis;
