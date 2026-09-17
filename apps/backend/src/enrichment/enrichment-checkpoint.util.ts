import * as fs from 'fs';
import { getEnrichmentCheckpoint } from './enrichment-paths.js';
import type { EnrichedRow } from './enriched-csv.util.js';
import type { EnrichmentWarning } from '../entities/enrichment-job.entity.js';

export interface EnrichmentCheckpoint {
  lastRow: number;
  rows: EnrichedRow[];
  warnings: EnrichmentWarning[];
  maxRate: number;
  /**
   * Numeri di riga (1-based) con "Estrazione fallita" da rielaborare DOPO
   * che il passaggio principale (da lastRow in poi) è arrivato in fondo —
   * l'ordine delle righe nel CSV finale non conta, quindi non serve
   * riavvolgere lastRow e rifare tutte le righe buone nel mezzo per
   * riprovare solo quelle fallite. Popolato da
   * EnrichmentService.retryFailedPdfs, consumato e svuotato via via da
   * EnrichmentProcessor.processEnrich.
   */
  retryRows?: number[];
}

/**
 * Scrittura atomica: mai fs.writeFileSync diretto sul file finale — un crash
 * a metà scrittura lascerebbe un JSON troncato che il resume leggerebbe come
 * dato valido parziale invece che come "checkpoint assente".
 */
export function writeCheckpointSync(jobId: string, data: EnrichmentCheckpoint): void {
  const finalPath = getEnrichmentCheckpoint(jobId);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data));
  fs.renameSync(tmpPath, finalPath);
}

export function readCheckpointSync(jobId: string): EnrichmentCheckpoint | null {
  const path = getEnrichmentCheckpoint(jobId);
  if (!fs.existsSync(path)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function deleteCheckpointSync(jobId: string): void {
  fs.rmSync(getEnrichmentCheckpoint(jobId), { force: true });
}
