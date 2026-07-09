import { createHmac, timingSafeEqual } from 'crypto';

// Il flag `preview` entra nella firma: un link generato con preview=true (anteprima
// backoffice) non può essere "spacciato" per un link reale (preview=false) o
// viceversa, perché altererebbe l'HMAC. Vedi public-download.controller.ts, che
// usa questo flag per non contare come download del cittadino i click fatti
// dall'operatore sull'anteprima del messaggio nel dettaglio notifica.
function computeSignature(recipientId: string, index: number, expiresAtUnix: number, secret: string, channel: string, preview: boolean): string {
  // preview=false DEVE produrre la stringa identica a prima dell'introduzione del
  // flag: i link già inviati in campagne passate (email/PEC/AppIO/SEND) sono
  // firmati senza alcun suffisso e devono restare validi. Il suffisso ":preview"
  // si aggiunge SOLO quando preview=true, mai uno spazio vuoto al suo posto.
  const suffix = preview ? ':preview' : '';
  return createHmac('sha256', secret).update(`${recipientId}:${index}:${expiresAtUnix}:${channel}${suffix}`).digest('hex');
}

export function signDownloadLink(recipientId: string, index: number, expiresAtUnix: number, secret: string, channel = '', preview = false): string {
  return computeSignature(recipientId, index, expiresAtUnix, secret, channel, preview);
}

export function verifyDownloadLink(
  recipientId: string,
  index: number,
  expiresAtUnix: number,
  signature: string,
  secret: string,
  channel = '',
  preview = false,
): boolean {
  const expected = computeSignature(recipientId, index, expiresAtUnix, secret, channel, preview);
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
