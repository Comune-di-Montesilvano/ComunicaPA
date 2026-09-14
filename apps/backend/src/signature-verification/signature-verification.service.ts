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
 * Estrae firma PAdES da un PDF: `/ByteRange [o1 l1 o2 l2]` delimita i due
 * intervalli di byte REALMENTE firmati (l'intero file tranne il placeholder
 * esadecimale di `/Contents`), `/Contents <HEX>` è la busta PKCS7/CMS
 * (CAdES-detached: il contenuto non è incluso nel PKCS7, va ricalcolato dal
 * PDF stesso). Approccio a regex sul buffer, non un parser PDF completo —
 * sufficiente perché ci servono solo questi due campi dal dizionario di
 * firma, non l'intera struttura PDF. Prende il PRIMO match di entrambi:
 * PDF con firme multiple (incrementali) non sono gestiti, limite accettato
 * per ora (caso comune per un allegato SEND è una singola firma).
 */
function extractPdfSignature(buffer: Buffer): { signedBytes: Buffer; pkcs7Der: Buffer } | null {
  const asLatin1 = buffer.toString('latin1');

  const byteRangeMatch = asLatin1.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
  const contentsMatch = asLatin1.match(/\/Contents\s*<([0-9A-Fa-f]+)>/);
  if (!byteRangeMatch || !contentsMatch) return null;

  const o1 = Number(byteRangeMatch[1]);
  const l1 = Number(byteRangeMatch[2]);
  const o2 = Number(byteRangeMatch[3]);
  const l2 = Number(byteRangeMatch[4]);
  if (o1 + l1 > buffer.length || o2 + l2 > buffer.length) return null;

  const signedBytes = Buffer.concat([buffer.subarray(o1, o1 + l1), buffer.subarray(o2, o2 + l2)]);
  const pkcs7Der = Buffer.from(contentsMatch[1], 'hex');
  return { signedBytes, pkcs7Der };
}

