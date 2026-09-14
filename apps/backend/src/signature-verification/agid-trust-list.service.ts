import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { XMLParser } from 'fast-xml-parser';
import forge from 'node-forge';
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

      // Bug reale corretto: `id` è `@PrimaryGeneratedColumn('uuid')` — un
      // save con `id: 'current'` falliva sempre con "invalid input syntax
      // for type uuid" (fail-open lo inghiottiva in un warn, la cache
      // restava vuota per sempre, mai scoperto perché i test mockano il
      // repository). Nessun id fisso: si lascia generare, si legge sempre
      // la riga più recente per `fetchedAt`, si ripulisce lo storico.
      await this.repo.save({ certificatesPem });
      await this.repo
        .createQueryBuilder()
        .delete()
        .where('fetched_at < NOW() - INTERVAL \'7 days\'')
        .execute();
      this.logger.log(`TSL-IT aggiornata: ${certificatesPem.length} certificati CA.`);
    } catch (err: any) {
      this.logger.warn(`Refresh TSL-IT fallito, mantengo la cache esistente: ${err?.message ?? err}`);
    }
  }
}
