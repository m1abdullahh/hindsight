import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { AppError, type ErrorCode } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

const toAppError = (err: unknown): AppError => {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError('invalid_input', 422, 'invalid input', err.flatten());
  }
  return new AppError('internal', 500, 'internal server error');
};

export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  // 4-arg signature is required by Express to register as an error handler,
  // even when `next` is unused.
  _next: NextFunction,
): void => {
  const appError = toAppError(err);
  const log = req.log ?? logger;

  if (appError.code === 'internal') {
    log.error({ err }, 'unhandled error');
  } else {
    log.warn({ code: appError.code, status: appError.status }, appError.message);
  }

  const body: ErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
    },
  };

  if (
    appError.code === 'too_many_attempts' &&
    appError.details &&
    typeof appError.details === 'object' &&
    'retryAfter' in appError.details &&
    typeof (appError.details as { retryAfter: unknown }).retryAfter === 'number'
  ) {
    res.setHeader('Retry-After', String((appError.details as { retryAfter: number }).retryAfter));
  }

  res.status(appError.status).json(body);
};
