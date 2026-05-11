import type { NextFunction, Request, Response } from 'express';
import type { ZodType, ZodTypeDef } from 'zod';

type Source = 'body' | 'query' | 'params';

// Accept any Zod schema where the output type may differ from the input
// (e.g. `.transform()`, `.default()`, `.coerce.number()`). Requires only that
// the schema produces an output of type T; the input can be anything.
export const validate =
  <T>(schema: ZodType<T, ZodTypeDef, unknown>, source: Source = 'body') =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(result.error);
      return;
    }
    // Replace the parsed payload back onto the request so downstream
    // handlers see the validated, coerced shape.
    (req as unknown as Record<Source, T>)[source] = result.data;
    next();
  };
