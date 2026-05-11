import { config } from '../../config/env.js';

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// ── Email verification ──────────────────────────────────────────────────────

export interface EmailVerifyData {
  name: string;
  token: string;
  expiresAt: Date;
}

const verifyUrl = (token: string): string =>
  `${config.WEB_ORIGIN}/verify-email?token=${encodeURIComponent(token)}`;

export const emailVerifySubject = (_data: EmailVerifyData): string => 'Verify your email address';

export const emailVerifyRender = (data: EmailVerifyData): { html: string; text: string } => {
  const url = verifyUrl(data.token);
  const expires = data.expiresAt.toUTCString();
  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#222;max-width:560px;margin:24px auto;padding:0 16px;">
  <h2>Hi ${escapeHtml(data.name)}, please verify your email</h2>
  <p>Click the button to confirm this is your address.</p>
  <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Verify email</a></p>
  <p>Or open this URL:<br><span style="word-break:break-all;">${url}</span></p>
  <p style="color:#666;font-size:13px;">This link expires on ${expires}.</p>
</body></html>`;
  const text = `Hi ${data.name},

Verify your email by opening this URL:
${url}

This link expires on ${expires}.`;
  return { html, text };
};

// ── Password reset ──────────────────────────────────────────────────────────

export interface PasswordResetData {
  name: string;
  token: string;
  expiresAt: Date;
}

const resetUrl = (token: string): string =>
  `${config.WEB_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;

export const passwordResetSubject = (_data: PasswordResetData): string => 'Reset your password';

export const passwordResetRender = (data: PasswordResetData): { html: string; text: string } => {
  const url = resetUrl(data.token);
  const expires = data.expiresAt.toUTCString();
  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#222;max-width:560px;margin:24px auto;padding:0 16px;">
  <h2>Hi ${escapeHtml(data.name)}, reset your password</h2>
  <p>Someone (hopefully you) asked to reset the password on your Hindsight account. Click below to choose a new one.</p>
  <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Reset password</a></p>
  <p>Or open this URL:<br><span style="word-break:break-all;">${url}</span></p>
  <p style="color:#666;font-size:13px;">This link expires on ${expires}. If you didn't request this, ignore this email — your password stays unchanged.</p>
</body></html>`;
  const text = `Hi ${data.name},

Reset your password by opening this URL:
${url}

This link expires on ${expires}. If you didn't request this, ignore this email.`;
  return { html, text };
};
