import nodemailer, { type Transporter } from 'nodemailer';

import { config } from '../config/env.js';

import { AppError } from './errors.js';
import { logger } from './logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  tags?: Record<string, string>;
}

export interface MailProvider {
  send(message: MailMessage): Promise<{ providerMessageId: string }>;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const PER_ATTEMPT_TIMEOUT_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class ResendProvider implements MailProvider {
  constructor(private readonly apiKey: string) {}

  async send(message: MailMessage): Promise<{ providerMessageId: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PER_ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: config.MAIL_FROM,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          tags: message.tags
            ? Object.entries(message.tags).map(([name, value]) => ({ name, value }))
            : undefined,
        }),
        signal: ctrl.signal,
      });

      if (res.status >= 500) {
        const body = await res.text().catch(() => '');
        throw new RetryableMailError(`provider 5xx: ${res.status} ${body.slice(0, 200)}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new AppError('mail_send_failed', 502, `mail provider rejected: ${res.status}`, {
          body: body.slice(0, 500),
        });
      }
      const json = (await res.json()) as { id?: string };
      if (!json.id) {
        throw new AppError('mail_send_failed', 502, 'mail provider returned no id');
      }
      return { providerMessageId: json.id };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof RetryableMailError) throw err;
      // Network errors and aborts retry as if 5xx.
      throw new RetryableMailError((err as Error).message ?? 'network error');
    } finally {
      clearTimeout(timer);
    }
  }
}

class SmtpProvider implements MailProvider {
  constructor(private readonly transporter: Transporter) {}

  async send(message: MailMessage): Promise<{ providerMessageId: string }> {
    try {
      const info = await this.transporter.sendMail({
        from: config.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        // SMTP has no native tags concept — surface them as headers for
        // providers that key off X-* headers (Mailgun, SES) and for log lines.
        ...(message.tags
          ? {
              headers: Object.fromEntries(
                Object.entries(message.tags).map(([k, v]) => [`X-Tag-${k}`, v]),
              ),
            }
          : {}),
      });
      return { providerMessageId: info.messageId ?? 'smtp-unknown' };
    } catch (err) {
      // nodemailer connection / DNS / handshake errors are transient by nature.
      // Treat them as retryable; a 4xx auth failure surfaces as the same kind
      // of error and won't recover, but our 3-attempt cap keeps it bounded.
      throw new RetryableMailError((err as Error).message ?? 'smtp send error');
    }
  }
}

class RetryableMailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableMailError';
  }
}

/**
 * Test-only provider. Captures messages instead of sending. Active when
 * MAIL_PROVIDER_API_KEY === 'test-stub' (set by setup.ts in CI).
 *
 * Declared before initProvider() so the reference inside it is initialized.
 */
export const mailStub: MailProvider & { sent: MailMessage[]; reset: () => void } = {
  sent: [] as MailMessage[],
  async send(message) {
    this.sent.push(message);
    return { providerMessageId: `stub-${this.sent.length}` };
  },
  reset() {
    this.sent.length = 0;
  },
};

let provider: MailProvider | null = null;

const initProvider = (): void => {
  // Test stub takes priority — set explicitly by test setup.
  if (config.MAIL_PROVIDER_API_KEY === 'test-stub') {
    provider = mailStub;
    return;
  }

  // SMTP wins over Resend when both are configured. Lets you flip a single
  // env var to switch transports without touching code.
  if (config.SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      ...(config.SMTP_USER && config.SMTP_PASS
        ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } }
        : {}),
    });
    provider = new SmtpProvider(transporter);
    logger.info(
      { host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE },
      'mail transport: smtp',
    );
    return;
  }

  if (config.MAIL_PROVIDER_API_KEY) {
    provider = new ResendProvider(config.MAIL_PROVIDER_API_KEY);
    logger.info('mail transport: resend');
    return;
  }

  provider = null;
  logger.warn('mail transport: none configured (mail-using endpoints will 503)');
};

initProvider();

/** Test seam: replace the mail provider at runtime. Used by integration tests. */
export const __setMailProvider = (next: MailProvider | null): void => {
  provider = next;
};

export const sendMail = async (message: MailMessage): Promise<{ providerMessageId: string }> => {
  if (!provider) {
    throw new AppError('mail_unavailable', 503, 'mail provider not configured');
  }

  let attempt = 0;
  let lastErr: unknown;
  while (attempt < MAX_ATTEMPTS) {
    try {
      return await provider.send(message);
    } catch (err) {
      lastErr = err;
      if (err instanceof RetryableMailError) {
        attempt += 1;
        if (attempt >= MAX_ATTEMPTS) break;
        const delay = BASE_DELAY_MS * 3 ** (attempt - 1);
        logger.warn({ err, attempt, delay }, 'mail send retryable failure');
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }

  throw new AppError('mail_send_failed', 502, `mail send failed after ${MAX_ATTEMPTS} attempts`, {
    cause: (lastErr as Error)?.message ?? 'unknown',
  });
};
