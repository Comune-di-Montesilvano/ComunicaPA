import 'reflect-metadata';
import { ExternalCapabilitiesService } from './external-capabilities.service.js';
import type { CreateNotificationDto } from './dto/create-notification.dto.js';

function makeService(over: { settings?: Record<string, unknown>; postal?: unknown; mail?: unknown[]; io?: unknown[] } = {}) {
  const settings: Record<string, unknown> = {
    'send.environment': 'test',
    'send.test.apiKey': 'k',
    'send.test.purposeId': 'p',
    'send.test.group': '',
    'send.enabledTaxonomyCodes': JSON.stringify([
      { code: '010101N', label: 'Atto generico', isDefault: true },
      { code: '010101P', label: 'Atto con pagamento' },
    ]),
    ...over.settings,
  };
  const mail = over.mail ?? [
    { id: '11111111-1111-4111-8111-111111111111', type: 'EMAIL', name: 'Tributi', fromAddress: 'noreply@example.com', active: true, isDefault: true, host: 'smtp', username: 'u', password: '***' },
    { id: '22222222-2222-4222-8222-222222222222', type: 'PEC', name: 'Protocollo', fromAddress: 'protocollo@pec.example.com', active: true, isDefault: true, host: 'smtp', username: 'u', password: '***' },
  ];
  const io = over.io ?? [{ id: '33333333-3333-4333-8333-333333333333', nome: 'Tributi', isDefault: true, apiKeyPrimaria: '***' }];
  const postal = over.postal === undefined
    ? { enabledServiceTypes: ['Raccomandata', 'AgolRaccomandata', 'PostaOrdinaria'], contratti: [{ codiceContratto: 'C1', descrizione: 'Nazionale', tipologia: 'Std', estero: false }] }
    : over.postal;
  return new ExternalCapabilitiesService(
    { listMasked: jest.fn(async (type?: string) => (mail as any[]).filter((m) => !type || m.type === type)) } as any,
    { listMasked: jest.fn(async () => io), resolveApiKey: jest.fn(async () => (io.length ? { apiKey: 'x', idService: 'y' } : null)) } as any,
    { getActive: jest.fn(async () => postal) } as any,
    { get: jest.fn(async (k: string) => settings[k]) } as any,
  );
}

const ADDRESS = { street: 'Via Roma 1', zip: '00100', municipality: 'Roma', province: 'RM' };
const sendDto = (send: Record<string, unknown>, payment?: unknown) =>
  ({
    channel: 'SEND',
    recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
    content: { subject: 'Notifica atto' },
    attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
    send,
    ...(payment ? { payment } : {}),
  }) as unknown as CreateNotificationDto;

