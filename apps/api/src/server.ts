import { buildApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';

const app = buildApp();

const server = app.listen(config.PORT, '0.0.0.0', () => {
  logger.info({ port: config.PORT }, 'api listening');
});

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  server.close();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
