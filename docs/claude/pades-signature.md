# Verifica firma digitale PDF (PAdES)

## Verifica firma digitale PDF (PAdES) — node-forge, gotcha reali

Un allegato SEND è quasi sempre un **PDF con firma PAdES embedded**
(`/ByteRange` + `/Contents`, CAdES-detached), MAI un `.p7m` — SEND manda
sempre `contentType: 'application/pdf'` a PN (`send-dispatch.service.ts`),
`.p7m` non è un formato utilizzabile su quel canale (supportato comunque
in `SignatureVerificationService` per completezza/altri usi futuri).

**`forge.asn1.fromDer(der)` con le opzioni default (`parseAllBytes: true`)
rigetta ogni firma PAdES reale** con "Unparsed DER bytes remain after
ASN.1 parsing" — il placeholder esadecimale riservato per `/Contents` nel
PDF è quasi sempre più grande della firma effettiva, il padding di zeri
finale dentro l'hex string non è DER valido. Serve `parseAllBytes: false`
esplicito (non tipizzato da `@types/node-forge`, richiede un cast).

**`forge.pkcs7.PkcsSignedData.verify()` non è implementato** (lancia
sempre "not yet implemented", verificato leggendo `pkcs7.js`) — la
verifica va fatta a mano: digest del contenuto vs attributo
`messageDigest`, poi verifica RSA sul SET DER degli
`authenticatedAttributes` (RFC 2315 §9.3), mai sul contenuto diretto.

**Selezionare il certificato firmatario per issuer+serialNumber dichiarati
nel SignerInfo, mai `certificates[0]` per posizione** — un file firmato
reale include spesso la CA intermedia nella busta, l'ordine non è
garantito. Vedi
`apps/backend/src/signature-verification/signature-verification.service.ts`
per l'implementazione completa (gotcha `node-forge` import sopra
applicabile 1:1 anche qui).

