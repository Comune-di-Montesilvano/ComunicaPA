import { Injectable, Logger } from '@nestjs/common';
import * as forge from 'node-forge';
import { AgidTrustListService } from './agid-trust-list.service.js';

export interface SignatureVerificationResult {
  valid: boolean;
  reason: string | null;
  signerCn?: string;
}

// Costruita a runtime (non a module-scope): un accesso a `forge.pki.oids`
// nell'inizializzatore di una const top-level fallisce con "Cannot read
// properties of undefined" sotto NodeNext/ESM — l'interop CJS di node-forge
// non garantisce che i sotto-moduli (`pki`, `md`) siano già attaccati
// all'import-time del modulo, solo quando effettivamente usati a runtime
// (stesso principio dei gotcha CJS/ESM già noti in CLAUDE.md per ioredis).
function digestCreatorFor(oid: string): (() => forge.md.MessageDigest) | undefined {
  const creators: Record<string, () => forge.md.MessageDigest> = {
    [forge.pki.oids.sha1]: () => forge.md.sha1.create(),
    [forge.pki.oids.sha256]: () => forge.md.sha256.create(),
    [forge.pki.oids.sha384]: () => forge.md.sha384.create(),
    [forge.pki.oids.sha512]: () => forge.md.sha512.create(),
    [forge.pki.oids.md5]: () => forge.md.md5.create(),
  };
  return creators[oid];
}

/**
 * Verifica offline (nessun controllo di revoca OCSP/CRL): integrità
 * crittografica della firma + certificato firmatario riconducibile a una
 * CA nella TSL italiana AgID + certificato non scaduto. Formati supportati:
 * .p7m (CAdES, l'intero file è un envelope PKCS7/CMS) e PDF con firma
 * PAdES embedded (ByteRange/Contents — non ancora implementato in questa
 * versione, vedi TODO Task 4 se serve: per ora un PDF senza wrapper .p7m
 * risulta sempre "non firmato").
 *
 * `forge.pkcs7.PkcsSignedData.verify()` non è implementato nella libreria
 * (lancia sempre "not yet implemented", verificato leggendo
 * node_modules/node-forge/lib/pkcs7.js) — la verifica crittografica è fatta
 * a mano qui: si ricalcola il digest del contenuto, lo si confronta con
 * l'attributo messageDigest firmato, poi si verifica la firma RSA sul SET
 * DER degli authenticatedAttributes (RFC 2315 §9.3) con la chiave pubblica
 * del certificato firmatario.
 */
@Injectable()
export class SignatureVerificationService {
  private readonly logger = new Logger(SignatureVerificationService.name);

  constructor(private readonly trustList: AgidTrustListService) {}

  async verify(buffer: Buffer, filename: string): Promise<SignatureVerificationResult> {
    const isP7m = filename.toLowerCase().endsWith('.p7m');
    if (!isP7m) {
      return { valid: false, reason: 'File non firmato (nessun involucro .p7m riconosciuto)' };
    }

    let p7: forge.pkcs7.PkcsSignedData;
    try {
      const der = forge.util.createBuffer(buffer.toString('binary'));
      const asn1 = forge.asn1.fromDer(der);
      p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData;
    } catch (err: any) {
      this.logger.warn(`Impossibile decodificare ${filename} come PKCS7: ${err?.message ?? err}`);
      return { valid: false, reason: 'Firma non leggibile (file .p7m corrotto o non PKCS7)' };
    }

    if (!p7.certificates || p7.certificates.length === 0) {
      return { valid: false, reason: 'Nessun certificato firmatario trovato nella busta .p7m' };
    }
    // Un .p7m reale include spesso l'intera catena (firmatario + CA
    // intermedia), non solo il certificato firmatario — prendere sempre
    // `certificates[0]` sceglierebbe il certificato sbagliato se l'ordine
    // non è quello atteso. Si seleziona il certificato che corrisponde
    // esattamente a issuer+serialNumber dichiarati nel SignerInfo.
    const signerCert = this.selectSignerCertificate(p7, (p7 as any).rawCapture);
    if (!signerCert) {
      return { valid: false, reason: 'Certificato firmatario non identificabile nella busta .p7m' };
    }

    const now = new Date();
    if (now < signerCert.validity.notBefore || now > signerCert.validity.notAfter) {
      return { valid: false, reason: 'Certificato firmatario scaduto o non ancora valido', signerCn: this.commonName(signerCert) };
    }

    let signatureValid: boolean;
    try {
      signatureValid = this.verifyCryptographically(p7, signerCert);
    } catch (err: any) {
      this.logger.warn(`Verifica crittografica fallita per ${filename}: ${err?.message ?? err}`);
      return { valid: false, reason: 'Integrità della firma non verificata (hash non corrispondente)' };
    }
    if (!signatureValid) {
      return { valid: false, reason: 'Integrità della firma non verificata (hash non corrispondente)' };
    }

    const trustedCerts = await this.trustList.getTrustedCertificates();
    // Solo verifica crittografica reale (ca.verify firma effettivamente il
    // certificato firmatario) — MAI un confronto di solo nome (subject vs
    // issuer): un DN uguale per stringa non prova che quella CA abbia
    // davvero firmato il certificato, bypassabile costruendo un issuer che
    // dichiara semplicemente il nome di una CA fidata senza averne la
    // chiave privata.
    const issuerRecognized = trustedCerts.some((ca) => {
      try {
        return ca.verify(signerCert);
      } catch {
        return false;
      }
    });
    if (!issuerRecognized) {
      return { valid: false, reason: 'CA emittente non riconosciuta (non presente nella TSL italiana AgID)', signerCn: this.commonName(signerCert) };
    }

    return { valid: true, reason: null, signerCn: this.commonName(signerCert) };
  }