describe('ExternalCapabilitiesService.getCapabilities', () => {
  it('espone mittenti senza segreti, tassonomie con descrizione dal catalogo, opzioni POSTAL', async () => {
    const caps = await makeService().getCapabilities();
    expect(caps.success).toBe(true);
    expect(caps.channels.EMAIL).toEqual({
      active: true,
      senders: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Tributi', fromAddress: 'noreply@example.com', default: true }],
    });
    expect(JSON.stringify(caps)).not.toContain('smtp');
    expect(caps.channels.SEND.active).toBe(true);
    expect(caps.channels.SEND.taxonomies[0]).toEqual(
      expect.objectContaining({ code: '010101N', label: 'Atto generico', requiresPayment: false, default: true, description: expect.any(String) }),
    );
    expect(caps.channels.SEND.taxonomies[1]).toEqual(expect.objectContaining({ code: '010101P', requiresPayment: true, default: false }));
    expect(caps.channels.POSTAL.serviceTypes).toEqual([
      { value: 'Raccomandata', returnReceiptAvailable: true, agol: false, default: true },
      { value: 'AgolRaccomandata', returnReceiptAvailable: false, agol: true, default: false },
      { value: 'PostaOrdinaria', returnReceiptAvailable: false, agol: false, default: false },
    ]);
    expect(caps.channels.POSTAL.contracts).toEqual([{ code: 'C1', description: 'Nazionale', type: 'Std', foreign: false }]);
    expect(caps.channels.APP_IO).toEqual({ active: true, services: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Tributi', default: true }], parallelAvailable: true });
  });

  it('canali non configurati → active false e liste vuote', async () => {
    const caps = await makeService({ postal: null, mail: [], io: [], settings: { 'send.test.apiKey': '' } }).getCapabilities();
    expect(caps.channels.EMAIL).toEqual({ active: false, senders: [] });
    expect(caps.channels.SEND.active).toBe(false);
    expect(caps.channels.POSTAL).toEqual(expect.objectContaining({ active: false, serviceTypes: [], contracts: [] }));
    expect(caps.channels.APP_IO.active).toBe(false);
  });

  it('setting tassonomie in formato legacy string[] → tollerato', async () => {
    const caps = await makeService({ settings: { 'send.enabledTaxonomyCodes': JSON.stringify(['010101N']) } }).getCapabilities();
    expect(caps.channels.SEND.taxonomies[0]).toEqual(expect.objectContaining({ code: '010101N', default: true }));
  });
});

describe('ExternalCapabilitiesService.validate', () => {
  it('canale inattivo → inactiveChannel true', async () => {
    const svc = makeService({ postal: null });
    const caps = await svc.getCapabilities();
    const r = svc.validate({ channel: 'POSTAL' } as CreateNotificationDto, caps);
    expect(r.inactiveChannel).toBe(true);
  });

  it('tassonomia non abilitata → issue con allowed', async () => {
    const svc = makeService();
    const r = svc.validate(sendDto({ taxonomyCode: '020202N' }), await svc.getCapabilities());
    expect(r.issues).toEqual([{ field: 'send.taxonomyCode', message: expect.any(String), allowed: ['010101N', '010101P'] }]);
  });

  it('codice P senza payment e codice N con payment → issue', async () => {
    const svc = makeService();
    const caps = await svc.getCapabilities();
    expect(svc.validate(sendDto({ taxonomyCode: '010101P' }), caps).issues.map((i) => i.field)).toEqual(['send.taxonomyCode']);
    const pay = { noticeCode: '302000000000000000', amountCents: 100, creditorTaxId: '01234567890' };
    expect(svc.validate(sendDto({ taxonomyCode: '010101N' }, pay), caps).issues.map((i) => i.field)).toEqual(['send.taxonomyCode']);
    expect(svc.validate(sendDto({ taxonomyCode: '010101P' }, pay), caps).issues).toEqual([]);
  });

  it('serviceType e contractCode POSTAL non ammessi → issue con allowed', async () => {
    const svc = makeService();
    const dto = {
      channel: 'POSTAL',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
      content: { subject: 'Avviso' },
      attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
      postal: { serviceType: 'Telegramma', contractCode: 'ZZ' },
    } as unknown as CreateNotificationDto;
    const r = svc.validate(dto, await svc.getCapabilities());
    expect(r.issues).toEqual([
      { field: 'postal.serviceType', message: expect.any(String), allowed: ['Raccomandata', 'AgolRaccomandata', 'PostaOrdinaria'] },
      { field: 'postal.contractCode', message: expect.any(String), allowed: ['C1'] },
    ]);
  });

  it('returnReceipt su servizio senza AR → issue', async () => {
    const svc = makeService();
    const dto = {
      channel: 'POSTAL',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
      content: { subject: 'Avviso' },
      attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
      postal: { serviceType: 'PostaOrdinaria', returnReceipt: true },
    } as unknown as CreateNotificationDto;
    expect(svc.validate(dto, await svc.getCapabilities()).issues.map((i) => i.field)).toEqual(['postal.returnReceipt']);
  });

  it('sender di tipo sbagliato o inesistente → issue', async () => {
    const svc = makeService();
    const dto = {
      channel: 'EMAIL',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'a@b.it' },
      content: { subject: 'Avviso', body: '<p>x</p>' },
      sender: { mailConfigId: '22222222-2222-4222-8222-222222222222', ioServiceId: '44444444-4444-4444-8444-444444444444' },
    } as unknown as CreateNotificationDto;
    expect(svc.validate(dto, await svc.getCapabilities()).issues.map((i) => i.field)).toEqual(['sender.mailConfigId', 'sender.ioServiceId']);
  });

  it('appIoParallel con App IO non configurato → issue', async () => {
    const svc = makeService({ io: [] });
    const dto = {
      channel: 'EMAIL',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'a@b.it' },
      content: { subject: 'Avviso', body: '<p>x</p>' },
      appIoParallel: {},
    } as unknown as CreateNotificationDto;
    expect(svc.validate(dto, await svc.getCapabilities()).issues.map((i) => i.field)).toEqual(['appIoParallel']);
  });

  it('resolveDefaults: tassonomia default coerente con payment, servizio postale default', async () => {
    const svc = makeService();
    const caps = await svc.getCapabilities();
    expect(svc.resolveDefaults(sendDto({ taxonomyCode: '010101N' }), caps)).toEqual({ physicalCommunicationType: 'AR_REGISTERED_LETTER' });
    const postal = { channel: 'POSTAL', postal: {} } as unknown as CreateNotificationDto;
    expect(svc.resolveDefaults(postal, caps)).toEqual({ postalServiceType: 'Raccomandata' });
  });
});
