import { AttachmentService } from './attachment.service';
import type { Recipient } from '../entities/recipient.entity';

describe('AttachmentService', () => {
  let service: AttachmentService;

  beforeEach(() => {
    service = new AttachmentService();
  });

  it('genera un buffer PDF quando non c\'è allegato personalizzato', async () => {
    const recipient = {
      id: 'r-1',
      campaignId: 'c-1',
      codiceFiscale: 'RSSMRA85M01H501Z',
      fullName: 'Mario Rossi',
      email: 'mario@example.com',
      pec: null,
      extraData: {},
      createdAt: new Date('2026-06-25'),
      campaign: { name: 'TARI 2026', description: 'Acconto', channelType: 'EMAIL', channelConfig: {} },
    } as unknown as Recipient;

    const buffer = await service.generatePdfBuffer(recipient);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});