  /**
   * Verifica manuale RFC 2315 §9.3: digest del contenuto confrontato con
   * l'attributo messageDigest, poi firma RSA verificata sul SET DER degli
   * authenticatedAttributes (non sul contenuto direttamente, quando gli
   * authenticatedAttributes sono presenti — sempre il caso per CAdES-BES).
   */
  private verifyCryptographically(p7: forge.pkcs7.PkcsSignedData, signerCert: forge.pki.Certificate): boolean {
    const rawCapture = (p7 as any).rawCapture;
    if (!rawCapture) throw new Error('rawCapture assente sul messaggio PKCS7');

    const digestOid = forge.asn1.derToOid(rawCapture.digestAlgorithm);
    const createDigest = digestCreatorFor(digestOid);
    if (!createDigest) throw new Error(`Algoritmo di digest non supportato: ${digestOid}`);

    const contentBytes = this.extractContentBytes(rawCapture.content);
    const contentDigest = createDigest().update(contentBytes).digest().bytes();

    const authAttrs: forge.asn1.Asn1[] | undefined = rawCapture.authenticatedAttributes;
    const signatureBytes: string = rawCapture.signature;

    let digestToVerify: string;
    if (authAttrs && authAttrs.length > 0) {
      const messageDigestAttr = authAttrs.find((attr) => {
        const oid = forge.asn1.derToOid((attr.value[0] as forge.asn1.Asn1).value as string);
        return oid === forge.pki.oids.messageDigest;
      });
      if (!messageDigestAttr) throw new Error('Attributo messageDigest assente negli authenticatedAttributes');
      const claimedDigest = (((messageDigestAttr.value[1] as forge.asn1.Asn1).value[0] as forge.asn1.Asn1).value) as string;
      if (claimedDigest !== contentDigest) throw new Error('Digest del contenuto non corrispondente a messageDigest');

      // RFC 2315 §9.3: la firma copre il SET DER degli attributi (non il
      // contenitore [0] IMPLICIT usato per il trasporto) — si re-incapsula
      // esattamente gli stessi nodi ASN.1 già decodificati in un SET UNIVERSAL.
      const attrsSet = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, authAttrs);
      const attrsDer = forge.asn1.toDer(attrsSet).getBytes();
      digestToVerify = createDigest().update(attrsDer).digest().bytes();
    } else {
      digestToVerify = contentDigest;
    }

    // Certificate.publicKey è tipizzato come pki.PublicKey generico (nessun
    // metodo) da @types/node-forge — a runtime, per certificati RSA (unico
    // caso supportato qui), è sempre un rsa.PublicKey con verify().
    return (signerCert.publicKey as forge.pki.rsa.PublicKey).verify(digestToVerify, signatureBytes);
  }

  /**
   * `_fromAsn1` di node-forge popola `msg.content` in modo affidabile solo
   * quando il contenuto arriva come array di nodi OCTET STRING (BER
   * costruito) — nel caso comune (wrapper `[0]` EXPLICIT con un singolo
   * OCTET STRING dentro) mette l'intero nodo raw in `msg.content` invece
   * della stringa attesa, producendo un `ByteStringBuffer` vuoto (bug/
   * limite verificato leggendo `pkcs7.js` e con test empirico). Si estraggono
   * quindi i byte direttamente dal capture raw, replicando la stessa logica
   * di concatenazione che `_fromAsn1` applica solo al ramo array.
   */
  private extractContentBytes(rawContent: unknown): string {
    if (!rawContent) return '';
    const nodes: forge.asn1.Asn1[] = Array.isArray(rawContent)
      ? (rawContent as forge.asn1.Asn1[])
      : (((rawContent as forge.asn1.Asn1).value as forge.asn1.Asn1[]) ?? []);
    return nodes.map((n) => n.value as string).join('');
  }

  /**
   * Sceglie, fra tutti i certificati inclusi nella busta (firmatario +
   * eventuali CA intermedie), quello che corrisponde esattamente a
   * issuer+serialNumber dichiarati nel SignerInfo — mai il primo per
   * posizione, l'ordine dei certificati in un .p7m reale non è garantito.
   */
  private selectSignerCertificate(p7: forge.pkcs7.PkcsSignedData, rawCapture: any): forge.pki.Certificate | undefined {
    const certs = p7.certificates;
    if (!rawCapture?.serial || !rawCapture?.issuer) return certs[0];

    const normalizeHex = (hex: string): string => hex.replace(/^0+/, '').toUpperCase() || '0';
    const wantedSerial = normalizeHex(forge.util.createBuffer(rawCapture.serial).toHex());
    const wantedIssuerDer = forge.asn1.toDer(rawCapture.issuer).getBytes();

    return certs.find((cert) => {
      if (normalizeHex(cert.serialNumber) !== wantedSerial) return false;
      const certIssuerDer = forge.asn1.toDer(forge.pki.distinguishedNameToAsn1(cert.issuer)).getBytes();
      return certIssuerDer === wantedIssuerDer;
    });
  }

  private commonName(cert: forge.pki.Certificate): string | undefined {
    return cert.subject.getField('CN')?.value;
  }
}
