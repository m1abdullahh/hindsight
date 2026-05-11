import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PUBLIC_API_URL: z.string().url(),
  WEB_ORIGIN: z.string().url(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),

  // Mail. Two transport options — pick by setting one set of vars:
  //   • Resend (HTTP API): set MAIL_PROVIDER_API_KEY.
  //   • SMTP (any provider, incl. Mailtrap/Gmail/Mailgun): set SMTP_HOST.
  // SMTP wins if both are set. The from-address is shared.
  MAIL_FROM: z.string().default('Hindsight <noreply@hindsight.app>'),
  MAIL_PROVIDER_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // 465 = implicit TLS; 587 = STARTTLS (default). Set "true" to force implicit TLS.
  SMTP_SECURE: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .default(false),
});

export const config = Env.parse(process.env);
export type Config = z.infer<typeof Env>;
