export interface KeyParts {
  orgId: string;
  userId: string;
  capturedAt: Date;
  screenshotId: string;
}

const datePath = (d: Date): string => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
};

export const extFromContentType = (ct: string): string => {
  if (ct === 'image/png') return 'png';
  if (ct === 'image/webp') return 'webp';
  return 'jpg';
};

export const mimeFromKey = (key: string): string => {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
};

export const originalKey = (p: KeyParts, contentType: string): string =>
  `orgs/${p.orgId}/users/${p.userId}/${datePath(p.capturedAt)}/${p.screenshotId}.${extFromContentType(contentType)}`;

export const thumbnailKey = (p: KeyParts): string =>
  `orgs/${p.orgId}/users/${p.userId}/${datePath(p.capturedAt)}/${p.screenshotId}-thumb.webp`;

export const blurredKey = (p: KeyParts, contentType: string): string =>
  `orgs/${p.orgId}/users/${p.userId}/${datePath(p.capturedAt)}/${p.screenshotId}-blur.${extFromContentType(contentType)}`;
