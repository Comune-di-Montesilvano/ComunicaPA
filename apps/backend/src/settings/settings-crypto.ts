import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

const PREFIX = 'enc:v1:';

/** Deriva la chiave di cifratura dei settings dal JWT_SECRET via HKDF-SHA256. */
export function deriveSettingsKey(masterSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', masterSecret, 'comunicapa-settings', 'settings-encryption-v1', 32),
  );
}

export function encryptValue(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptValue(stored: string, key: Buffer): string {
  if (!stored.startsWith(PREFIX)) {
    throw new Error('Formato valore cifrato non valido');
  }
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Formato valore cifrato non valido');
  }
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function isEncryptedValue(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(PREFIX);
}
