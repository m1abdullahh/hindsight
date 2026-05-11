import { Router } from 'express';

export const healthRouter: Router = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ ok: true, version: process.env['APP_VERSION'] ?? 'dev' });
});
