import { createHmac, timingSafeEqual } from 'crypto';

function computeSignature(recipientId: string, index: number, expiresAtUnix: number, secret: string, channel: string): string {
  return createHmac('sha256', secret).update(`${recipientId}:${index}:${expiresAtUnix}:${channel}`).digest('hex');
}

export function signDownloadLink(recipientId: string, index: number, expiresAtUnix: number, secret: string, channel = ''): string {
  return computeSignature(recipientId, index, expiresAtUnix, secret, channel);
}

export function verifyDownloadLink(
  recipientId: string,
  index: number,
  expiresAtUnix: number,
  signature: string,
  secret: string,
  channel = '',
): boolean {
  const expected = computeSignature(recipientId, index, expiresAtUnix, secret, channel);
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
