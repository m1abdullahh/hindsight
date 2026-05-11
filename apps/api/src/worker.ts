import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { registerProcessScreenshotWorker } from './workers/process-screenshot.js';

const workers = [registerProcessScreenshotWorker()];

logger.info({ count: workers.length }, 'workers running');

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  logger.info({ signal }, 'shutting down workers');
  await Promise.all(workers.map((w) => w.close()));
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
