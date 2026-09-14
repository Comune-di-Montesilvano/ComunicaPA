import { vi } from 'vitest';
import * as forge from 'node-forge';
import { SignatureVerificationService } from './signature-verification.service.js';
import type { AgidTrustListService } from './agid-trust-list.service.js';

/** Genera una coppia CA+certificato firmatario di test, mai dati reali. */
function makeTestChain() {
  const caKeys = forge.pki.rsa.generateKeyPair(1024);
  const ca = forge.pki.createCertificate();
  ca.publicKey = caKeys.publicKey;
  ca.serialNumber = '01';
  ca.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  ca.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  ca.setSubject([{ name: 'commonName', value: 'Test CA' }]);
  ca.setIssuer([{ name: 'commonName', value: 'Test CA' }]);
  ca.sign(caKeys.privateKey);

  const signerKeys = forge.pki.rsa.generateKeyPair(1024);
  const signerCert = forge.pki.createCertificate();
  signerCert.publicKey = signerKeys.publicKey;
  signerCert.serialNumber = '02';
  signerCert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  signerCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  signerCert.setSubject([{ name: 'commonName', value: 'Mario Rossi Test' }]);
  signerCert.setIssuer(ca.subject.attributes);
  signerCert.sign(caKeys.privateKey);

  return { ca, signerCert, signerKeys };
}

function makeP7m(content: Buffer, signerCert: forge.pki.Certificate, signerKeys: forge.pki.rsa.KeyPair): Buffer {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(content.toString('binary'));
  p7.addCertificate(signerCert);
  p7.addSigner({
    key: signerKeys.privateKey,
    certificate: signerCert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() as unknown as string },
    ],
  });
  p7.sign();
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(der, 'binary');
}

describe('SignatureVerificationService', () => {
  let service: SignatureVerificationService;
  let trustList: { getTrustedCertificates: ReturnType<typeof vi.fn> };
  const { ca, signerCert, signerKeys } = makeTestChain();

  beforeEach(() => {
    trustList = { getTrustedCertificates: vi.fn().mockResolvedValue([ca]) };
    service = new SignatureVerificationService(trustList as unknown as AgidTrustListService);
  });

  it('.p7m valido, CA in trust list → valid: true', async () => {
    const content = Buffer.from('contenuto del documento di test');
    const p7m = makeP7m(content, signerCert, signerKeys);

    const result = await service.verify(p7m, 'documento.p7m');

    expect(result.valid).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('.p7m con CA non in trust list → valid: false, reason CA non riconosciuta', async () => {
    trustList.getTrustedCertificates.mockResolvedValue([]);
    const content = Buffer.from('contenuto');
    const p7m = makeP7m(content, signerCert, signerKeys);

    const result = await service.verify(p7m, 'documento.p7m');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('non riconosciuta');
  });

  it('file non firmato (PDF semplice) → valid: false, reason non firmato', async () => {
    const plainPdf = Buffer.from('%PDF-1.4\n%%EOF');

    const result = await service.verify(plainPdf, 'documento.pdf');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('non firmato');
  });

  it('file .p7m corrotto → valid: false, reason firma corrotta', async () => {
    const corrupted = Buffer.from('non è un PKCS7 valido');

    const result = await service.verify(corrupted, 'documento.p7m');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('non leggibile');
  });
});
