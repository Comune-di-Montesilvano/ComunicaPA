import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { RemoteSignProcessor } from './remote-sign.processor.js';
import { RemoteSignError } from './arss-errors.js';
import { RemoteSignJobStatus } from '../entities/remote-sign-job.entity.js';
import { getUnsignedBackupDir, getUploadsDir } from '../attachments/attachment-paths.js';

const CAMPAIGN = '33333333-3333-3333-3333-333333333333';
const jobData = { jobId: 'job-1', campaignId: CAMPAIGN, sessionId: 'SESS-1', user: 'mario', passwordEnc: 'enc' };

function build(files: string[]) {
  const calls: string[] = [];
  const jobRepo = {
    update: vi.fn(async (_id: unknown, patch: any) => { if (patch.status) calls.push(`status:${patch.status}`); }),
    findOneBy: vi.fn().mockResolvedValue({ operator: 'operatore.comune' }),
  };
  const client = {
    signPdf: vi.fn(async (_s: string, _c: unknown, pdf: Buffer) => Buffer.concat([pdf, Buffer.from('+FIRMA')])),
    closeSession: vi.fn(async () => { calls.push('close'); }),
  };
  const service = {
    listFilesToSign: vi.fn().mockResolvedValue({ toSign: files, alreadyValid: [] }),
    decryptPassword: vi.fn().mockReturnValue('segreta'),
  };
  const bulk = { startForCampaign: vi.fn(async () => { calls.push('verify'); return { jobId: 'v-2' }; }) };
  const verification = { verify: vi.fn().mockResolvedValue({ valid: true, reason: null, signerCn: 'MARIO ROSSI' }) };
  const audit = { log: vi.fn() };
  const campaignRepo = { findOneBy: vi.fn().mockResolvedValue({ id: CAMPAIGN, name: 'Prova' }) };
  const p = new RemoteSignProcessor(jobRepo as any, campaignRepo as any, client as any, service as any, bulk as any, verification as any, audit as any);
  return { p, jobRepo, client, service, bulk, audit, calls };
}

