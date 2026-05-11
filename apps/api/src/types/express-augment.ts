// Express request augmentation. Import once from app.ts so TypeScript
// guarantees the augmentation is in the program graph.
//
// We use the global `Express` namespace (the canonical pattern @types/express
// itself documents) rather than `declare module 'express-serve-static-core'`
// because the latter doesn't resolve under NodeNext module resolution.
import 'express';
import type { Device, Membership, Project, Token, User } from '@prisma/client';
import type { Logger } from 'pino';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- canonical Express augmentation pattern
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      caller?: {
        user: User;
        token: Token;
        device?: Device;
        membership?: Membership;
        project?: Project;
      };
    }
  }
}

export {};
