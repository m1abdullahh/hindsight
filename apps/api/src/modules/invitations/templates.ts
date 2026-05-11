import { config } from '../../config/env.js';

export interface InvitationTemplateData {
  inviterName: string;
  organizationName: string;
  role: 'admin' | 'member';
  token: string;
  expiresAt: Date;
}

const acceptUrl = (token: string): string =>
  `${config.WEB_ORIGIN}/accept-invite?token=${encodeURIComponent(token)}`;

export const subject = (data: InvitationTemplateData): string =>
  `${data.inviterName} invited you to ${data.organizationName} on Hindsight`;

export const render = (data: InvitationTemplateData): { html: string; text: string } => {
  const url = acceptUrl(data.token);
  const expires = data.expiresAt.toUTCString();
  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#222;max-width:560px;margin:24px auto;padding:0 16px;">
  <h2>You're invited to ${escapeHtml(data.organizationName)}</h2>
  <p>${escapeHtml(data.inviterName)} invited you to join <strong>${escapeHtml(data.organizationName)}</strong> as ${escapeHtml(data.role)}.</p>
  <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">Accept invitation</a></p>
  <p>Or open this URL in your browser:<br><span style="word-break:break-all;">${url}</span></p>
  <p style="color:#666;font-size:13px;">This link expires on ${expires}. If you didn't expect this email, ignore it.</p>
</body></html>`;
  const text = `${data.inviterName} invited you to join ${data.organizationName} as ${data.role}.

Accept the invitation: ${url}

This link expires on ${expires}. If you didn't expect this email, ignore it.`;
  return { html, text };
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
