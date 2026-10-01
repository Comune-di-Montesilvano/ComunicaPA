import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { ExternalNotificationsService } from './external-notifications.service.js';
import { ExternalApiError } from './external-api.error.js';

const client = { id: 'client-1', name: 'Gestionale Tributi' } as any;
const EMAIL_BODY = {
  channel: 'EMAIL',
  externalReference: 'PROT-1',
  recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'mario.rossi@example.com' },
  content: { subject: 'Avviso TARI 2026', body: '<p>Testo</p>' },
};
const TOKEN = '3fbb1e2a-1234-4abc-9def-426614174000';
const SEND_BODY = {
  channel: 'SEND',
  recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: { street: 'Via Roma 1', zip: '00100', municipality: 'Roma', province: 'RM' } },
  content: { subject: 'Notifica atto' },
  attachments: [{ token: TOKEN, label: 'Atto' }],
  send: { taxonomyCode: '010101N' },
};

function setup(opts: { inactive?: boolean; dynamicIssues?: unknown[]; idem?: string; launchBlocked?: boolean; tokenResolves?: boolean } = {}) {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'ext-att-'));
  const src = join(tmp, 'atto.pdf');
  fs.writeFileSync(src, '%PDF-1.4');
  const caps = { channels: {} };
  const capabilities = {
    getCapabilities: jest.fn(async () => caps),
    validate: jest.fn(() => ({ inactiveChannel: !!opts.inactive, issues: opts.dynamicIssues ?? [] })),
    resolveDefaults: jest.fn(() => ({ physicalCommunicationType: 'AR_REGISTERED_LETTER' })),
  };
  const idempotency = {
    begin: jest.fn(async () => (opts.idem ? (opts.idem === 'replay' ? { kind: 'replay', response: { success: true, notificationId: 'old', status: 'accepted' } } : { kind: opts.idem }) : { kind: 'new' })),
    complete: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
  };
  const campaigns = {
    create: jest.fn(async (dto: any) => ({ id: 'camp-1', name: dto.name, channelConfig: dto.channelConfig })),
    setExternalClientId: jest.fn(async () => undefined),
    updateDraft: jest.fn(async () => undefined),
    addSingleRecipient: jest.fn(async () => ({ id: 'rec-1' })),
    launch: jest.fn(async () => (opts.launchBlocked ? { launched: 0, campaignId: 'camp-1', blocked: true, message: 'Quota INAD esaurita' } : { launched: 1, campaignId: 'camp-1' })),
    remove: jest.fn(async () => undefined),
  };
  const tokens = {
    resolve: jest.fn(() => (opts.tokenResolves === false ? null : { path: src, filename: 'atto.pdf' })),
    markConsumed: jest.fn(),
  };
  const audit = { log: jest.fn(async () => undefined) };
  const uploadsRoot = fs.mkdtempSync(join(os.tmpdir(), 'ext-up-'));
  const service = new ExternalNotificationsService(
    capabilities as any, idempotency as any, campaigns as any, tokens as any, audit as any,
    (campaignId: string) => join(uploadsRoot, campaignId),
  );
  return { service, capabilities, idempotency, campaigns, tokens, audit, uploadsRoot };
}

async function errorOf(p: Promise<unknown>): Promise<ExternalApiError> {
  try {
    await p;
  } catch (e) {
    return e as ExternalApiError;
  }
  throw new Error('nessun errore lanciato');
}

