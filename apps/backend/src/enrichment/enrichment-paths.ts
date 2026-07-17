import { join } from 'path';
import { getAttachmentsRoot } from '../attachments/attachment-paths';

export function getEnrichmentDir(jobId: string): string {
  return join(getAttachmentsRoot(), 'enrichment', jobId);
}

export function getEnrichmentSourceZip(jobId: string): string {
  return join(getEnrichmentDir(jobId), 'source.zip');
}

export function getEnrichmentResultCsv(jobId: string): string {
  return join(getEnrichmentDir(jobId), 'result.csv');
}
