import { vi } from 'vitest';
import forge from 'node-forge';
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

  return { ca, caKeys, signerCert, signerKeys };
}

/**
 * Firma RSA PKCS#1 v1.5 con DigestInfo MALFORMATO: byte spuri annidati dentro
 * DigestAlgorithm. node-forge <= 1.4.0 (nessuna versione corretta,
 * GHSA-86w9-cpqp-85rv) accetta questa struttura in `publicKey.verify()`/
 * `cert.verify()`, base delle firme contraffatte su chiavi a esponente basso:
 * una verifica corretta deve rifiutarla. Schema 'NONE' = forge firma i byte
 * DigestInfo cosi' come sono, con padding PKCS#1 tipo 1 (uno schema
 * personalizzato `{ encode }` salterebbe il padding: firma invalida per
 * tutt'altro motivo, test inutile).
 */
function signWithMalformedDigestInfo(key: forge.pki.rsa.PrivateKey, md: forge.md.MessageDigest, digestOid: string): string {
  const digestInfo = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(digestOid).getBytes()),
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ''),
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, 'garbage'),
    ]),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, md.digest().getBytes()),
  ]);
  return key.sign(forge.asn1.toDer(digestInfo).getBytes() as unknown as forge.md.MessageDigest, 'NONE');
}

function makeP7m(
  content: Buffer,
  signerCert: forge.pki.Certificate,
  signerKeys: forge.pki.rsa.KeyPair,
  digestAlgorithm: string = forge.pki.oids.sha256,
): Buffer {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(content.toString('binary'));
  p7.addCertificate(signerCert);
  p7.addSigner({
    key: signerKeys.privateKey,
    certificate: signerCert,
    digestAlgorithm,
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

/** PKCS7 detached (CAdES-detached) su un contenuto esterno — stesso schema usato dentro un PDF PAdES. */
function makeDetachedPkcs7(signedBytes: Buffer, signerCert: forge.pki.Certificate, signerKeys: forge.pki.rsa.KeyPair): Buffer {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(signedBytes.toString('binary'));
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
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(der, 'binary');
}

/**
 * Costruisce un finto "PDF" con `/ByteRange`/`/Contents` sintatticamente
 * validi (non serve una struttura PDF reale — il service legge solo questi
 * due campi via regex, mai un parser PDF completo). Il PKCS7 firma
 * esattamente i byte fuori dal placeholder `/Contents`, replicando lo
 * schema PAdES reale (ByteRange esclude solo l'hex della firma stessa).
 */
function makePadesPdf(before: Buffer, after: Buffer, signerCert: forge.pki.Certificate, signerKeys: forge.pki.rsa.KeyPair): Buffer {
  const signedBytes = Buffer.concat([before, after]);
  const pkcs7Der = makeDetachedPkcs7(signedBytes, signerCert, signerKeys);
  const hex = pkcs7Der.toString('hex').toUpperCase();
  const contentsField = Buffer.from(`/Contents<${hex}>`, 'latin1');

  const o1 = 0;
  const l1 = before.length;
  const o2 = before.length + contentsField.length;
  const l2 = after.length;
  const byteRangeField = Buffer.from(`/ByteRange[${o1} ${l1} ${o2} ${l2}]`, 'latin1');

  return Buffer.concat([before, contentsField, after, byteRangeField]);
}

describe('SignatureVerificationService', () => {
  let service: SignatureVerificationService;
  let trustList: { getTrustedCertificates: ReturnType<typeof vi.fn> };
  const { ca, caKeys, signerCert, signerKeys } = makeTestChain();

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

  it('.p7m con digest MD5 → valid: false, algoritmo non ammesso', async () => {
    const p7m = makeP7m(Buffer.from('contenuto'), signerCert, signerKeys, forge.pki.oids.md5);

    const result = await service.verify(p7m, 'documento.p7m');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('non ammesso');
  });

  it('.p7m con digest SHA-1 (firma legacy) → ancora accettata', async () => {
    const p7m = makeP7m(Buffer.from('contenuto'), signerCert, signerKeys, forge.pki.oids.sha1);

    const result = await service.verify(p7m, 'documento.p7m');

    expect(result.valid).toBe(true);
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

  it('CA nella trust list con lo stesso subject DN ma chiave diversa (non ha firmato realmente) → rifiutata, mai un bypass per solo nome', async () => {
    // Stesso subject/issuer "Test CA" della CA reale, ma coppia di chiavi
    // diversa: non ha mai firmato signerCert. Un confronto per solo nome
    // (bypassato in una versione precedente del service) la accetterebbe
    // per errore.
    const rogueKeys = forge.pki.rsa.generateKeyPair(1024);
    const rogueCa = forge.pki.createCertificate();
    rogueCa.publicKey = rogueKeys.publicKey;
    rogueCa.serialNumber = '99';
    rogueCa.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    rogueCa.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    rogueCa.setSubject([{ name: 'commonName', value: 'Test CA' }]);
    rogueCa.setIssuer([{ name: 'commonName', value: 'Test CA' }]);
    rogueCa.sign(rogueKeys.privateKey);

    trustList.getTrustedCertificates.mockResolvedValue([rogueCa]);
    const content = Buffer.from('contenuto');
    const p7m = makeP7m(content, signerCert, signerKeys);

    const result = await service.verify(p7m, 'documento.p7m');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('non riconosciuta');
  });

  it('.p7m con catena completa (CA intermedia + firmatario, in quest\'ordine) → sceglie il certificato firmatario corretto, non il primo per posizione', async () => {
    const content = Buffer.from('contenuto con catena completa');
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(content.toString('binary'));
    // CA aggiunta PRIMA del firmatario: se il codice prendesse certificates[0]
    // per posizione, selezionerebbe erroneamente la CA come "firmatario".
    p7.addCertificate(ca);
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
    const p7m = Buffer.from(der, 'binary');

    const result = await service.verify(p7m, 'documento.p7m');

    expect(result.valid).toBe(true);
    expect(result.signerCn).toBe('Mario Rossi Test');
  });

  it('.p7m con firma CMS su DigestInfo malformato (GHSA-86w9-cpqp-85rv) → rifiutata', async () => {
    const content = Buffer.from('contenuto con firma malformata');
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
    // Rifirma lo stesso SET di authenticatedAttributes con la chiave reale del
    // firmatario, ma con un DigestInfo malformato.
    const signer = (p7 as any).signers[0];
    const attrsSet = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, signer.authenticatedAttributesAsn1.value);
    const md = forge.md.sha256.create().update(forge.asn1.toDer(attrsSet).getBytes());
    const forgedSignature = signWithMalformedDigestInfo(signerKeys.privateKey, md, forge.pki.oids.sha256);
    // forge serializza i SignerInfo gia' dentro sign(): la firma va sostituita
    // nell'ASN.1 (ContentInfo > [0] > SignedData > signerInfos > SignerInfo,
    // ultimo campo = OCTET STRING della firma), non su `signer.signature`.
    const asn1 = p7.toAsn1();
    const signedData = (asn1.value[1] as forge.asn1.Asn1).value[0] as forge.asn1.Asn1;
    const signerInfos = (signedData.value as forge.asn1.Asn1[]).at(-1)!;
    const signerInfo = (signerInfos.value as forge.asn1.Asn1[])[0];
    const signatureNode = (signerInfo.value as forge.asn1.Asn1[]).at(-1)!;
    expect(signatureNode.type).toBe(forge.asn1.Type.OCTETSTRING);
    signatureNode.value = forgedSignature;
    const p7m = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');

    const result = await service.verify(p7m, 'documento.p7m');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Integrità');
  });

  it('certificato firmatario firmato dalla CA con DigestInfo malformato (GHSA-86w9-cpqp-85rv) → CA non riconosciuta', async () => {
    const forgedCert = forge.pki.createCertificate();
    forgedCert.publicKey = signerKeys.publicKey;
    forgedCert.serialNumber = '03';
    forgedCert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    forgedCert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    forgedCert.setSubject([{ name: 'commonName', value: 'Mario Rossi Test' }]);
    forgedCert.setIssuer(ca.subject.attributes);
    forgedCert.sign(caKeys.privateKey, forge.md.sha256.create());
    const tbsDer = forge.asn1.toDer((forge.pki as any).getTBSCertificate(forgedCert)).getBytes();
    const md = forge.md.sha256.create().update(tbsDer);
    forgedCert.signature = signWithMalformedDigestInfo(caKeys.privateKey, md, forge.pki.oids.sha256);
    const p7m = makeP7m(Buffer.from('contenuto'), forgedCert, signerKeys);

    const result = await service.verify(p7m, 'documento.p7m');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('non riconosciuta');
  });

  describe('PAdES (PDF con firma embedded)', () => {
    it('PDF firmato PAdES valido, CA in trust list → valid: true', async () => {
      const before = Buffer.from('%PDF-1.4\n1 0 obj<< /Sig 2 0 R >>\nendobj\n2 0 obj<< /Type /Sig ');
      const after = Buffer.from(' >>\nendobj\n%%EOF');
      const pdf = makePadesPdf(before, after, signerCert, signerKeys);

      const result = await service.verify(pdf, 'documento.pdf');

      expect(result.valid).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.signerCn).toBe('Mario Rossi Test');
    });

    it('PDF PAdES con CA non in trust list → valid: false, reason CA non riconosciuta', async () => {
      trustList.getTrustedCertificates.mockResolvedValue([]);
      const before = Buffer.from('%PDF-1.4\ncontenuto prima ');
      const after = Buffer.from(' contenuto dopo\n%%EOF');
      const pdf = makePadesPdf(before, after, signerCert, signerKeys);

      const result = await service.verify(pdf, 'documento.pdf');

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('non riconosciuta');
    });

    it('PDF PAdES manomesso dopo la firma (byte fuori ByteRange coerenti ma contenuto realmente alterato) → valid: false, hash non corrispondente', async () => {
      const before = Buffer.from('%PDF-1.4\ncontenuto originale ');
      const after = Buffer.from(' fine\n%%EOF');
      const pdf = makePadesPdf(before, after, signerCert, signerKeys);
      // Altera un byte dentro il range firmato (prima parte, fuori dal
      // placeholder /Contents) — stesso principio di un documento
      // modificato dopo la firma: il digest ricalcolato non corrisponde più.
      const tampered = Buffer.from(pdf);
      tampered[10] = tampered[10] === 0x61 ? 0x62 : 0x61; // ribalta un byte qualsiasi nel preambolo

      const result = await service.verify(tampered, 'documento.pdf');

      expect(result.valid).toBe(false);
    });

    it('PDF senza /ByteRange o /Contents (non firmato) → valid: false, reason non firmato', async () => {
      const plainPdf = Buffer.from('%PDF-1.4\ncontenuto qualsiasi\n%%EOF');

      const result = await service.verify(plainPdf, 'documento.pdf');

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('non firmato');
    });
  });
});