describe('ExternalNotificationsService.create', () => {
  it('Idempotency-Key mancante → VALIDATION_ERROR su header', async () => {
    const { service } = setup();
    const e = await errorOf(service.create(EMAIL_BODY, client, undefined));
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.details).toEqual([{ field: 'Idempotency-Key', message: expect.any(String) }]);
  });

  it('EMAIL: crea campagna source external, destinatario, lancia, audit, risposta accepted', async () => {
    const { service, campaigns, audit, idempotency } = setup();
    const res = await service.create(EMAIL_BODY, client, 'key-1');
    expect(res).toEqual({ success: true, notificationId: 'rec-1', status: 'accepted' });
    expect(campaigns.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: '[API] Gestionale Tributi — PROT-1', channelType: 'EMAIL', channelConfig: expect.objectContaining({ source: 'external' }) }),
      'external:Gestionale Tributi',
    );
    expect(campaigns.setExternalClientId).toHaveBeenCalledWith('camp-1', 'client-1');
    expect(campaigns.addSingleRecipient).toHaveBeenCalledWith('camp-1', expect.objectContaining({ codiceFiscale: 'RSSMRA80A01H501U', email: 'mario.rossi@example.com' }));
    expect(campaigns.launch).toHaveBeenCalledWith('camp-1', { username: 'external-api', role: 'admin' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'EXTERNAL_API_CREATE', details: { channel: 'EMAIL', externalReference: 'PROT-1', taxId: '***501U' } }));
    expect(idempotency.complete).toHaveBeenCalledWith('client-1', 'key-1', expect.any(String), res);
  });

  it('replay idempotente → risposta salvata, nessuna nuova campagna', async () => {
    const { service, campaigns } = setup({ idem: 'replay' });
    expect(await service.create(EMAIL_BODY, client, 'key-1')).toEqual({ success: true, notificationId: 'old', status: 'accepted' });
    expect(campaigns.create).not.toHaveBeenCalled();
  });

  it('conflict / in_progress → codici dedicati', async () => {
    expect((await errorOf(setup({ idem: 'conflict' }).service.create(EMAIL_BODY, client, 'k'))).code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await errorOf(setup({ idem: 'in_progress' }).service.create(EMAIL_BODY, client, 'k'))).code).toBe('IDEMPOTENCY_IN_PROGRESS');
  });

  it('validazione statica fallita → VALIDATION_ERROR prima di toccare Redis', async () => {
    const { service, idempotency } = setup();
    const e = await errorOf(service.create({ ...EMAIL_BODY, channel: 'FAX' }, client, 'k'));
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.details!.map((d) => d.field)).toContain('channel');
    expect(idempotency.begin).not.toHaveBeenCalled();
  });

  it('canale inattivo → CHANNEL_INACTIVE; issue dinamiche → VALIDATION_ERROR', async () => {
    expect((await errorOf(setup({ inactive: true }).service.create(EMAIL_BODY, client, 'k'))).code).toBe('CHANNEL_INACTIVE');
    const e = await errorOf(setup({ dynamicIssues: [{ field: 'sender.mailConfigId', message: 'x' }] }).service.create(EMAIL_BODY, client, 'k'));
    expect(e.code).toBe('VALIDATION_ERROR');
  });

  it('SEND: copia allegato, consuma token, salva attachments in channelConfig', async () => {
    const { service, campaigns, tokens, uploadsRoot } = setup();
    await service.create(SEND_BODY, client, 'k');
    expect(fs.existsSync(join(uploadsRoot, 'camp-1', '0_atto.pdf'))).toBe(true);
    expect(tokens.markConsumed).toHaveBeenCalledWith('client-1', TOKEN);
    expect(campaigns.updateDraft).toHaveBeenCalledWith('camp-1', {
      channelConfig: expect.objectContaining({ taxonomyCode: '010101N', protocolla: true, attachments: [{ key: 'allegato_0', label: 'Atto' }] }),
    });
    expect(campaigns.addSingleRecipient).toHaveBeenCalledWith('camp-1', expect.objectContaining({ extraData: expect.objectContaining({ allegato_0: '0_atto.pdf', _extStreet: 'Via Roma 1' }) }));
  });

  it('token allegato non valido → ATTACHMENT_INVALID, campagna eliminata, chiave rilasciata, token non consumato', async () => {
    const { service, campaigns, tokens, idempotency } = setup({ tokenResolves: false });
    const e = await errorOf(service.create(SEND_BODY, client, 'k'));
    expect(e.code).toBe('ATTACHMENT_INVALID');
    expect(campaigns.remove).toHaveBeenCalledWith('camp-1', { username: 'external-api', role: 'admin' });
    expect(idempotency.release).toHaveBeenCalledWith('client-1', 'k');
    expect(tokens.markConsumed).not.toHaveBeenCalled();
  });

  it('launch bloccato → LAUNCH_BLOCKED con messaggio, chiave rilasciata', async () => {
    const { service, idempotency } = setup({ launchBlocked: true });
    const e = await errorOf(service.create(EMAIL_BODY, client, 'k'));
    expect(e).toMatchObject({ code: 'LAUNCH_BLOCKED', message: 'Quota INAD esaurita' });
    expect(idempotency.release).toHaveBeenCalled();
  });

  it('eccezione inattesa → chiave rilasciata e rilanciata', async () => {
    const { service, campaigns, idempotency } = setup();
    campaigns.addSingleRecipient.mockRejectedValueOnce(new Error('db giù'));
    await expect(service.create(EMAIL_BODY, client, 'k')).rejects.toThrow('db giù');
    expect(idempotency.release).toHaveBeenCalledWith('client-1', 'k');
  });
});
