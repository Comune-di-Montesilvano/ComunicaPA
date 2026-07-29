import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EnrichmentAddressOverride } from '../entities/enrichment-address-override.entity';
import type { EnrichedRow } from './enriched-csv.util';

export interface AddressOverrideInput {
  indirizzo?: string;
  cap?: string;
  comune?: string;
  provincia?: string;
  statoEstero?: string;
}

@Injectable()
export class EnrichmentAddressOverrideService {
  constructor(
    @InjectRepository(EnrichmentAddressOverride)
    private readonly repo: Repository<EnrichmentAddressOverride>,
  ) {}

  async upsert(
    jobId: string,
    pdfFilename: string,
    address: AddressOverrideInput,
    extraFields: Record<string, string> | null,
    correctedBy: string,
  ): Promise<EnrichmentAddressOverride> {
    await this.repo.upsert(
      {
        jobId,
        pdfFilename,
        indirizzo: address.indirizzo ?? null,
        cap: address.cap ?? null,
        comune: address.comune ?? null,
        provincia: address.provincia ?? null,
        statoEstero: address.statoEstero ?? null,
        extraFields: extraFields && Object.keys(extraFields).length > 0 ? extraFields : null,
        correctedBy,
      },
      ['jobId', 'pdfFilename'],
    );
    return (await this.repo.findOneBy({ jobId, pdfFilename }))!;
  }

  findByJob(jobId: string): Promise<EnrichmentAddressOverride[]> {
    return this.repo.find({ where: { jobId } });
  }

  /**
   * Pure, nessun I/O: usata sia dal processor (checkpoint/CSV finale) sia da
   * regenerateCsv (CSV già scritto). Non muta l'array di input — il chiamante
   * potrebbe ancora servirsi della versione non patchata (es. checkpoint).
   */
  applyOverrides(rows: EnrichedRow[], overrides: EnrichmentAddressOverride[]): EnrichedRow[] {
    const byFilename = new Map(overrides.map((o) => [o.pdfFilename, o]));
    return rows.map((row) => {
      const override = row['allegato'] ? byFilename.get(row['allegato']) : undefined;
      if (!override) return row;
      return {
        ...row,
        ...(override.extraFields ?? {}),
        indirizzo: override.indirizzo ?? row['indirizzo'],
        cap: override.cap ?? row['cap'],
        comune: override.comune ?? row['comune'],
        provincia: override.provincia ?? row['provincia'],
        stato_estero: override.statoEstero ?? row['stato_estero'],
      };
    });
  }
}
