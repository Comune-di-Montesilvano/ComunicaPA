import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteSignService } from './remote-sign.service.js';
import { RemoteSignError } from './arss-errors.js';
import { RemoteSignJobStatus } from '../entities/remote-sign-job.entity.js';
import { CampaignStatus } from '../entities/campaign.entity.js';

const CAMPAIGN_ID = '22222222-2222-2222-2222-222222222222';
const ADMIN = { username: 'admin', role: 'admin' as const };
const sendCampaign = {
  id: CAMPAIGN_ID, channelType: 'SEND', status: CampaignStatus.DRAFT, createdBy: 'mario',
  channelConfig: { attachments: [{ key: 'allegato', label: 'Avviso' }] },
};

function build() {
  const campaignRepo = { findOneBy: vi.fn().mockResolvedValue(sendCampaign) };
  const recipientRepo = {
    find: vi.fn().mockResolvedValue([
      { extraData: { allegato: 'A.pdf' }, signatureCheck: { valid: false } },
      { extraData: { allegato: 'A.pdf' }, signatureCheck: { valid: false } },
      { extraData: { allegato: 'B.pdf' }, signatureCheck: { valid: true } },
      { extraData: { allegato: 'C.pdf.p7m' }, signatureCheck: { valid: false } },
    ]),
  };
  const jobRepo = {
    exists: vi.fn().mockResolvedValue(false),
    create: vi.fn((x) => x),
    save: vi.fn(async (x) => ({ ...x, id: 'job-1' })),
    findOne: vi.fn(),
  };
  const queue = { add: vi.fn() };
  const client = { openSession: vi.fn().mockResolvedValue('SESS-1'), signPdf: vi.fn(), closeSession: vi.fn() };
  const bulk = { getLatestStatus: vi.fn().mockResolvedValue({ status: 'done', invalidCount: 2, totalRows: 4 }) };
  const verification = { verify: vi.fn() };
  const settings = { get: vi.fn().mockResolvedValue(true) };
  const config = { get: vi.fn().mockReturnValue('jwt-secret-di-test') };
  const audit = { log: vi.fn() };
  const svc = new RemoteSignService(
    campaignRepo as any, recipientRepo as any, jobRepo as any, queue as any, client as any,
    bulk as any, verification as any, settings as any, config as any,
  );
  return { svc, campaignRepo, recipientRepo, jobRepo, queue, client, bulk, verification, settings, audit };
}

