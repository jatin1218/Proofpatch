import { createHash } from 'node:crypto';

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** Fingerprint of an empty staged set. */
export const EMPTY_FINGERPRINT = sha256('[]');
