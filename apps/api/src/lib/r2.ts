import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { config } from '../config/env.js';

import { AppError } from './errors.js';
import { logger } from './logger.js';

const PUT_TTL_S = 5 * 60;
const THUMB_TTL_S = 10 * 60;
const FULL_TTL_S = 5 * 60;

export interface PresignedPut {
  putUrl: string;
  key: string;
  expiresAt: Date;
}

export interface PresignedGet {
  url: string;
  expiresAt: Date;
}

export interface HeadResult {
  size: number;
  contentType: string | null;
}

export interface R2Provider {
  presignPut(key: string, contentType: string, maxSizeBytes: number): Promise<PresignedPut>;
  presignGetThumbnail(key: string): Promise<PresignedGet>;
  presignGetFull(key: string): Promise<PresignedGet>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<HeadResult | null>;
  getObjectBytes(key: string): Promise<Buffer>;
  putObjectBytes(key: string, bytes: Buffer, contentType: string): Promise<void>;
}

class S3R2Provider implements R2Provider {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async presignPut(key: string, contentType: string, _maxSizeBytes: number): Promise<PresignedPut> {
    // Deliberately do NOT pin Content-Length into the presigned URL. Doing so
    // would force the client to declare an exact byte count before upload,
    // and we'd have to expand presign request schema + change the desktop
    // protocol to round-trip the post-encode size. Instead, the size +
    // content-type cap is enforced server-side at /confirm: the screenshot
    // service HEADs the uploaded object, rejects on overflow or MIME
    // mismatch, and deletes the offending object before throwing. A
    // compromised device token can therefore upload garbage briefly, but
    // nothing the DB ever blesses survives past the next confirm call.
    //
    // If we ever want hard upstream rejection (e.g. to cut R2 ingress cost
    // on a misbehaving device), switch to createPresignedPost with a
    // content-length-range policy. The desktop would then POST form-data
    // instead of raw-body PUT.
    void _maxSizeBytes;
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const putUrl = await getSignedUrl(this.client, cmd, { expiresIn: PUT_TTL_S });
    return { putUrl, key, expiresAt: new Date(Date.now() + PUT_TTL_S * 1000) };
  }

  async presignGetThumbnail(key: string): Promise<PresignedGet> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: THUMB_TTL_S });
    return { url, expiresAt: new Date(Date.now() + THUMB_TTL_S * 1000) };
  }

  async presignGetFull(key: string): Promise<PresignedGet> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: FULL_TTL_S });
    return { url, expiresAt: new Date(Date.now() + FULL_TTL_S * 1000) };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async headObject(key: string): Promise<HeadResult | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: out.ContentLength ?? 0, contentType: out.ContentType ?? null };
    } catch {
      return null;
    }
  }

  async getObjectBytes(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) throw new Error(`empty body for ${key}`);
    const chunks: Buffer[] = [];
    for await (const chunk of out.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async putObjectBytes(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }
}

let provider: R2Provider | null = null;
let initialized = false;

const init = (): R2Provider | null => {
  initialized = true;
  const acct = config.R2_ACCOUNT_ID;
  const key = config.R2_ACCESS_KEY_ID;
  const secret = config.R2_SECRET_ACCESS_KEY;
  const bucket = config.R2_BUCKET;
  if (!acct || !key || !secret || !bucket) {
    logger.warn('R2 not configured; ingestion endpoints will return 503');
    return null;
  }
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${acct}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: key, secretAccessKey: secret },
    // R2 does not implement the AWS-only CRC32 default-checksum behavior the
    // newer SDK versions inject. Setting both flags to WHEN_REQUIRED matches
    // R2's actual capabilities — without this, presigned PUTs fail with
    // SignatureDoesNotMatch on the second request.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  logger.info({ bucket }, 'R2 client initialized');
  return new S3R2Provider(client, bucket);
};

const requireProvider = (): R2Provider => {
  if (!initialized) provider = init();
  if (!provider) {
    throw new AppError('r2_unavailable', 503, 'object storage not configured');
  }
  return provider;
};

/** Test seam — replace the provider at runtime. */
export const __setR2Provider = (next: R2Provider | null): void => {
  provider = next;
  initialized = true;
};

/** Reset to env-driven init on next call. Useful in tests. */
export const __resetR2Provider = (): void => {
  provider = null;
  initialized = false;
};

// Public API — thin wrappers so call sites never see the provider.
export const presignPut: R2Provider['presignPut'] = (key, contentType, maxSizeBytes) =>
  requireProvider().presignPut(key, contentType, maxSizeBytes);

export const presignGetThumbnail: R2Provider['presignGetThumbnail'] = (key) =>
  requireProvider().presignGetThumbnail(key);

export const presignGetFull: R2Provider['presignGetFull'] = (key) =>
  requireProvider().presignGetFull(key);

export const deleteObject: R2Provider['deleteObject'] = (key) =>
  requireProvider().deleteObject(key);

export const headObject: R2Provider['headObject'] = (key) => requireProvider().headObject(key);

export const getObjectBytes: R2Provider['getObjectBytes'] = (key) =>
  requireProvider().getObjectBytes(key);

export const putObjectBytes: R2Provider['putObjectBytes'] = (key, bytes, contentType) =>
  requireProvider().putObjectBytes(key, bytes, contentType);
