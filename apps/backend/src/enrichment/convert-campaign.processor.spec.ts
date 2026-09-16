import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import type { Job } from 'bullmq';
import { EnrichmentJobStatus } from '../entities/enrichment-job.entity.js';
import { getEnrichmentAttachmentsDir, getEnrichmentDir, getEnrichmentResultCsv } from './enrichment-paths.js';
import { ConvertCampaignProcessor } from './convert-campaign.processor.js';

describe('ConvertCampaignProcessor', () => {
  let tmpDir: string;
  let repo: any;
  let campaignsService: any;
  let processor: ConvertCampaignProcessor;

  const convertJob = {
    data: { jobId: 'job-uuid-1', name: 'Campagna X', channelType: 'PEC', createdBy: 'op' },
  } as unknown as Job<any>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'convert-campaign-proc-'));
    process.env['ATTACHMENTS_PATH'] = tmpDir;
    repo = {
      findOneBy: jest.fn(async () => ({ id: 'job-uuid-1', status: EnrichmentJobStatus.DONE, campaignId: null })),
      update: jest.fn(async () => undefined),
    };
    campaignsService = { create: jest.fn(async () => ({ id: 'camp-1' })) };
    processor = new ConvertCampaignProcessor(repo, campaignsService);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['ATTACHMENTS_PATH'];
  });

  function setupDoneJob(): void {
    fs.mkdirSync(getEnrichmentAttachmentsDir('job-uuid-1'), { recursive: true });
    fs.writeFileSync(join(getEnrichmentAttachmentsDir('job-uuid-1'), 'PROVV_1.pdf'), '%PDF-fake');
    fs.writeFileSync(getEnrichmentResultCsv('job-uuid-1'), '"codice_fiscale"\n"RSSMRA80A01H501U"');
  }

  it('crea la campagna, copia CSV+PDF in uploadsDir, marca DONE, elimina i file del job', async () => {
    setupDoneJob();
    await processor.process(convertJob);

    expect(campaignsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Campagna X',
        channelType: 'PEC',
        channelConfig: expect.objectContaining({ wizCsvFilename: 'arricchito.csv', wizCsvHasHeaders: true }),
      }),
      'op',
    );
    const uploadsDir = join(tmpDir, 'uploads', 'camp-1');
    expect(fs.existsSync(join(uploadsDir, 'draft_recipients.csv'))).toBe(true);
    expect(fs.existsSync(join(uploadsDir, 'PROVV_1.pdf'))).toBe(true);

    const updates = repo.update.mock.calls.map((c: any[]) => c[1]);
    expect(updates).toContainEqual({ campaignConversionStatus: 'processing' });
    expect(updates.at(-1)).toEqual({ campaignId: 'camp-1', campaignConversionStatus: 'done' });
    expect(fs.existsSync(getEnrichmentDir('job-uuid-1'))).toBe(false);
  });

  it('nessuna cartella allegati (job senza PDF o pre-refactor) → solo il CSV copiato, nessun errore', async () => {
    fs.mkdirSync(getEnrichmentDir('job-uuid-1'), { recursive: true });
    fs.writeFileSync(getEnrichmentResultCsv('job-uuid-1'), '"codice_fiscale"\n"RSSMRA80A01H501U"');

    await processor.process(convertJob);

    const uploadsDir = join(tmpDir, 'uploads', 'camp-1');
    expect(fs.existsSync(join(uploadsDir, 'draft_recipients.csv'))).toBe(true);
    const updates = repo.update.mock.calls.map((c: any[]) => c[1]);
    expect(updates.at(-1)).toEqual({ campaignId: 'camp-1', campaignConversionStatus: 'done' });
  });

  it('errore durante la conversione → campaignConversionStatus=failed con errore, mai un throw', async () => {
    // result.csv assente → copyFileSync lancia
    await expect(processor.process(convertJob)).resolves.toBeUndefined();
    const updates = repo.update.mock.calls.map((c: any[]) => c[1]);
    expect(updates.at(-1)).toEqual(expect.objectContaining({ campaignConversionStatus: 'failed' }));
  });
});
