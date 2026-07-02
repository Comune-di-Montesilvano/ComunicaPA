import { createHmac, timingSafeEqual } from 'crypto';

function computeSignature(recipientId: string, expiresAtUnix: number, secret: string): string {
  return createHmac('sha256', secret).update(`${recipientId}:${expiresAtUnix}`).digest('hex');
}

export function signDownloadLink(recipientId: string, expiresAtUnix: number, secret: string): string {
  return computeSignature(recipientId, expiresAtUnix, secret);
}

export function verifyDownloadLink(
  recipientId: string,
  expiresAtUnix: number,
  signature: string,
  secret: string,
): boolean {
  const expected = computeSignature(recipientId, expiresAtUnix, secret);
  const expectedBuf = Buffer.from(expected, 'hex');
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
