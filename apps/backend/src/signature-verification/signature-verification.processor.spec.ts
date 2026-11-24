import { vi } from 'vitest';
import * as fs from 'fs';
import { SignatureVerificationProcessor } from './signature-verification.processor.js';
import { SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { RecipientStatus } from '../entities/recipient.entity.js';

// `vi.mock('fs')` (automock) — `jest.spyOn`/`vi.spyOn` su `import * as fs`
// fallisce con "Cannot redefine property" (getter non configurabile creato
// da `__createBinding` con esModuleInterop), stesso gotcha già documentato
// in `external-attachment-tokens.service.spec.ts`.
vi.mock('fs');

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
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from('dummy'));
  });

  afterEach(() => {
    vi.clearAllMocks();
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

  it('più allegati: li verifica tutti e salva quali non sono validi (nessun allegato "principale")', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'camp-1', channelConfig: { attachments: [{ key: 'atto', label: 'Atto' }, { key: 'stipula', label: 'Stipula' }] } });
    recipientRepo.find.mockResolvedValue([
      { id: 'r1', status: RecipientStatus.PENDING, extraData: { atto: 'atto.pdf', stipula: 'stipula.pdf' } },
    ]);
    verificationService.verify
      .mockResolvedValueOnce({ valid: false, reason: 'File non firmato' })
      .mockResolvedValueOnce({ valid: false, reason: 'CA non riconosciuta' });

    await processor.process({ data: { jobId: 'job-1', campaignId: 'camp-1' } } as any);

    expect(verificationService.verify).toHaveBeenCalledTimes(2);
    expect(recipientRepo.update).toHaveBeenCalledWith({ id: 'r1' }, {
      signatureCheck: {
        valid: false,
        reason: 'atto.pdf: File non firmato; stipula.pdf: CA non riconosciuta',
        invalidFiles: [
          { filename: 'atto.pdf', reason: 'File non firmato' },
          { filename: 'stipula.pdf', reason: 'CA non riconosciuta' },
        ],
        checkedAt: expect.any(String),
      },
    });
    expect(jobRepo.update).toHaveBeenCalledWith({ id: 'job-1' }, expect.objectContaining({ totalRows: 1, invalidCount: 1 }));
  });

  it('destinatario valido: niente invalidFiles', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'camp-1', channelConfig: { attachments: [{ key: 'doc', label: 'Documento' }] } });
    recipientRepo.find.mockResolvedValue([{ id: 'r1', status: RecipientStatus.PENDING, extraData: { doc: 'ok.pdf' } }]);
    verificationService.verify.mockResolvedValueOnce({ valid: true, reason: null });

    await processor.process({ data: { jobId: 'job-1', campaignId: 'camp-1' } } as any);

    expect(recipientRepo.update).toHaveBeenCalledWith({ id: 'r1' }, { signatureCheck: { valid: true, reason: null, checkedAt: expect.any(String) } });
  });

  it('marca invalid ogni destinatario se nessun allegato è configurato (job comunque DONE)', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'camp-1', channelConfig: {} });
    recipientRepo.find.mockResolvedValue([{ id: 'r1', status: RecipientStatus.PENDING, extraData: {} }]);

    await processor.process({ data: { jobId: 'job-1', campaignId: 'camp-1' } } as any);

    // Nessun allegato configurato -> il destinatario esiste ma non è
    // verificabile, contato come invalid (non escluso dal conteggio totale).
    expect(recipientRepo.update).toHaveBeenCalledWith({ id: 'r1' }, expect.objectContaining({ signatureCheck: expect.objectContaining({ valid: false }) }));
    expect(jobRepo.update).toHaveBeenCalledWith({ id: 'job-1' }, expect.objectContaining({ status: SignatureVerificationJobStatus.DONE, totalRows: 1, invalidCount: 1 }));
  });
});
