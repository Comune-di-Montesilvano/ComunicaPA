# Verifica firma digitale allegati SEND Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verificare crittograficamente la firma digitale degli allegati SEND (PAdES/CAdES, catena contro la TSL italiana AgID) — avviso non bloccante su invio singolo, blocco del lancio su invio massivo finché tutti gli allegati non risultano firmati validi.

**Architecture:** Nuovo modulo `signature-verification` con due servizi indipendenti — `AgidTrustListService` (fetch/cache/cron della TSL-IT.xml) e `SignatureVerificationService` (verifica crittografica via `node-forge`, formato PDF/PAdES o `.p7m`/CAdES). Invio singolo: verifica sincrona dentro `launch()`/`launchTestSend()`, esito in un campo non bloccante della risposta. Invio massivo: job BullMQ dedicato triggerato dal frontend subito dopo l'upload allegati, `launch()` blocca finché il job non è `done` con `invalidCount === 0` — stesso pattern 200+`{blocked:true}` già in uso per gli allegati mancanti.

**Tech Stack:** NestJS 12 (ESM) + TypeORM 0.3.x + BullMQ + Vitest (backend), React 19 + Vite (frontend-admin). Nuova dipendenza: `node-forge` (parsing ASN.1/PKCS7/X.509, nessuna chiamata di rete).

**Spec:** `docs/superpowers/specs/2026-09-14-firma-digitale-send-design.md`

## Global Constraints

- Riguarda **solo** il canale SEND.
- Verifica **offline**: nessun controllo di revoca (OCSP/CRL), nessuna chiamata di rete se non il fetch periodico della TSL-IT.
- Solo TSL italiana AgID (`https://eidas.agid.gov.it/TL/TSL-IT.xml`) — non EU LOTL.
- Invio massivo: la verifica gira **sempre** in un job BullMQ, mai sincrona in un handler HTTP (gotcha CLAUDE.md: lavoro pesante sincrono affama l'event loop, non solo rischio timeout proxy).
- Mai eccezione HTTP non-2xx per il blocco lancio — sempre `{ blocked: true, message }` con status 200 (gotcha reverse proxy esterno).
- Ogni nuovo import relativo nel backend richiede `.js` esplicito (ESM/NodeNext).
- Ogni nuova migration va registrata SIA nell'import SIA nell'array `migrations` SIA nell'array `entities` di `database.module.ts` (gotcha CLAUDE.md).
- **Mai CF/dati reali nei fixture di test** — generare firme di test con una CA self-signed locale.
- Dopo ogni modifica di firma di metodo esistente (`launch()`, `launchTestSend()`), eseguire la suite completa, non un pattern mirato.
- Bottoni duplicati in cima/fondo allo step wizard (gotcha CLAUDE.md): ogni modifica a una condizione `disabled`/`onClick` del bottone "Lancia" va applicata a **entrambe** le occorrenze.

---

## Task 1: Dipendenza `node-forge`

**Files:**
- Modify: `apps/backend/package.json`
- Modify: `pnpm-lock.yaml` (via comando, non a mano)

- [ ] **Step 1: Aggiungere la dipendenza**

In `apps/backend/package.json`, blocco `dependencies`, aggiungere in ordine alfabetico:

```json
    "node-forge": "^1.3.1",
```

E in `devDependencies`:

```json
    "@types/node-forge": "^1.3.11",
```

- [ ] **Step 2: Aggiornare il lockfile (pattern Docker già noto, niente Node sull'host)**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --lockfile-only --ignore-scripts"
```

- [ ] **Step 3: Rebuild immagine backend e volume node_modules (gotcha CLAUDE.md: volume stale su nuova dipendenza)**

```bash
docker compose build backend
docker compose rm -sf backend
docker volume rm comunicapa_backend_node_modules
docker compose up -d backend
```

Verificare che il container parta senza `MODULE_NOT_FOUND` (`docker compose logs backend --tail 30`).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/package.json pnpm-lock.yaml
git commit -m "chore: aggiungi node-forge per verifica firma digitale allegati SEND"
```

---

## Task 2: `AgidTrustListService` — fetch/cache/refresh TSL-IT

**Files:**
- Create: `apps/backend/src/entities/agid-trust-list-cache.entity.ts`
- Create: `apps/backend/src/database/migrations/1787000000000-CreateAgidTrustListCache.ts`
- Modify: `apps/backend/src/database/database.module.ts`
- Create: `apps/backend/src/signature-verification/agid-trust-list.service.ts`
- Create: `apps/backend/src/signature-verification/agid-trust-list.service.spec.ts`
- Create: `apps/backend/src/signature-verification/signature-verification.module.ts`

**Interfaces:**
- Produce: `AgidTrustListService.getTrustedCertificates(): Promise<forge.pki.Certificate[]>` — usata da Task 3 (`SignatureVerificationService`).

- [ ] **Step 1: Creare l'entity cache**

```ts
// apps/backend/src/entities/agid-trust-list-cache.entity.ts
import { Column, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Singola riga (sempre id fisso 'current'): cache della TSL-IT.xml
 * (ETSI TS 119612, certificati CA qualificate italiane). Refresh via
 * AgidTrustListService.refresh() (@Cron giornaliero) — se il fetch
 * fallisce si continua a usare questa cache (fail-open sulla
 * disponibilità del TSL, mai bloccare tutte le verifiche per un TSL
 * momentaneamente irraggiungibile).
 */
@Entity('agid_trust_list_cache')
export class AgidTrustListCache {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Certificati X.509 in PEM, uno per CA qualificata trovata nella TSL. */
  @Column({ type: 'jsonb', name: 'certificates_pem' })
  certificatesPem!: string[];

  @UpdateDateColumn({ name: 'fetched_at' })
  fetchedAt!: Date;
}
```

- [ ] **Step 2: Creare la migration**

```ts
// apps/backend/src/database/migrations/1787000000000-CreateAgidTrustListCache.ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAgidTrustListCache1787000000000 implements MigrationInterface {
    name = 'CreateAgidTrustListCache1787000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "agid_trust_list_cache" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "certificates_pem" jsonb NOT NULL,
                "fetched_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_agid_trust_list_cache" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "agid_trust_list_cache"`);
    }
}
```

- [ ] **Step 3: Registrare entity + migration in `database.module.ts`**

Import (dopo la riga `AddPostalAuthorizedUsersTable1786900000000`):

```ts
import { CreateAgidTrustListCache1787000000000 } from './migrations/1787000000000-CreateAgidTrustListCache.js';
import { AgidTrustListCache } from '../entities/agid-trust-list-cache.entity.js';
```

Array `entities:` — aggiungere `AgidTrustListCache` in coda.
Array `migrations:` — aggiungere `CreateAgidTrustListCache1787000000000` in coda.

- [ ] **Step 4: Scrivere il test del service (fallirà — non esiste ancora)**

```ts
// apps/backend/src/signature-verification/agid-trust-list.service.spec.ts
import { vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as forge from 'node-forge';
import { AgidTrustListService } from './agid-trust-list.service.js';
import { AgidTrustListCache } from '../entities/agid-trust-list-cache.entity.js';

// Un piccolo certificato self-signed di test, generato al volo — mai CF/dati reali.
function makeTestCertPem(): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'Test CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  return forge.pki.certificateToPem(cert);
}

