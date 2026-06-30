import { Test } from '@nestjs/testing';
import { PostalStrategy } from './postal.strategy';
import { PdfService } from '../../pdf/pdf.service';

describe('PostalStrategy', () => {
  let strategy: PostalStrategy;
  let pdfService: jest.Mocked<PdfService>;

  beforeEach(async () => {
    const mockPdfService = { stampWithProtocol: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        PostalStrategy,
        { provide: PdfService, useValue: mockPdfService },
      ],
    }).compile();

    strategy = module.get(PostalStrategy);
    pdfService = module.get(PdfService);
  });

  it('is defined with channel POSTAL', () => {
    expect(strategy.channel).toBe('POSTAL');
  });

  it('send() chiama PdfService.stampWithProtocol con fileId e segnatura', async () => {
    const stampedId = 'template-tari_stamped_1234567890';
    pdfService.stampWithProtocol.mockResolvedValue(stampedId);

    const recipient = { codiceFiscale: 'RSSMRA85M01H501Z', fullName: 'Mario', email: null, pec: null };
    const campaign = {
      name: 'TARI 2024',
      channelConfig: { pdfTemplateId: 'template-tari' },
    };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(pdfService.stampWithProtocol).toHaveBeenCalledWith(
      'template-tari',
      expect.stringMatching(/^TARI\/RSSMRA85M01H501Z\/\d{8}$/),
    );
    expect(result.messageId).toBe(stampedId);
    expect(result.responsePayload).toEqual({ stampedId });
  });

  it('send() lancia BadRequestException se pdfTemplateId mancante in channelConfig', async () => {
    const recipient = { codiceFiscale: 'CF', fullName: null, email: null, pec: null };
    const campaign = { name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(
      'channelConfig.pdfTemplateId richiesto per canale POSTAL',
    );
  });
});