/**
 * Verifica offline (nessun controllo di revoca OCSP/CRL): integrità
 * crittografica della firma + certificato firmatario riconducibile a una
 * CA nella TSL italiana AgID + certificato non scaduto. Formati supportati:
 * .p7m (CAdES, l'intero file è un envelope PKCS7/CMS, contenuto embedded)
 * e PDF con firma PAdES (ByteRange/Contents, CAdES-detached — il contenuto
 * firmato è il PDF stesso, non incluso nel PKCS7).
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
    const lower = filename.toLowerCase();

    if (lower.endsWith('.p7m')) {
      return this.verifyP7m(buffer, filename);
    }
    if (lower.endsWith('.pdf')) {
      return this.verifyPades(buffer, filename);
    }
    return { valid: false, reason: 'File non firmato (nessuna firma .p7m o PAdES riconosciuta)' };
  }

  private async verifyP7m(buffer: Buffer, filename: string): Promise<SignatureVerificationResult> {
    let p7: forge.pkcs7.PkcsSignedData;
    try {
      const der = forge.util.createBuffer(buffer.toString('binary'));
      const asn1 = forge.asn1.fromDer(der);
      p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData;
    } catch (err: any) {
      this.logger.warn(`Impossibile decodificare ${filename} come PKCS7: ${err?.message ?? err}`);
      return { valid: false, reason: 'Firma non leggibile (file .p7m corrotto o non PKCS7)' };
    }
    // Contenuto embedded nel PKCS7 stesso (non detached) — nessun override.
    return this.finishVerification(p7, filename);
  }

  private async verifyPades(buffer: Buffer, filename: string): Promise<SignatureVerificationResult> {
    const sig = extractPdfSignature(buffer);
    if (!sig) {
      return { valid: false, reason: 'File non firmato (nessuna firma PAdES trovata nel PDF: /ByteRange o /Contents assenti)' };
    }

    let p7: forge.pkcs7.PkcsSignedData;
    try {
      const der = forge.util.createBuffer(sig.pkcs7Der.toString('binary'));
      // parseAllBytes: false — il placeholder /Contents riservato nel PDF è
      // spesso più grande della firma reale, l'eccedenza è riempita con
      // zeri esadecimali (`00`) DENTRO l'hex string stessa: con il default
      // `parseAllBytes: true` forge rigetta con "Unparsed DER bytes remain"
      // anche su una firma perfettamente valida (verificato su un PDF PAdES
      // reale). Va analizzata solo la struttura DER dichiarata, ignorando
      // il padding finale.
      // @types/node-forge tipizza il secondo parametro solo come `boolean`
      // (retrocompatibilità con l'API precedente) — a runtime forge accetta
      // anche l'oggetto opzioni esteso, verificato leggendo asn1.js e con
      // test empirico contro un PDF PAdES reale.
      const asn1 = forge.asn1.fromDer(der, { strict: true, parseAllBytes: false, decodeBitStrings: true } as unknown as boolean);
      p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData;
    } catch (err: any) {
      this.logger.warn(`Impossibile decodificare la firma PAdES di ${filename}: ${err?.message ?? err}`);
      return { valid: false, reason: 'Firma non leggibile (busta PKCS7 PAdES corrotta)' };
    }
    // CAdES-detached: il contenuto firmato è il PDF stesso (byte range),
    // mai incluso nel PKCS7 — override esplicito.
    return this.finishVerification(p7, filename, sig.signedBytes.toString('binary'));
  }

  /**
   * Logica comune a .p7m e PAdES una volta ottenuto il messaggio PKCS7:
   * selezione certificato firmatario, validità temporale, verifica
   * crittografica, verifica trust CA. `detachedContentBytes` è definito
   * solo per PAdES (il contenuto non è nel PKCS7); per .p7m resta
   * `undefined` e si legge dal `rawCapture.content` del messaggio stesso.
   */
  private async finishVerification(
    p7: forge.pkcs7.PkcsSignedData,
    filename: string,
    detachedContentBytes?: string,
  ): Promise<SignatureVerificationResult> {
    if (!p7.certificates || p7.certificates.length === 0) {
      return { valid: false, reason: 'Nessun certificato firmatario trovato nella busta di firma' };
    }
    // Un file firmato reale include spesso l'intera catena (firmatario + CA
    // intermedia), non solo il certificato firmatario — prendere sempre
    // `certificates[0]` sceglierebbe il certificato sbagliato se l'ordine
    // non è quello atteso. Si seleziona il certificato che corrisponde
    // esattamente a issuer+serialNumber dichiarati nel SignerInfo.
    const signerCert = this.selectSignerCertificate(p7, (p7 as any).rawCapture);
    if (!signerCert) {
      return { valid: false, reason: 'Certificato firmatario non identificabile nella busta di firma' };
    }

    const now = new Date();
    if (now < signerCert.validity.notBefore || now > signerCert.validity.notAfter) {
      return { valid: false, reason: 'Certificato firmatario scaduto o non ancora valido', signerCn: this.commonName(signerCert) };
    }

    let signatureValid: boolean;
    try {
      signatureValid = this.verifyCryptographically(p7, detachedContentBytes);
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
   * authenticatedAttributes sono presenti — sempre il caso per CAdES-BES/
   * PAdES). `detachedContentBytes`, se fornito (PAdES), sostituisce la
   * lettura di `rawCapture.content` (assente/non significativo per una
   * firma detached).
   */
  private verifyCryptographically(p7: forge.pkcs7.PkcsSignedData, detachedContentBytes?: string): boolean {
    const rawCapture = (p7 as any).rawCapture;
    if (!rawCapture) throw new Error('rawCapture assente sul messaggio PKCS7');

    const digestOid = forge.asn1.derToOid(rawCapture.digestAlgorithm);
    const createDigest = digestCreatorFor(digestOid);
    if (!createDigest) throw new Error(`Algoritmo di digest non supportato: ${digestOid}`);

    const contentBytes = detachedContentBytes !== undefined ? detachedContentBytes : this.extractContentBytes(rawCapture.content);
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

    const signerCert = this.selectSignerCertificate(p7, rawCapture)!;
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
   * posizione, l'ordine dei certificati in un file firmato reale non è
   * garantito.
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