describe('RemoteSignProcessor', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-rsp-'));
    process.env['ATTACHMENTS_PATH'] = root;
    fs.mkdirSync(getUploadsDir(CAMPAIGN), { recursive: true });
    for (const f of ['A.pdf', 'B.pdf', 'C.pdf']) fs.writeFileSync(join(getUploadsDir(CAMPAIGN), f), f);
  });
  afterEach(() => {
    delete process.env['ATTACHMENTS_PATH'];
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('firma i file, fa backup fuori da uploads, chiude, riavvia la verifica PRIMA di marcare done', async () => {
    const { p, client, calls, jobRepo, audit } = build(['A.pdf', 'B.pdf']);
    await p.process({ data: jobData } as any);
    expect(client.signPdf).toHaveBeenCalledTimes(2);
    expect(client.signPdf.mock.calls[0][1]).toEqual({ user: 'mario', password: 'segreta' });
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('A.pdf+FIRMA');
    expect(fs.readFileSync(join(getUnsignedBackupDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('A.pdf');
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'C.pdf'), 'utf8')).toBe('C.pdf');
    expect(calls).toEqual(['status:processing', 'close', 'verify', 'status:done']);
    expect(jobRepo.update).toHaveBeenLastCalledWith({ id: 'job-1' }, expect.objectContaining({
      status: RemoteSignJobStatus.DONE, signedCount: 2, failedCount: 0, signerCn: 'MARIO ROSSI',
    }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'REMOTE_SIGN', operator: 'operatore.comune' }));
  });

  it('errore file: conta e prosegue', async () => {
    const { p, client, jobRepo } = build(['A.pdf', 'B.pdf']);
    client.signPdf.mockRejectedValueOnce(new RemoteSignError('file', 'rifiutato'));
    await p.process({ data: jobData } as any);
    expect(client.signPdf).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('A.pdf');
    expect(jobRepo.update).toHaveBeenLastCalledWith({ id: 'job-1' }, expect.objectContaining({
      status: RemoteSignJobStatus.DONE, signedCount: 1, failedCount: 1,
    }));
  });

  it('errore sessione: si ferma, failed con conteggio e secondi, chiude e riverifica comunque', async () => {
    const { p, client, calls, jobRepo } = build(['A.pdf', 'B.pdf', 'C.pdf']);
    client.signPdf
      .mockResolvedValueOnce(Buffer.from('ok'))
      .mockRejectedValueOnce(new RemoteSignError('session', 'Sessione di firma scaduta o non valida'));
    await p.process({ data: jobData } as any);
    expect(client.signPdf).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['status:processing', 'close', 'verify', 'status:failed']);
    const last = jobRepo.update.mock.calls.at(-1)![1];
    expect(last).toMatchObject({ status: RemoteSignJobStatus.FAILED, errorKind: 'session', signedCount: 1 });
    expect(last.errorMessage).toMatch(/^Sessione scaduta dopo 1 file su 3 \(\d+ s\): inserisci un nuovo OTP per i rimanenti$/);
  });

  it('decrypt fallisce: job FAILED con messaggio, closeSession NON chiamata', async () => {
    const { p, service, client, jobRepo, calls } = build(['A.pdf']);
    service.decryptPassword.mockImplementation(() => { throw new Error('bad tag'); });
    await p.process({ data: jobData } as any);
    expect(client.closeSession).not.toHaveBeenCalled();
    expect(client.signPdf).not.toHaveBeenCalled();
    expect(calls).toEqual(['verify', 'status:failed']);
    expect(jobRepo.update).toHaveBeenLastCalledWith({ id: 'job-1' }, expect.objectContaining({
      status: RemoteSignJobStatus.FAILED, errorKind: 'credentials',
      errorMessage: 'Impossibile leggere le credenziali di firma: rilancia la firma',
    }));
  });

  it('startForCampaign lancia: lo stato finale viene comunque scritto', async () => {
    const { p, bulk, jobRepo } = build(['A.pdf']);
    bulk.startForCampaign.mockRejectedValueOnce(new Error('redis'));
    await p.process({ data: jobData } as any);
    expect(jobRepo.update).toHaveBeenLastCalledWith({ id: 'job-1' }, expect.objectContaining({
      status: RemoteSignJobStatus.DONE, signedCount: 1,
    }));
  });

  it('listFilesToSign lancia: job FAILED (non DONE 0/0), sessione chiusa', async () => {
    const { p, service, client, jobRepo } = build(['A.pdf']);
    service.listFilesToSign.mockRejectedValueOnce(new Error('db down'));
    await p.process({ data: jobData } as any);
    expect(client.closeSession).toHaveBeenCalled();
    expect(jobRepo.update).toHaveBeenLastCalledWith({ id: 'job-1' }, expect.objectContaining({
      status: RemoteSignJobStatus.FAILED, errorKind: 'network',
      errorMessage: 'Errore imprevisto durante la firma: rilancia la firma',
    }));
  });

  it('file sparito da disco: conta come fallito', async () => {
    const { p, jobRepo } = build(['MANCANTE.pdf']);
    await p.process({ data: jobData } as any);
    expect(jobRepo.update).toHaveBeenLastCalledWith({ id: 'job-1' }, expect.objectContaining({ failedCount: 1, signedCount: 0 }));
  });

  it('errore fs imprevisto su un file (non RemoteSignError): conta fallito e prosegue col successivo', async () => {
    // A.pdf è una cartella: existsSync true, readFileSync lancia EISDIR (deterministico).
    fs.rmSync(join(getUploadsDir(CAMPAIGN), 'A.pdf'));
    fs.mkdirSync(join(getUploadsDir(CAMPAIGN), 'A.pdf'));
    const { p, client, jobRepo } = build(['A.pdf', 'B.pdf']);
    await p.process({ data: jobData } as any);
    expect(client.signPdf).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'B.pdf'), 'utf8')).toBe('B.pdf+FIRMA');
    expect(jobRepo.update).toHaveBeenLastCalledWith({ id: 'job-1' }, expect.objectContaining({
      status: RemoteSignJobStatus.DONE, signedCount: 1, failedCount: 1, errorKind: null,
    }));
  });
});