describe('AgidTrustListService', () => {
  let service: AgidTrustListService;
  let repo: { findOne: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
  const testCertPem = makeTestCertPem();

  beforeEach(async () => {
    repo = { findOne: vi.fn(), save: vi.fn((v) => Promise.resolve(v)) };
    global.fetch = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgidTrustListService,
        { provide: getRepositoryToken(AgidTrustListCache), useValue: repo },
      ],
    }).compile();

    service = module.get(AgidTrustListService);
  });

  describe('getTrustedCertificates', () => {
    it('ritorna la cache esistente senza fare fetch se già presente e recente', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 'x',
        certificatesPem: [testCertPem],
        fetchedAt: new Date(),
      });

      const result = await service.getTrustedCertificates();

      expect(result).toHaveLength(1);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('fa il refresh se la cache non esiste', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0"?><TrustServiceStatusList></TrustServiceStatusList>`,
      });

      const result = await service.getTrustedCertificates();

      expect(global.fetch).toHaveBeenCalledWith('https://eidas.agid.gov.it/TL/TSL-IT.xml');
      expect(result).toEqual([]);
    });
  });

  describe('refresh', () => {
    it('se il fetch fallisce, mantiene la cache esistente (fail-open)', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 'x',
        certificatesPem: [testCertPem],
        fetchedAt: new Date('2020-01-01'),
      });
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('rete assente'));

      await service.refresh();

      expect(repo.save).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 5: Eseguire il test per verificare che fallisca**

```bash
docker compose exec backend node_modules/.bin/vitest run agid-trust-list.service.spec.ts
```

Expected: FAIL — modulo non esiste.

- [ ] **Step 6: Implementare il service**

```ts
// apps/backend/src/signature-verification/agid-trust-list.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { XMLParser } from 'fast-xml-parser';
import * as forge from 'node-forge';
import { AgidTrustListCache } from '../entities/agid-trust-list-cache.entity.js';

const TSL_URL = 'https://eidas.agid.gov.it/TL/TSL-IT.xml';

/**
 * Estrae i certificati X.509 (base64 DER, dentro <X509Certificate>) dalla
 * TSL-IT.xml (ETSI TS 119612) — parsing "a grep" sui nodi X509Certificate
 * piuttosto che modellare l'intero schema TSL (decine di elementi non
 * rilevanti qui, es. indirizzi/orari di servizio delle CA): ci interessano
 * solo i certificati delle CA qualificate.
 */
function extractCertificatesFromTsl(xml: string): string[] {
  const parser = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === 'X509Certificate' });
  const parsed = parser.parse(xml);
  const certs: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'X509Certificate') {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          if (typeof v === 'string' && v.trim()) certs.push(v.trim());
        }
      } else {
        visit(value);
      }
    }
  };
  visit(parsed);
  return certs;
}

function derBase64ToPem(base64Der: string): string {
  const der = forge.util.decode64(base64Der.replace(/\s+/g, ''));
  const asn1 = forge.asn1.fromDer(der);
  const cert = forge.pki.certificateFromAsn1(asn1);
  return forge.pki.certificateToPem(cert);
}

@Injectable()
export class AgidTrustListService {
  private readonly logger = new Logger(AgidTrustListService.name);

  constructor(
    @InjectRepository(AgidTrustListCache)
    private readonly repo: Repository<AgidTrustListCache>,
  ) {}

  async getTrustedCertificates(): Promise<forge.pki.Certificate[]> {
    let cache = await this.repo.findOne({ where: {}, order: { fetchedAt: 'DESC' } });
    if (!cache) {
      await this.refresh();
      cache = await this.repo.findOne({ where: {}, order: { fetchedAt: 'DESC' } });
    }
    if (!cache) return [];
    return cache.certificatesPem.map((pem) => forge.pki.certificateFromPem(pem));
  }

  /** Refresh giornaliero — fail-open: se il fetch fallisce, la cache esistente resta valida. */
  @Cron('0 3 * * *')
  async refresh(): Promise<void> {
    try {
      const res = await fetch(TSL_URL);
      if (!res.ok) {
        this.logger.warn(`Fetch TSL-IT.xml fallito: HTTP ${res.status}`);
        return;
      }
      const xml = await res.text();
      const certsBase64 = extractCertificatesFromTsl(xml);
      const certificatesPem = certsBase64.map((c) => {
        try {
          return derBase64ToPem(c);
        } catch {
          return null;
        }
      }).filter((c): c is string => c !== null);

      await this.repo.save({ id: 'current', certificatesPem });
      this.logger.log(`TSL-IT aggiornata: ${certificatesPem.length} certificati CA.`);
    } catch (err: any) {
      this.logger.warn(`Refresh TSL-IT fallito, mantengo la cache esistente: ${err?.message ?? err}`);
    }
  }
}
```

Nota: `save({ id: 'current', ... })` funziona come upsert-per-id-fisso solo se
la colonna `id` è impostabile esplicitamente (TypeORM lo permette con
`@PrimaryGeneratedColumn('uuid')` se il valore è fornito). Se il test di
integrazione mostra righe duplicate invece di un upsert, sostituire con
`this.repo.upsert({ id: 'current', certificatesPem }, ['id'])` (stesso
pattern già usato in `OperatorDirectoryService.upsert`).

- [ ] **Step 7: Eseguire il test per verificare che passi**

```bash
docker compose exec backend node_modules/.bin/vitest run agid-trust-list.service.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Creare il modulo**

```ts
// apps/backend/src/signature-verification/signature-verification.module.ts
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgidTrustListCache } from '../entities/agid-trust-list-cache.entity.js';
import { AgidTrustListService } from './agid-trust-list.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AgidTrustListCache])],
  providers: [AgidTrustListService],
  exports: [AgidTrustListService],
})
export class SignatureVerificationModule {}
```

- [ ] **Step 9: Registrare in `app.module.ts`**

```ts
import { SignatureVerificationModule } from './signature-verification/signature-verification.module.js';
```

E nell'array `imports`, accanto agli altri moduli `@Global()`:

```ts
    SignatureVerificationModule,
```

- [ ] **Step 10: Type-check + rebuild + verifica boot**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
docker compose restart backend
docker compose logs backend --tail 30
```

Expected: nessun errore, tabella `agid_trust_list_cache` creata via `synchronize` in dev (`docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "\d agid_trust_list_cache"`).

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/entities/agid-trust-list-cache.entity.ts apps/backend/src/database/migrations/1787000000000-CreateAgidTrustListCache.ts apps/backend/src/database/database.module.ts apps/backend/src/signature-verification apps/backend/src/app.module.ts
git commit -m "feat: AgidTrustListService — fetch/cache TSL-IT.xml"
```

---

## Task 3: `SignatureVerificationService` — verifica crittografica PAdES/CAdES

**Files:**
- Create: `apps/backend/src/signature-verification/signature-verification.service.ts`
- Create: `apps/backend/src/signature-verification/signature-verification.service.spec.ts`
- Create: `apps/backend/src/signature-verification/test-fixtures/generate-fixtures.md` (istruzioni, non un file eseguito)
- Modify: `apps/backend/src/signature-verification/signature-verification.module.ts`

**Interfaces:**
- Consumes: `AgidTrustListService.getTrustedCertificates()` (Task 2).
- Produces: `SignatureVerificationService.verify(buffer: Buffer, filename: string): Promise<SignatureVerificationResult>` dove
  `SignatureVerificationResult = { valid: boolean; reason: string | null; signerCn?: string }` — usata da Task 5 (job massivo) e Task 6 (`launch()`/`launchTestSend()` invio singolo).

- [ ] **Step 1: Scrivere i test con fixture generate al volo (mai file reali committati con dati veri)**

```ts
// apps/backend/src/signature-verification/signature-verification.service.spec.ts
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