describe('RemoteSignService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listFilesToSign: solo invalidi, deduplicati, senza .p7m; validi a parte', async () => {
    const { svc } = build();
    await expect(svc.listFilesToSign(CAMPAIGN_ID)).resolves.toEqual({ toSign: ['A.pdf'], alreadyValid: ['B.pdf'] });
  });

  it('listFilesToSign: scarta nomi non sicuri (traversal, sottocartelle, nascosti, non PDF)', async () => {
    const { svc, recipientRepo } = build();
    const bad = ['../../etc/passwd', '../11111111-1111-1111-1111-111111111111/DOC.pdf', '.hidden.pdf', 'a/b.pdf', 'x.txt'];
    recipientRepo.find.mockResolvedValueOnce([
      ...bad.map((f) => ({ extraData: { allegato: f }, signatureCheck: { valid: false } })),
      ...['../../etc/V.pdf', '.v.pdf', 'v/w.pdf', 'v.txt'].map((f) => ({ extraData: { allegato: f }, signatureCheck: { valid: true } })),
      { extraData: { allegato: 'OK.PDF' }, signatureCheck: { valid: false } },
      { extraData: { allegato: '../evil.pdf' }, signatureCheck: { valid: true } },
    ]);
    const res = await svc.listFilesToSign(CAMPAIGN_ID);
    expect(res.toSign).toEqual(['OK.PDF']);
    expect(res.alreadyValid).toEqual([]);
  });

  it('start: apre la sessione nella richiesta e accoda senza password in chiaro', async () => {
    const { svc, queue, client } = build();
    const res = await svc.start(CAMPAIGN_ID, ADMIN, { user: 'mario', password: 'segreta', otp: '123456' });
    expect(res).toEqual({ jobId: 'job-1' });
    expect(client.openSession).toHaveBeenCalledWith({ user: 'mario', password: 'segreta' }, '123456');
    const [, data, opts] = queue.add.mock.calls[0];
    expect(data).toMatchObject({ jobId: 'job-1', campaignId: CAMPAIGN_ID, sessionId: 'SESS-1', user: 'mario' });
    expect(data.passwordEnc).toMatch(/^enc:v1:/);
    expect(JSON.stringify(data)).not.toContain('segreta');
    expect(opts).toMatchObject({ jobId: 'job-1', removeOnComplete: true, removeOnFail: true });
    expect(svc.decryptPassword(data.passwordEnc)).toBe('segreta');
  });

  it('start: queue.add fallisce → riga FAILED, sessione chiusa, { error }', async () => {
    const { svc, queue, jobRepo, client } = build();
    (jobRepo as any).update = vi.fn();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.start(CAMPAIGN_ID, ADMIN, { user: 'mario', password: 'x', otp: '123456' }))
      .resolves.toEqual({ error: 'Impossibile avviare la firma: riprova' });
    expect((jobRepo as any).update).toHaveBeenCalledWith({ id: 'job-1' }, expect.objectContaining({
      status: RemoteSignJobStatus.FAILED, errorMessage: 'Impossibile avviare la firma: riprova',
    }));
    expect(client.closeSession).toHaveBeenCalledWith('SESS-1', { user: 'mario', password: 'x' });
  });

  it('start: OTP errato → { error } e nessun job', async () => {
    const { svc, client, jobRepo, queue } = build();
    client.openSession.mockRejectedValueOnce(new RemoteSignError('credentials', 'Credenziali o OTP non validi'));
    await expect(svc.start(CAMPAIGN_ID, ADMIN, { user: 'mario', password: 'x', otp: '000000' }))
      .resolves.toEqual({ error: 'Credenziali o OTP non validi', errorKind: 'credentials' });
    expect(jobRepo.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('start: job già attivo → { error } senza aprire una seconda sessione', async () => {
    const { svc, jobRepo, client } = build();
    jobRepo.exists.mockResolvedValueOnce(true);
    await expect(svc.start(CAMPAIGN_ID, ADMIN, { user: 'mario', password: 'x', otp: '123456' }))
      .resolves.toEqual({ error: 'Firma remota già in corso per questa campagna' });
    expect(client.openSession).not.toHaveBeenCalled();
  });

  it('start: verifica non conclusa → { error }', async () => {
    const { svc, bulk } = build();
    bulk.getLatestStatus.mockResolvedValueOnce({ status: 'processing', invalidCount: 0 });
    await expect(svc.start(CAMPAIGN_ID, ADMIN, { user: 'm', password: 'x', otp: '123456' }))
      .resolves.toEqual({ error: 'Attendi la fine della verifica firma prima di firmare' });
  });

  it('start: firma remota disattivata → { error }', async () => {
    const { svc, settings } = build();
    settings.get.mockResolvedValueOnce(false);
    await expect(svc.start(CAMPAIGN_ID, ADMIN, { user: 'm', password: 'x', otp: '123456' }))
      .resolves.toEqual({ error: 'Firma remota non attiva: abilitala da Impostazioni → Firma remota' });
  });

  // Flusso reale: l'admin prepara la campagna, il dirigente (ruolo 'user') la firma.
  it('assertCanModify: un user può firmare la campagna creata da un altro operatore', async () => {
    const { svc } = build();
    await expect(svc.assertCanModify(CAMPAIGN_ID, { username: 'luigi', role: 'user' })).resolves.toBeDefined();
  });

  it('assertCanRead: user non proprietario legge lo stato firma; campagna lanciata comunque leggibile', async () => {
    const { svc, campaignRepo } = build();
    await expect(svc.assertCanRead(CAMPAIGN_ID, { username: 'luigi', role: 'user' })).resolves.toBeDefined();
    campaignRepo.findOneBy.mockResolvedValueOnce({ ...sendCampaign, status: CampaignStatus.QUEUED });
    await expect(svc.assertCanRead(CAMPAIGN_ID, { username: 'mario', role: 'user' })).resolves.toBeDefined();
  });

  it('assertCanModify: campagna non SEND o non in bozza → errore', async () => {
    const { svc, campaignRepo } = build();
    campaignRepo.findOneBy.mockResolvedValueOnce({ ...sendCampaign, status: CampaignStatus.QUEUED });
    await expect(svc.assertCanModify(CAMPAIGN_ID, ADMIN)).rejects.toThrow('bozza');
  });

  it('testSign: firma il PDF di prova, verifica, chiude la sessione', async () => {
    const { svc, client, verification } = build();
    client.signPdf.mockResolvedValueOnce(Buffer.from('FIRMATO'));
    verification.verify.mockResolvedValueOnce({ valid: true, reason: null, signerCn: 'MARIO ROSSI' });
    await expect(svc.testSign({ user: 'mario', password: 'x', otp: '123456' })).resolves.toEqual({ ok: true, signerCn: 'MARIO ROSSI' });
    expect(client.closeSession).toHaveBeenCalledWith('SESS-1', { user: 'mario', password: 'x' });
  });

  it('testSign: firma non valida → ok false col motivo', async () => {
    const { svc, client, verification } = build();
    client.signPdf.mockResolvedValueOnce(Buffer.from('FIRMATO'));
    verification.verify.mockResolvedValueOnce({ valid: false, reason: 'CA non riconosciuta' });
    await expect(svc.testSign({ user: 'mario', password: 'x', otp: '123456' }))
      .resolves.toEqual({ ok: false, error: 'Firma creata ma non valida: CA non riconosciuta' });
  });
});
