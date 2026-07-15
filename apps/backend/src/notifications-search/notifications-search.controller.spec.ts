import { Test } from '@nestjs/testing';
import { NotificationsSearchController } from './notifications-search.controller';
import { NotificationsSearchService } from './notifications-search.service';

describe('NotificationsSearchController', () => {
  const svcMock = {
    search: jest.fn(),
    getDetail: jest.fn(),
    getSendLegalFacts: jest.fn(),
    downloadSendLegalFact: jest.fn(),
  };

  let controller: NotificationsSearchController;

  const makeRes = () => {
    const res: any = {
      setHeader: jest.fn(),
      status: jest.fn(),
      json: jest.fn(),
      end: jest.fn(),
    };
    res.status.mockReturnValue(res);
    return res;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsSearchController],
      providers: [{ provide: NotificationsSearchService, useValue: svcMock }],
    }).compile();
    controller = moduleRef.get(NotificationsSearchController);
  });

  describe('getSendLegalFacts', () => {
    it('delega a svc.getSendLegalFacts e ritorna il risultato', async () => {
      const recipientId = 'rec-1';
      svcMock.getSendLegalFacts.mockResolvedValueOnce({ items: [{ legalFactId: 'key1', category: 'SENDER_ACK' }] });

      const result = await controller.getSendLegalFacts(recipientId);

      expect(svcMock.getSendLegalFacts).toHaveBeenCalledWith(recipientId);
      expect(result).toEqual({ items: [{ legalFactId: 'key1', category: 'SENDER_ACK' }] });
    });

    it('ritorna {items: []} quando il servizio non trova uno iun', async () => {
      const recipientId = 'rec-2';
      svcMock.getSendLegalFacts.mockResolvedValueOnce({ items: [] });

      const result = await controller.getSendLegalFacts(recipientId);

      expect(result).toEqual({ items: [] });
    });
  });

  describe('downloadSendLegalFact', () => {
    it('ready:true — imposta header e fa lo stream del buffer, senza status/json', async () => {
      const buffer = Buffer.from('contenuto-pdf');
      svcMock.downloadSendLegalFact.mockResolvedValueOnce({
        ready: true,
        filename: 'documento.pdf',
        contentType: 'application/pdf',
        buffer,
      });
      const res = makeRes();

      await controller.downloadSendLegalFact('rec-1', 'key1', res);

      expect(svcMock.downloadSendLegalFact).toHaveBeenCalledWith('rec-1', 'key1');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="documento.pdf"');
      expect(res.end).toHaveBeenCalledWith(buffer);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('ready:false — risponde 200 con JSON {ready:false, retryAfterSeconds, error}, senza header/end', async () => {
      svcMock.downloadSendLegalFact.mockResolvedValueOnce({
        ready: false,
        retryAfterSeconds: 30,
        error: 'Documento non ancora disponibile',
      });
      const res = makeRes();

      await controller.downloadSendLegalFact('rec-1', 'key1', res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        ready: false,
        retryAfterSeconds: 30,
        error: 'Documento non ancora disponibile',
      });
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });

    it('sanifica le virgolette nel filename nell\'header Content-Disposition', async () => {
      const buffer = Buffer.from('x');
      svcMock.downloadSendLegalFact.mockResolvedValueOnce({
        ready: true,
        filename: 'doc"ument".pdf',
        contentType: 'application/pdf',
        buffer,
      });
      const res = makeRes();

      await controller.downloadSendLegalFact('rec-1', 'key1', res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="document.pdf"');
    });
  });
});