function makeP7m(content: Buffer, signerCert: forge.pki.Certificate, signerKeys: forge.pki.rsa.PrivateKey): Buffer {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(content.toString('binary'));
  p7.addCertificate(signerCert);
  p7.addSigner({
    key: signerKeys,
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
```

- [ ] **Step 2: Eseguire i test per verificare che falliscano**

```bash
docker compose exec backend node_modules/.bin/vitest run signature-verification.service.spec.ts
```

Expected: FAIL — modulo non esiste.

- [ ] **Step 3: Implementare il service**

```ts
// apps/backend/src/signature-verification/signature-verification.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as forge from 'node-forge';
import { AgidTrustListService } from './agid-trust-list.service.js';

export interface SignatureVerificationResult {
  valid: boolean;
  reason: string | null;
  signerCn?: string;
}

/**
 * Verifica offline (nessun controllo di revoca OCSP/CRL): integrità
 * crittografica della firma + certificato firmatario riconducibile a una
 * CA nella TSL italiana AgID + certificato non scaduto. Formati supportati:
 * .p7m (CAdES, l'intero file è un envelope PKCS7/CMS) e PDF con firma
 * PAdES embedded (ByteRange/Contents — non ancora implementato in questa
 * versione, vedi TODO Task 4 se serve: per ora un PDF senza wrapper .p7m
 * risulta sempre "non firmato").
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
    const signerCert = p7.certificates[0];

    const now = new Date();
    if (now < signerCert.validity.notBefore || now > signerCert.validity.notAfter) {
      return { valid: false, reason: 'Certificato firmatario scaduto o non ancora valido', signerCn: this.commonName(signerCert) };
    }

    let signatureValid = false;
    try {
      // p7.verify() non esiste nell'API pubblica di node-forge per pkcs7
      // signedData con contenuto detached/embedded in modo uniforme — si
      // verifica manualmente il digest del signer contro il certificato.
      // node-forge espone p7.rawCapture con l'algoritmo firmato: qui
      // usiamo l'approccio documentato dal progetto (vedi
      // node-forge/lib/pkcs7.js verify) tramite p7.verify quando disponibile.
      signatureValid = typeof (p7 as any).verify === 'function' ? (p7 as any).verify() : false;
    } catch (err: any) {
      this.logger.warn(`Verifica crittografica fallita per ${filename}: ${err?.message ?? err}`);
      return { valid: false, reason: 'Integrità della firma non verificata (hash non corrispondente)' };
    }
    if (!signatureValid) {
      return { valid: false, reason: 'Integrità della firma non verificata (hash non corrispondente)' };
    }

    const trustedCerts = await this.trustList.getTrustedCertificates();
    const issuerRecognized = trustedCerts.some((ca) => {
      try {
        return ca.verify(signerCert) || this.sameSubject(ca, signerCert);
      } catch {
        return false;
      }
    });
    if (!issuerRecognized) {
      return { valid: false, reason: 'CA emittente non riconosciuta (non presente nella TSL italiana AgID)', signerCn: this.commonName(signerCert) };
    }

    return { valid: true, reason: null, signerCn: this.commonName(signerCert) };
  }

  private commonName(cert: forge.pki.Certificate): string | undefined {
    return cert.subject.getField('CN')?.value;
  }

  private sameSubject(a: forge.pki.Certificate, b: forge.pki.Certificate): boolean {
    return forge.pki.distinguishedNameToAsn1(a.subject).value === forge.pki.distinguishedNameToAsn1(b.issuer).value;
  }
}
```

**Nota per chi implementa**: l'API `node-forge` per `pkcs7.verify()` va
confermata contro la versione effettivamente installata (`node_modules/.bin` →
leggere `node_modules/node-forge/lib/pkcs7.js` nel container) — l'interfaccia
TypeScript di `@types/node-forge` potrebbe non esporre `verify()` sul tipo
`PkcsSignedData` a seconda della versione. Se assente, implementare la verifica
manuale del digest: estrarre `messageDigest` dagli `authenticatedAttributes`
del signer, calcolare l'hash del contenuto (`p7.content`) con lo stesso
algoritmo, confrontare, poi verificare la firma RSA sugli
`authenticatedAttributes` serializzati con la chiave pubblica di
`signerCert`. Aggiornare i test se l'implementazione manuale cambia il
punto esatto di fallimento intercettato.

- [ ] **Step 4: Eseguire i test per verificare che passino, aggiustando l'implementazione se `p7.verify` non esiste nella versione installata**

```bash
docker compose exec backend node_modules/.bin/vitest run signature-verification.service.spec.ts
```

Expected: PASS (tutti e 4 i casi).

- [ ] **Step 5: Registrare nel modulo**

```ts
// signature-verification.module.ts
import { SignatureVerificationService } from './signature-verification.service.js';
```

```ts
  providers: [AgidTrustListService, SignatureVerificationService],
  exports: [AgidTrustListService, SignatureVerificationService],
```

- [ ] **Step 6: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/signature-verification
git commit -m "feat: SignatureVerificationService — verifica crittografica .p7m contro TSL AgID"
```

---

## Task 4: Colonna `signatureCheck` su `Recipient`

**Files:**
- Modify: `apps/backend/src/entities/recipient.entity.ts`
- Create: `apps/backend/src/database/migrations/1787100000000-AddSignatureCheckToRecipients.ts`
- Modify: `apps/backend/src/database/database.module.ts`

**Interfaces:**
- Produce: `Recipient.signatureCheck: { valid: boolean; reason: string | null; checkedAt: string } | null` — scritta da Task 5 (job massivo) e Task 6 (invio singolo).

- [ ] **Step 1: Aggiungere la colonna all'entity**

In `apps/backend/src/entities/recipient.entity.ts`, subito dopo il blocco `inadCheck`:

```ts
  @Column({ type: 'jsonb', name: 'signature_check', nullable: true })
  signatureCheck!: {
    valid: boolean;
    reason: string | null;
    checkedAt: string;
  } | null;
```

- [ ] **Step 2: Creare la migration**

```ts
// apps/backend/src/database/migrations/1787100000000-AddSignatureCheckToRecipients.ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSignatureCheckToRecipients1787100000000 implements MigrationInterface {
    name = 'AddSignatureCheckToRecipients1787100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recipients" ADD "signature_check" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recipients" DROP COLUMN "signature_check"`);
    }
}
```

- [ ] **Step 3: Registrare la migration in `database.module.ts`**

```ts
import { AddSignatureCheckToRecipients1787100000000 } from './migrations/1787100000000-AddSignatureCheckToRecipients.js';
```

Array `migrations:` — aggiungere in coda.

- [ ] **Step 4: Verificare boot + colonna in dev**

```bash
docker compose restart backend
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "\d recipients" | grep signature_check
```

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/entities/recipient.entity.ts apps/backend/src/database/migrations/1787100000000-AddSignatureCheckToRecipients.ts apps/backend/src/database/database.module.ts
git commit -m "feat: colonna signature_check su Recipient"
```

---

## Task 5: Job BullMQ massivo + entity + controller

**Files:**
- Create: `apps/backend/src/entities/signature-verification-job.entity.ts`
- Create: `apps/backend/src/database/migrations/1787200000000-CreateSignatureVerificationJobs.ts`
- Modify: `apps/backend/src/database/database.module.ts`
- Create: `apps/backend/src/signature-verification/signature-verification-job.types.ts`
- Create: `apps/backend/src/signature-verification/signature-verification.processor.ts`
- Create: `apps/backend/src/signature-verification/signature-verification.processor.spec.ts`
- Create: `apps/backend/src/signature-verification/signature-verification-bulk.service.ts`
- Create: `apps/backend/src/signature-verification/signature-verification-bulk.service.spec.ts`
- Create: `apps/backend/src/signature-verification/signature-verification.controller.ts`
- Modify: `apps/backend/src/signature-verification/signature-verification.module.ts`

**Interfaces:**
- Consumes: `SignatureVerificationService.verify()` (Task 3), `resolveCustomAttachmentFilename`/`resolveAttachmentsConfig` (`attachment.service.ts`, esistenti), `getUploadsDir` (`attachment-paths.ts`, esistente).
- Produces: `SignatureVerificationBulkService.startForCampaign(campaignId): Promise<{jobId: string}>`, `.getLatestStatus(campaignId): Promise<SignatureVerificationJobStatusDto | null>` — usate da Task 6 (`launch()`) e dal frontend (Task 7) via `POST/GET admin/campaigns/:id/signature-verification`.

- [ ] **Step 1: Creare l'entity**

```ts
// apps/backend/src/entities/signature-verification-job.entity.ts
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum SignatureVerificationJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

@Entity('signature_verification_jobs')
export class SignatureVerificationJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'campaign_id' })
  campaignId!: string;

  @Column({ type: 'enum', enum: SignatureVerificationJobStatus, default: SignatureVerificationJobStatus.QUEUED })
  status!: SignatureVerificationJobStatus;

  @Column({ name: 'total_rows', type: 'int', default: 0 })
  totalRows!: number;

  @Column({ name: 'valid_count', type: 'int', default: 0 })
  validCount!: number;

  @Column({ name: 'invalid_count', type: 'int', default: 0 })
  invalidCount!: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
```

- [ ] **Step 2: Migration**

```ts
// apps/backend/src/database/migrations/1787200000000-CreateSignatureVerificationJobs.ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSignatureVerificationJobs1787200000000 implements MigrationInterface {
    name = 'CreateSignatureVerificationJobs1787200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "signature_verification_jobs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "campaign_id" uuid NOT NULL,
                "status" character varying NOT NULL DEFAULT 'queued',
                "total_rows" int NOT NULL DEFAULT 0,
                "valid_count" int NOT NULL DEFAULT 0,
                "invalid_count" int NOT NULL DEFAULT 0,
                "error_message" text,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                "completed_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_signature_verification_jobs" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`CREATE INDEX "IDX_signature_verification_jobs_campaign_id" ON "signature_verification_jobs" ("campaign_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "signature_verification_jobs"`);
    }
}
```

Nota: `status` è `character varying` con default stringa, non un vero
`enum` Postgres — evita il gotcha "ALTER TYPE ADD VALUE" già documentato
in CLAUDE.md per futuri nuovi stati, a costo di perdere la validazione a
livello DB (già accettabile altrove in questo repo, es.
`AppIoVerificationJob`... verificare comunque coerenza con
`InadVerificationJobStatus` che usa `type: 'enum'` — se si preferisce
coerenza, usare `type: 'enum', enum: ['queued','processing','done','failed']`
nella entity e nella migration `CREATE TYPE ... AS ENUM (...)` +
`ADD COLUMN ... USING`).

- [ ] **Step 3: Registrare entity + migration in `database.module.ts`** (stesso pattern Task 2 Step 3)

- [ ] **Step 4: Creare i tipi coda**

```ts
// apps/backend/src/signature-verification/signature-verification-job.types.ts
export const SIGNATURE_VERIFICATION_QUEUE = 'signature-verification-jobs';

export interface SignatureVerificationQueueJobData {
  jobId: string;
  campaignId: string;
}
```

- [ ] **Step 5: Scrivere il test del bulk service (fallirà)**

```ts
// apps/backend/src/signature-verification/signature-verification-bulk.service.spec.ts
import { vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { SignatureVerificationBulkService } from './signature-verification-bulk.service.js';
import { SignatureVerificationJob, SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { SIGNATURE_VERIFICATION_QUEUE } from './signature-verification-job.types.js';

describe('SignatureVerificationBulkService', () => {
  let service: SignatureVerificationBulkService;
  let jobRepo: { create: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> };
  let queue: { add: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    jobRepo = {
      create: vi.fn((v) => v),
      save: vi.fn((v) => Promise.resolve({ id: 'job-1', ...v })),
      findOne: vi.fn(),
    };
    queue = { add: vi.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SignatureVerificationBulkService,
        { provide: getRepositoryToken(SignatureVerificationJob), useValue: jobRepo },
        { provide: getQueueToken(SIGNATURE_VERIFICATION_QUEUE), useValue: queue },
      ],
    }).compile();

    service = module.get(SignatureVerificationBulkService);
  });

  describe('startForCampaign', () => {
    it('crea un nuovo job e lo accoda', async () => {
      const result = await service.startForCampaign('camp-1');

      expect(jobRepo.save).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 'camp-1', status: SignatureVerificationJobStatus.QUEUED }));
      expect(queue.add).toHaveBeenCalledWith('verify', { jobId: 'job-1', campaignId: 'camp-1' }, { jobId: 'job-1' });
      expect(result).toEqual({ jobId: 'job-1' });
    });
  });

  describe('getLatestStatus', () => {
    it('ritorna null se nessun job esiste per la campagna', async () => {
      jobRepo.findOne.mockResolvedValueOnce(null);
      const result = await service.getLatestStatus('camp-1');
      expect(result).toBeNull();
    });

    it('ritorna lo stato dell\'ultimo job per la campagna', async () => {
      jobRepo.findOne.mockResolvedValueOnce({
        id: 'job-1', campaignId: 'camp-1', status: SignatureVerificationJobStatus.DONE,
        totalRows: 10, validCount: 9, invalidCount: 1, errorMessage: null,
      });
      const result = await service.getLatestStatus('camp-1');
      expect(result).toEqual(expect.objectContaining({ status: SignatureVerificationJobStatus.DONE, invalidCount: 1 }));
    });
  });
});
```

- [ ] **Step 6: Eseguire il test per verificare che fallisca, poi implementare il bulk service**

```ts
// apps/backend/src/signature-verification/signature-verification-bulk.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import { SignatureVerificationJob, SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { SIGNATURE_VERIFICATION_QUEUE, SignatureVerificationQueueJobData } from './signature-verification-job.types.js';

export interface SignatureVerificationJobStatusDto {
  status: SignatureVerificationJobStatus;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  errorMessage: string | null;
}

@Injectable()
export class SignatureVerificationBulkService {
  constructor(
    @InjectRepository(SignatureVerificationJob)
    private readonly jobRepo: Repository<SignatureVerificationJob>,
    @InjectQueue(SIGNATURE_VERIFICATION_QUEUE)
    private readonly queue: Queue<SignatureVerificationQueueJobData>,
  ) {}

  async startForCampaign(campaignId: string): Promise<{ jobId: string }> {
    const entity = this.jobRepo.create({ campaignId, status: SignatureVerificationJobStatus.QUEUED });
    const saved = await this.jobRepo.save(entity);
    await this.queue.add('verify', { jobId: saved.id, campaignId }, { jobId: saved.id });
    return { jobId: saved.id };
  }

  async getLatestStatus(campaignId: string): Promise<SignatureVerificationJobStatusDto | null> {
    const job = await this.jobRepo.findOne({ where: { campaignId }, order: { createdAt: 'DESC' } });
    if (!job) return null;
    return {
      status: job.status,
      totalRows: job.totalRows,
      validCount: job.validCount,
      invalidCount: job.invalidCount,
      errorMessage: job.errorMessage,
    };
  }
}
```

```bash
docker compose exec backend node_modules/.bin/vitest run signature-verification-bulk.service.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Scrivere il test del processor (fallirà)**

```ts
// apps/backend/src/signature-verification/signature-verification.processor.spec.ts
import { vi } from 'vitest';
import { SignatureVerificationProcessor } from './signature-verification.processor.js';
import { SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { RecipientStatus } from '../entities/recipient.entity.js';

describe('SignatureVerificationProcessor', () => {
  let processor: SignatureVerificationProcessor;
  let jobRepo: { findOneBy: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let campaignRepo: { findOneBy: ReturnType<typeof vi.fn> };
  let recipientRepo: { find: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let verificationService: { verify: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    jobRepo = { findOneBy: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };
    campaignRepo = { findOneBy: vi.fn() };
    recipientRepo = { find: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };
    verificationService = { verify: vi.fn() };

    processor = new SignatureVerificationProcessor(
      jobRepo as any,
      campaignRepo as any,
      recipientRepo as any,
      verificationService as any,
    );
  });

  it('verifica ogni destinatario, aggiorna signatureCheck e i contatori del job', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'camp-1', channelConfig: { attachments: [{ key: 'doc', label: 'Documento' }] } });
    recipientRepo.find.mockResolvedValue([
      { id: 'r1', status: RecipientStatus.PENDING, extraData: { doc: 'firmato.p7m' } },
      { id: 'r2', status: RecipientStatus.PENDING, extraData: { doc: 'nonfirmato.p7m' } },
    ]);
    verificationService.verify
      .mockResolvedValueOnce({ valid: true, reason: null })
      .mockResolvedValueOnce({ valid: false, reason: 'CA non riconosciuta' });

    await processor.process({ data: { jobId: 'job-1', campaignId: 'camp-1' } } as any);

    expect(recipientRepo.update).toHaveBeenCalledWith({ id: 'r1' }, expect.objectContaining({ signatureCheck: expect.objectContaining({ valid: true }) }));
    expect(recipientRepo.update).toHaveBeenCalledWith({ id: 'r2' }, expect.objectContaining({ signatureCheck: expect.objectContaining({ valid: false }) }));
    expect(jobRepo.update).toHaveBeenCalledWith({ id: 'job-1' }, expect.objectContaining({
      status: SignatureVerificationJobStatus.DONE,
      totalRows: 2,
      validCount: 1,
      invalidCount: 1,
    }));
  });

  it('marca il job FAILED se il file allegato non si trova su disco', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'camp-1', channelConfig: {} });
    recipientRepo.find.mockResolvedValue([{ id: 'r1', status: RecipientStatus.PENDING, extraData: {} }]);

    await processor.process({ data: { jobId: 'job-1', campaignId: 'camp-1' } } as any);

    // Nessun allegato configurato -> 0 righe da verificare, job comunque DONE con 0/0.
    expect(jobRepo.update).toHaveBeenCalledWith({ id: 'job-1' }, expect.objectContaining({ status: SignatureVerificationJobStatus.DONE, totalRows: 0 }));
  });
});
```

- [ ] **Step 8: Implementare il processor**

```ts
// apps/backend/src/signature-verification/signature-verification.processor.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import * as fs from 'fs';
import { join } from 'path';
import { SignatureVerificationJob, SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient, RecipientStatus } from '../entities/recipient.entity.js';
import { SIGNATURE_VERIFICATION_QUEUE, SignatureVerificationQueueJobData } from './signature-verification-job.types.js';
import { SignatureVerificationService } from './signature-verification.service.js';
import { resolveAttachmentsConfig, resolveCustomAttachmentFilename } from '../attachments/attachment.service.js';
import { getUploadsDir } from '../attachments/attachment-paths.js';
import { captureException } from '../common/sentry.util.js';

@Injectable()
@Processor(SIGNATURE_VERIFICATION_QUEUE)
export class SignatureVerificationProcessor extends WorkerHost {
  private readonly logger = new Logger(SignatureVerificationProcessor.name);

  constructor(
    @InjectRepository(SignatureVerificationJob)
    private readonly jobRepo: Repository<SignatureVerificationJob>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    private readonly verificationService: SignatureVerificationService,
  ) {
    super();
  }

  async process(job: Job<SignatureVerificationQueueJobData>): Promise<void> {
    const { jobId, campaignId } = job.data;
    try {
      await this.jobRepo.update({ id: jobId }, { status: SignatureVerificationJobStatus.PROCESSING });

      const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
      if (!campaign) {
        await this.jobRepo.update({ id: jobId }, { status: SignatureVerificationJobStatus.FAILED, errorMessage: 'Campagna non trovata', completedAt: new Date() });
        return;
      }

      const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
      const recipients = await this.recipientRepo.find({
        where: { campaignId, status: RecipientStatus.PENDING },
        select: { id: true, extraData: true },
      });

      let validCount = 0;
      let invalidCount = 0;
      const dir = getUploadsDir(campaignId);

      for (const recipient of recipients) {
        // Un solo allegato per SEND nella pratica comune, ma il ciclo copre
        // eventuali slot multipli configurati — basta un allegato non
        // valido per marcare il destinatario invalid.
        let recipientValid = attachmentsConfig.length > 0;
        let recipientReason: string | null = null;

        for (let index = 0; index < attachmentsConfig.length; index++) {
          const filename = resolveCustomAttachmentFilename({ campaign, extraData: recipient.extraData } as unknown as Recipient, index);
          if (!filename) {
            recipientValid = false;
            recipientReason = 'Allegato non configurato per questo destinatario';
            break;
          }
          const filePath = join(dir, filename);
          if (!fs.existsSync(filePath)) {
            recipientValid = false;
            recipientReason = `Allegato ${filename} non trovato su disco`;
            break;
          }
          const buffer = fs.readFileSync(filePath);
          const result = await this.verificationService.verify(buffer, filename);
          if (!result.valid) {
            recipientValid = false;
            recipientReason = result.reason;
            break;
          }
        }

        if (attachmentsConfig.length === 0) {
          recipientValid = false;
          recipientReason = 'Nessun allegato configurato per SEND';
        }

        await this.recipientRepo.update(
          { id: recipient.id },
          { signatureCheck: { valid: recipientValid, reason: recipientReason, checkedAt: new Date().toISOString() } },
        );

        if (recipientValid) validCount++;
        else invalidCount++;
      }

      await this.jobRepo.update(
        { id: jobId },
        {
          status: SignatureVerificationJobStatus.DONE,
          totalRows: recipients.length,
          validCount,
          invalidCount,
          completedAt: new Date(),
        },
      );
    } catch (err: any) {
      this.logger.error(`Job verifica firma ${jobId} fallito: ${err?.message ?? err}`);
      captureException(err);
      await this.jobRepo.update({ id: jobId }, { status: SignatureVerificationJobStatus.FAILED, errorMessage: err?.message ?? 'Errore sconosciuto', completedAt: new Date() });
    }
  }
}
```

Nota: il test Step 7 caso 2 (attachmentsConfig vuoto) si aspetta
`totalRows: 0` ma l'implementazione sopra itera comunque `recipients`
(1 elemento) marcandolo invalid — **allineare test e implementazione**:
se il canale non ha alcun allegato configurato, è più corretto marcare
comunque 0 righe verificabili con `totalRows: recipients.length` e
`invalidCount: recipients.length` (il destinatario esiste ma non è
verificabile) — aggiornare l'asserzione del test Step 7 caso 2 a
`invalidCount: 1` invece di assumere `totalRows: 0`, oppure decidere
esplicitamente durante l'implementazione quale semantica adottare e
tenere test e codice coerenti.

- [ ] **Step 9: Eseguire entrambi i test per verificare che passino (aggiustando l'asserzione della nota sopra)**

```bash
docker compose exec backend node_modules/.bin/vitest run signature-verification.processor.spec.ts signature-verification-bulk.service.spec.ts
```

- [ ] **Step 10: Creare il controller**

```ts
// apps/backend/src/signature-verification/signature-verification.controller.ts
import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { SignatureVerificationBulkService } from './signature-verification-bulk.service.js';

@Controller('admin/campaigns/:id/signature-verification')
@Roles('user', 'admin')
export class SignatureVerificationController {
  constructor(private readonly bulkService: SignatureVerificationBulkService) {}

  @Post()
  start(@Param('id', ParseUUIDPipe) id: string) {
    return this.bulkService.startForCampaign(id);
  }

  @Get()
  async status(@Param('id', ParseUUIDPipe) id: string) {
    const status = await this.bulkService.getLatestStatus(id);
    if (!status) throw new NotFoundException('Nessuna verifica firma avviata per questa campagna');
    return status;
  }
}
```

- [ ] **Step 11: Aggiornare il modulo**

```ts
// signature-verification.module.ts — versione finale
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { AgidTrustListCache } from '../entities/agid-trust-list-cache.entity.js';
import { SignatureVerificationJob } from '../entities/signature-verification-job.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { AgidTrustListService } from './agid-trust-list.service.js';
import { SignatureVerificationService } from './signature-verification.service.js';
import { SignatureVerificationBulkService } from './signature-verification-bulk.service.js';
import { SignatureVerificationProcessor } from './signature-verification.processor.js';
import { SignatureVerificationController } from './signature-verification.controller.js';
import { SIGNATURE_VERIFICATION_QUEUE } from './signature-verification-job.types.js';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([AgidTrustListCache, SignatureVerificationJob, Campaign, Recipient]),
    BullModule.registerQueue({ name: SIGNATURE_VERIFICATION_QUEUE }),
  ],
  controllers: [SignatureVerificationController],
  providers: [AgidTrustListService, SignatureVerificationService, SignatureVerificationBulkService, SignatureVerificationProcessor],
  exports: [AgidTrustListService, SignatureVerificationService, SignatureVerificationBulkService],
})
export class SignatureVerificationModule {}
```

- [ ] **Step 12: Type-check, boot, suite completa**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
docker compose restart backend
docker compose logs backend --tail 30
docker compose exec backend node_modules/.bin/vitest run
```

Expected: nessun nuovo fallimento oltre la baseline nota.

- [ ] **Step 13: Commit**

```bash
git add apps/backend/src/entities/signature-verification-job.entity.ts apps/backend/src/database/migrations/1787200000000-CreateSignatureVerificationJobs.ts apps/backend/src/database/database.module.ts apps/backend/src/signature-verification
git commit -m "feat: job BullMQ verifica firma massiva + endpoint start/status"
```

---

## Task 6: Enforcement in `launch()`/`launchTestSend()`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts` (nessun cambio di firma, solo verificare che il nuovo campo passi nella risposta)

**Interfaces:**
- Consumes: `SignatureVerificationService.verify()` (Task 3), `SignatureVerificationBulkService.getLatestStatus()` (Task 5).
- Produces: `launch()`/`launchTestSend()` guadagnano un campo `signatureWarning?: string` (non bloccante, solo invio singolo) nella risposta esistente; per invio massivo SEND, blocco `{blocked:true}` se la verifica non è `done`/`invalidCount===0`.

- [ ] **Step 1: Scrivere i test (falliranno)**

Aggiungere in `campaigns.service.spec.ts`, vicino ai test SEND esistenti:

```ts
  it('launch(): SEND massivo bloccato se la verifica firma non è mai stata avviata', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({
      ...mockCampaign,
      channelType: 'SEND',
      channelConfig: { protocolla: true, attachments: [{ key: 'doc', label: 'Documento' }], wizSingleMode: false },
    });
    mockSignatureVerificationBulkService.getLatestStatus.mockResolvedValueOnce(null);

    const result = await service.launch('c-send-nosig', ADMIN_REQUESTER);

    expect(result.blocked).toBe(true);
    expect(result.message).toContain('Verifica firma');
  });

  it('launch(): SEND massivo bloccato se la verifica ha trovato allegati non validi', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({
      ...mockCampaign,
      channelType: 'SEND',
      channelConfig: { protocolla: true, attachments: [{ key: 'doc', label: 'Documento' }], wizSingleMode: false },
    });
    mockSignatureVerificationBulkService.getLatestStatus.mockResolvedValueOnce({
      status: 'done', totalRows: 5, validCount: 4, invalidCount: 1, errorMessage: null,
    });

    const result = await service.launch('c-send-invalid', ADMIN_REQUESTER);

    expect(result.blocked).toBe(true);
    expect(result.message).toContain('1');
  });

  it('launch(): SEND singolo NON bloccato da firma non valida, solo warning', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({
      ...mockCampaign,
      channelType: 'SEND',
      channelConfig: { protocolla: true, attachments: [{ key: 'doc', label: 'Documento' }], wizSingleMode: true },
    });
    mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1', extraData: { doc: 'nonfirmato.p7m' } }]);
    mockSignatureVerificationService.verify.mockResolvedValueOnce({ valid: false, reason: 'CA non riconosciuta' });

    const result = await service.launch('c-send-single', ADMIN_REQUESTER);

    expect(result.blocked).toBeUndefined();
    expect(result.signatureWarning).toContain('CA non riconosciuta');
  });
```

Dichiarare i mock condivisi vicino ad `ADMIN_REQUESTER`/`mockPostalAuthorizedUsersService` (top-level, visibili da tutti i describe):

```ts
const mockSignatureVerificationBulkService = { getLatestStatus: vi.fn().mockResolvedValue({ status: 'done', totalRows: 0, validCount: 0, invalidCount: 0, errorMessage: null }) };
const mockSignatureVerificationService = { verify: vi.fn().mockResolvedValue({ valid: true, reason: null }) };
```

E aggiungerli ai 12 `Test.createTestingModule` (stesso sed pattern già usato per `PostalAuthorizedUsersService`):

```bash
sed -i 's/^        CampaignsService,$/        CampaignsService,\n        { provide: SignatureVerificationBulkService, useValue: mockSignatureVerificationBulkService },\n        { provide: SignatureVerificationService, useValue: mockSignatureVerificationService },/' apps/backend/src/campaigns/campaigns.service.spec.ts
```

Import in cima al file:

```ts
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationService } from '../signature-verification/signature-verification.service.js';
```

E lo stesso trattamento (solo `SignatureVerificationBulkService`/`SignatureVerificationService` con `useValue: { getLatestStatus: vi.fn().mockResolvedValue(...), verify: vi.fn().mockResolvedValue(...) }`) in `campaigns.service.cost.spec.ts`.

- [ ] **Step 2: Eseguire i nuovi test per verificare che falliscano**

```bash
docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec.ts -t "firma"
```

- [ ] **Step 3: Aggiungere le dipendenze al costruttore di `CampaignsService`**

```ts
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationService } from '../signature-verification/signature-verification.service.js';
import { SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
```

```ts
    private readonly postalAuthorizedUsers: PostalAuthorizedUsersService,
    private readonly signatureVerificationBulk: SignatureVerificationBulkService,
    private readonly signatureVerification: SignatureVerificationService,
  ) {}
```

- [ ] **Step 4: Aggiungere il controllo in `launch()`**

Firma di ritorno aggiornata:

```ts
  async launch(
    campaignId: string,
    requester: CampaignRequester,
  ): Promise<{ launched: number; campaignId: string; blocked?: boolean; message?: string; signatureWarning?: string }> {
```

Subito dopo il blocco di controllo autorizzazione POSTAL già esistente (prima di `assertSendProtocolConfigured`):

```ts
    let signatureWarning: string | undefined;
    if (campaign.channelType === 'SEND') {
      const isWizSingle = campaign.channelConfig?.['wizSingleMode'] === true;
      if (isWizSingle) {
        // Invio singolo: un solo destinatario/allegato, verifica sincrona non bloccante.
        const singleRecipients = await this.recipientRepo.find({
          where: { campaignId, status: RecipientStatus.PENDING },
          select: { id: true, extraData: true },
        });
        const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
        if (singleRecipients.length > 0 && attachmentsConfig.length > 0) {
          const filename = resolveCustomAttachmentFilename(
            { campaign, extraData: singleRecipients[0].extraData } as unknown as Recipient,
            0,
          );
          if (filename) {
            const filePath = join(getUploadsDir(campaignId), filename);
            if (fs.existsSync(filePath)) {
              const result = await this.signatureVerification.verify(fs.readFileSync(filePath), filename);
              if (!result.valid) signatureWarning = `Allegato non firmato correttamente: ${result.reason}`;
            }
          }
        }
      } else {
        // Invio massivo: bloccante finché la verifica non è done con invalidCount 0.
        const verificationStatus = await this.signatureVerificationBulk.getLatestStatus(campaignId);
        if (!verificationStatus || verificationStatus.status !== SignatureVerificationJobStatus.DONE) {
          await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
          return {
            launched: 0,
            campaignId,
            blocked: true,
            message: 'Verifica firma digitale allegati in corso o mai avviata. Attendi il completamento prima di lanciare.',
          };
        }
        if (verificationStatus.invalidCount > 0) {
          await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
          return {
            launched: 0,
            campaignId,
            blocked: true,
            message: `${verificationStatus.invalidCount} allegato/i non risultano firmati validamente. Correggi i file prima di rilanciare.`,
          };
        }
      }
    }
```

E nel `return` finale del metodo:

```ts
    const { launched } = await this.createAttemptsAndEnqueue(campaign, recipients, channelOverrides);
    return { launched, campaignId, signatureWarning };
```

(verificare tutti i `return { launched, campaignId }` esistenti nel metodo — aggiungere `signatureWarning` a ciascuno, non solo all'ultimo, per non perderlo sui path INAD bulk/wizard singolo che ritornano prima).

- [ ] **Step 5: Stesso controllo (solo ramo invio singolo, `launchTestSend` è sempre singolo) in `launchTestSend()`**

Firma aggiornata: aggiungere `signatureWarning?: string` al tipo di ritorno. Subito dopo il blocco di autorizzazione POSTAL già esistente, prima di `assertSendProtocolConfigured(parent)`:

```ts
    let signatureWarning: string | undefined;
    if (parent.channelType === 'SEND') {
      // launchTestSend crea/riusa sempre un solo destinatario di test — verifica sempre sincrona.
      const attachmentsConfig = resolveAttachmentsConfig(parent.channelConfig);
      if (attachmentsConfig.length > 0 && dto.extraData) {
        const filename = resolveCustomAttachmentFilename({ campaign: parent, extraData: dto.extraData } as unknown as Recipient, 0);
        if (filename) {
          const filePath = join(getUploadsDir(parentCampaignId), filename);
          if (fs.existsSync(filePath)) {
            const result = await this.signatureVerification.verify(fs.readFileSync(filePath), filename);
            if (!result.valid) signatureWarning = `Allegato non firmato correttamente: ${result.reason}`;
          }
        }
      }
    }
```

E propagare `signatureWarning` nel `return` finale del metodo (dopo la creazione dell'attempt riuscita).

- [ ] **Step 6: Aggiornare i 12+1 provider mock e verificare gli import `resolveAttachmentsConfig`/`resolveCustomAttachmentFilename`/`getUploadsDir`/`join`/`fs` già presenti in `campaigns.service.ts` (dovrebbero esserlo già, usati da `checkAttachmentsBlocking`)**

- [ ] **Step 7: Eseguire i nuovi test, poi la suite completa**

```bash
docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec.ts -t "firma"
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
docker compose exec backend node_modules/.bin/vitest run
```

Expected: PASS, nessun nuovo fallimento oltre la baseline nota.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns
git commit -m "feat: enforcement verifica firma in launch()/launchTestSend()"
```

---

## Task 7: Frontend — trigger job massivo + polling + gate lancio

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `POST/GET admin/campaigns/:id/signature-verification` (Task 5).

- [ ] **Step 1: Nuovo stato, accanto a `wizAttachments`**

```ts
  const [wizSignatureJobStatus, setWizSignatureJobStatus] = useState<{ status: string; totalRows: number; validCount: number; invalidCount: number; errorMessage: string | null } | null>(null);
```

- [ ] **Step 2: Trigger dopo upload allegati riuscito, in `handleWizUploadAttachments`**

Dentro `handleWizUploadAttachments`, subito dopo il blocco `if (wizPdfFiles && wizPdfFiles.length > 0) { ... }` (dopo `setWizPdfFiles([])` e il reset dell'input), aggiungere:

```ts
        if (wizChannel === 'SEND' && !wizSingleMode) {
          apiFetch(`/campaigns/${campaignId}/signature-verification`, { method: 'POST' }).catch(() => undefined);
        }
```

- [ ] **Step 3: Polling dello stato, useEffect dedicato**

Vicino agli altri `useEffect` di polling (es. quello di `wizAttachmentProgress`):

```ts
  useEffect(() => {
    if (!(wizChannel === 'SEND' && !wizSingleMode && wizCampaignId && (wizStep === 6 || wizStep === 7))) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await apiFetch(`/campaigns/${wizCampaignId}/signature-verification`);
        if (!cancelled && res.ok) {
          setWizSignatureJobStatus(await res.json());
        }
      } catch {
        // silenzioso: stesso principio del polling stato campagna esistente
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [wizChannel, wizSingleMode, wizCampaignId, wizStep]);
```

- [ ] **Step 4: Pannello di stato, prima dei bottoni "Avvia Test"/"Lancia"**

Individuare il blocco JSX che precede i bottoni finali (contesto già noto: subito prima di `onClick={handleWizLaunch}`, entrambe le occorrenze — cercare `<TestTube className="me-1" size={16} />Avvia Test` per la posizione esatta in ciascuna copia) e inserire, in ENTRAMBE le occorrenze:

```tsx
                      {wizChannel === 'SEND' && !wizSingleMode && (
                        <div className={`alert ${wizSignatureJobStatus?.status === 'done' && wizSignatureJobStatus.invalidCount === 0 ? 'alert-success' : 'alert-warning'} d-flex align-items-center gap-2 mb-3`}>
                          {!wizSignatureJobStatus ? (
                            <>Verifica firma digitale allegati in corso...</>
                          ) : wizSignatureJobStatus.status !== 'done' ? (
                            <><Loader2 className="icon-spin" size={16} /> Verifica firma digitale in corso...</>
                          ) : wizSignatureJobStatus.invalidCount > 0 ? (
                            <><AlertTriangle size={16} /> {wizSignatureJobStatus.invalidCount} allegato/i non firmati validamente su {wizSignatureJobStatus.totalRows} — correggi i file prima di lanciare.</>
                          ) : (
                            <><CheckCircle2 size={16} /> Tutti gli allegati ({wizSignatureJobStatus.totalRows}) risultano firmati validamente.</>
                          )}
                        </div>
                      )}
```

- [ ] **Step 5: Gate del bottone "Lancia" — ENTRAMBE le occorrenze (gotcha bottoni duplicati)**

Cambiare (in entrambi i punti):

```tsx
                        disabled={wizSending || (wizSingleMode && !wizSingleNeedsTemplateStep && !wizSubject.trim())}
```

in:

```tsx
                        disabled={wizSending || (wizSingleMode && !wizSingleNeedsTemplateStep && !wizSubject.trim()) || (wizChannel === 'SEND' && !wizSingleMode && (!wizSignatureJobStatus || wizSignatureJobStatus.status !== 'done' || wizSignatureJobStatus.invalidCount > 0))}
```

- [ ] **Step 6: Reset dello stato in `resetWizard()` e ripristino in `prefillWizardFrom()`**

Cercare le funzioni `resetWizard`/`prefillWizardFrom` esistenti (gotcha CLAUDE.md: ogni nuovo stato `wiz*` va azzerato/ripristinato in entrambe) e aggiungere `setWizSignatureJobStatus(null)` in `resetWizard()`. `prefillWizardFrom()` non necessita ripristino (lo stato si ripopola dal primo poll appena la campagna riprende lo step 6/7).

- [ ] **Step 7: Type-check + lint**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker compose exec frontend-admin node_modules/.bin/eslint .
```

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat: trigger + polling verifica firma massiva nel wizard, gate lancio"
```

---

## Task 8: Frontend — avviso non bloccante invio singolo + badge dettaglio campagna

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `signatureWarning` da `launch()`/`launchTestSend()` (Task 6), `Recipient.signatureCheck` esposto nel dettaglio destinatari (verificare che il DTO di `getRecipientsPage`/`getRecipientStats` in `campaigns.service.ts` includa già `signatureCheck` nella `select` — se non lo fa, aggiungerlo qui come step preliminare).

- [ ] **Step 1: Verificare/estendere la select dei destinatari per esporre `signatureCheck`**

Cercare `getRecipientsPage`/`getRecipientStats` in `campaigns.service.ts` (`select: { ... }`), aggiungere `signatureCheck: true` se il campo non è già incluso. Aggiornare il tipo TypeScript del risultato lato backend e il tipo `recipientsPage` in frontend (riga con `costCents?: number | null; ...`) aggiungendo `signatureCheck?: { valid: boolean; reason: string | null } | null`.

- [ ] **Step 2: Banner non bloccante dopo "Avvia Test"/"Lancia" (invio singolo)**

Nei gestori `handleWizSingleTestSubmit`/`handleWizLaunch` (dove si legge `data.blocked`/`data.message` dalla risposta), aggiungere lettura di `data.signatureWarning` e mostrarlo con un `alert()` non bloccante dopo il successo (stesso pattern già usato per `discardCount` in `handleWizUploadAttachments`):

```ts
      if (data.signatureWarning) {
        alert(`Attenzione: ${data.signatureWarning}`);
      }
```

- [ ] **Step 3: Badge "Firma non valida" nella tabella destinatari del dettaglio campagna**

Cercare la colonna "Errore"/badge esistente per POSTAL/SEND nella tabella destinatari (dettaglio campagna) e aggiungere, per riga con `r.signatureCheck?.valid === false`:

```tsx
                        {r.signatureCheck?.valid === false && (
                          <span className="badge bg-danger-subtle text-danger border border-danger-subtle ms-1" title={r.signatureCheck.reason ?? ''}>
                            Firma non valida
                          </span>
                        )}
```

- [ ] **Step 4: Type-check + lint**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker compose exec frontend-admin node_modules/.bin/eslint .
```

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx apps/backend/src/campaigns/campaigns.service.ts
git commit -m "feat: avviso firma non bloccante invio singolo + badge dettaglio campagna"
```

---

## Task 9: Verifica finale end-to-end

- [ ] **Step 1: Suite backend completa**

```bash
docker compose exec backend node_modules/.bin/vitest run
```

Expected: stesso failure set della baseline nota, zero nuovi fallimenti.

- [ ] **Step 2: Type-check backend + frontend completi**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker compose exec frontend-admin node_modules/.bin/eslint .
```

- [ ] **Step 3: Test manuale end-to-end con un vero `.p7m`**

Generare un `.p7m` di test firmato con un certificato reale se disponibile
(o un self-signed per verificare il ramo "CA non riconosciuta"), caricarlo
su una campagna SEND massiva di test, verificare via UI che il pannello di
stato mostri il progresso e che il bottone "Lancia" resti disabilitato
finché il job non è `done`.

- [ ] **Step 4: Verificare la migration in produzione-simulata**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_test" backend node_modules/.bin/typeorm-ts-node-esm migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d migration_test -c "\d agid_trust_list_cache"
docker compose exec postgres psql -U comunicapa -d migration_test -c "\d signature_verification_jobs"
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test;"
```

- [ ] **Step 5: Commit finale (se emergono fix durante la verifica) + push + PR**

```bash
git add -A
git commit -m "test: verifica end-to-end verifica firma digitale SEND" --allow-empty
git push
```

La PR #65 è già aperta (draft) — rimuovere lo stato draft quando il piano è completo:

```bash
gh pr ready 65
```

Verificare che il check `run-tests` sulla PR sia verde prima di chiedere review/merge.
