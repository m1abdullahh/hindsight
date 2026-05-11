import './types/express-augment.js';

import compression from 'compression';
import cors from 'cors';
import express, { type Express, Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { config } from './config/env.js';
import { AppError } from './lib/errors.js';
import { ulid } from './lib/id.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { rateLimit } from './middleware/rate-limit.js';
import { requestContext } from './middleware/request-context.js';
import { healthRouter } from './modules/health/routes.js';
import { v1Routers } from './modules/index.js';

export function buildApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  // Allow the configured web origin plus Tauri's webview origins.
  // Dev mode (`tauri dev`):  http://localhost:1420 (Vite dev server)
  // Prod bundle on Win/Linux: http(s)://tauri.localhost
  // Prod bundle on macOS:     tauri://localhost
  const allowedOrigins = new Set<string>([
    config.WEB_ORIGIN,
    'http://localhost:1420',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'tauri://localhost',
  ]);
  app.use(
    cors({
      origin: (origin, cb) => {
        // No origin header (curl, server-to-server, native fetch) → allow.
        if (!origin) return cb(null, true);
        if (allowedOrigins.has(origin)) return cb(null, true);
        return cb(new Error(`origin ${origin} not allowed by CORS`));
      },
      credentials: false,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '256kb' }));
  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as { id?: string }).id ?? ulid(),
    }),
  );
  // Health check is mounted before the rate limiter so uptime checks
  // and smoke tests don't require Redis to be reachable.
  app.use('/healthz', healthRouter);

  app.use(rateLimit);

  const v1 = Router();
  for (const r of v1Routers) v1.use(r);
  app.use('/api/v1', v1);

  app.use((_req, _res, next) => {
    next(new AppError('not_found', 404, 'route not found'));
  });

  app.use(errorHandler);

  return app;
}
