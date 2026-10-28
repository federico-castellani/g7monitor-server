import { createHash, randomBytes } from 'node:crypto';

/** 256 random bits. Only the SHA-256 is stored, so a leaked database cannot be used to log in. */
export function newToken(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url');
}

export function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

export const DEVICE_TOKEN_PREFIX = 'g7d_';
export const DEVICE_TOKEN_RE = /^g7d_[A-Za-z0-9_-]{43}$/;
export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
