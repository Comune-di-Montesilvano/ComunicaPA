import { Test } from '@nestjs/testing';
import { SendStrategy } from './send.strategy';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { ProtocolloService } from '../../protocollo/protocollo.service';
import { AttachmentService } from '../../attachments/attachment.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'send.environment': 'collaudo',
  'send.test.baseUrl': 'https://send.test',
  'send.test.purposeId': 'purpose-test',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };
const mockProtocollo = { protocolla: jest.fn(async () => ({ numeroProtocollo: 111, annoProtocollo: 2026, dataProtocollazione: '13/07/2026' })) };
const mockAttachments = { generatePdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 test')) };

describe('SendStrategy', () => {
  let strategy: SendStrategy;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    mockProtocollo.protocolla.mockClear();
    mockAttachments.generatePdfBuffer.mockClear();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ notificationRequestId: 'send-001' }),
    });

    const module = await Test.createTestingModule({
      providers: [
        SendStrategy,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
        { provide: ProtocolloService, useValue: mockProtocollo },
        { provide: AttachmentService, useValue: mockAttachments },
      ],
    }).compile();

    strategy = module.get(SendStrategy);
  });

  it('is defined with channel SEND', () => {
    expect(strategy.channel).toBe('SEND');
  });

  it('send() chiama SEND API con recipientTaxId', async () => {
    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario', email: null, pec: null };
    const campaign = { id: 'camp-1', name: 'TARI', channelConfig: { subject: 'Avviso', body: 'Testo notifica.' } };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/notifications/sent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer voucher-abc' }),
        body: JSON.stringify({
          recipientTaxId: 'RSSMRA85M01H501Z',
          subject: 'Avviso',
          notificationBody: 'Testo notifica.',
        }),
      }),
    );
    expect(result.messageId).toBe('send-001');
    expect(mockPdndAuth.getVoucher).toHaveBeenCalledWith('test', 'purpose-test');
    expect(mockProtocollo.protocolla).not.toHaveBeenCalled();
  });

  it('send() lancia Error se SEND API risponde con ok: false', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });
    const recipient = { codiceFiscale: 'CF', fullName: null, email: null, pec: null };
    const campaign = { id: 'camp-1', name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow('SEND API error: 503');
  });

  it("send() protocolla prima dell'invio se channelConfig.protocolla è true", async () => {
    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario Rossi', email: null, pec: null };
    const campaign = { id: 'camp-1', name: 'TARI', channelConfig: { subject: 'Avviso', body: 'Testo notifica.', protocolla: true } };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockAttachments.generatePdfBuffer).toHaveBeenCalledWith(recipient, 0);
    expect(mockProtocollo.protocolla).toHaveBeenCalledWith(expect.objectContaining({
      oggetto: 'Avviso',
      destinatario: expect.objectContaining({ codiceFiscale: 'RSSMRA85M01H501Z' }),
    }));
    expect(result.responsePayload).toEqual(expect.objectContaining({
      protocollo: { numeroProtocollo: 111, annoProtocollo: 2026, dataProtocollazione: '13/07/2026' },
    }));
  });

  it('send() fallisce se protocolla è true e la protocollazione fallisce', async () => {
    mockProtocollo.protocolla.mockRejectedValueOnce(new Error('Protocollazione fallita (7): Classifica non valida'));
    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario Rossi', email: null, pec: null };
    const campaign = { id: 'camp-1', name: 'TARI', channelConfig: { subject: 'Avviso', body: 'Testo.', protocolla: true } };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(/Protocollazione fallita/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
