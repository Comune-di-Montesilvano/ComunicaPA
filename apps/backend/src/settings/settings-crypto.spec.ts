import { deriveSettingsKey, encryptValue, decryptValue, isEncryptedValue } from './settings-crypto';

describe('settings-crypto', () => {
  const key = deriveSettingsKey('test-master-secret');

  it('deriva una chiave a 32 byte deterministica', () => {
    expect(key.length).toBe(32);
    expect(deriveSettingsKey('test-master-secret').equals(key)).toBe(true);
    expect(deriveSettingsKey('altro-secret').equals(key)).toBe(false);
  });

  it('cifra e decifra round-trip', () => {
    const stored = encryptValue('password-segreta', key);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain('password-segreta');
    expect(decryptValue(stored, key)).toBe('password-segreta');
  });

  it('produce ciphertext diversi per lo stesso plaintext (IV casuale)', () => {
    expect(encryptValue('x', key)).not.toBe(encryptValue('x', key));
  });

  it('rifiuta la decifratura con chiave diversa', () => {
    const stored = encryptValue('segreto', key);
    expect(() => decryptValue(stored, deriveSettingsKey('altra'))).toThrow();
  });

  it('rifiuta formati non validi', () => {
    expect(() => decryptValue('non-cifrato', key)).toThrow('Formato valore cifrato non valido');
  });

  it('isEncryptedValue riconosce solo il formato enc:v1:', () => {
    expect(isEncryptedValue(encryptValue('a', key))).toBe(true);
    expect(isEncryptedValue('plain')).toBe(false);
    expect(isEncryptedValue(42)).toBe(false);
  });
});
