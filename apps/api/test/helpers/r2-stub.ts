import { __setR2Provider, type R2Provider } from '../../src/lib/r2.js';

interface StubObject {
  bytes: Buffer;
  contentType: string;
}

export interface R2Stub {
  objects: Map<string, StubObject>;
  putUrls: { key: string; contentType: string; expiresAt: Date }[];
  getUrls: { key: string; expiresAt: Date }[];
  put(key: string, bytes: Buffer, contentType: string): void;
  reset(): void;
}

const PUT_TTL_S = 5 * 60;
const THUMB_TTL_S = 10 * 60;
const FULL_TTL_S = 5 * 60;

const objects = new Map<string, StubObject>();
const putUrls: { key: string; contentType: string; expiresAt: Date }[] = [];
const getUrls: { key: string; expiresAt: Date }[] = [];

export const r2Stub: R2Stub = {
  objects,
  putUrls,
  getUrls,
  put(key, bytes, contentType) {
    objects.set(key, { bytes, contentType });
  },
  reset() {
    objects.clear();
    putUrls.length = 0;
    getUrls.length = 0;
  },
};

const stubProvider: R2Provider = {
  async presignPut(key, contentType, _maxSize) {
    void _maxSize;
    const expiresAt = new Date(Date.now() + PUT_TTL_S * 1000);
    putUrls.push({ key, contentType, expiresAt });
    return {
      putUrl: `https://stub.r2.local/put/${encodeURIComponent(key)}?ct=${contentType}`,
      key,
      expiresAt,
    };
  },
  async presignGetThumbnail(key) {
    const expiresAt = new Date(Date.now() + THUMB_TTL_S * 1000);
    getUrls.push({ key, expiresAt });
    return {
      url: `https://stub.r2.local/get/${encodeURIComponent(key)}`,
      expiresAt,
    };
  },
  async presignGetFull(key) {
    const expiresAt = new Date(Date.now() + FULL_TTL_S * 1000);
    getUrls.push({ key, expiresAt });
    return {
      url: `https://stub.r2.local/get-full/${encodeURIComponent(key)}`,
      expiresAt,
    };
  },
  async deleteObject(key) {
    objects.delete(key);
  },
  async headObject(key) {
    const obj = objects.get(key);
    return obj ? { size: obj.bytes.length } : null;
  },
  async getObjectBytes(key) {
    const obj = objects.get(key);
    if (!obj) throw new Error(`stub r2: missing object ${key}`);
    return obj.bytes;
  },
  async putObjectBytes(key, bytes, contentType) {
    objects.set(key, { bytes, contentType });
  },
};

export const installR2Stub = (): void => {
  __setR2Provider(stubProvider);
};
