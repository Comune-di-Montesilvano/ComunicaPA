import { BadRequestException } from '@nestjs/common';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

describe('CampaignsController', () => {
  let controller: CampaignsController;
  const mockService = {
    getRecipientStats: jest.fn().mockResolvedValue({ campaignId: 'uuid-1', page: 1, pageSize: 50, total: 0, items: [] }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new CampaignsController(mockService as unknown as CampaignsService);
  });

  describe('getRecipientStats', () => {
    it('usa i valori di default quando page/pageSize non sono forniti', async () => {
      await controller.getRecipientStats('uuid-1', undefined, undefined);
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 1, 50);
    });

    it('rifiuta un page non numerico con BadRequestException', () => {
      expect(() => controller.getRecipientStats('uuid-1', 'abc', undefined)).toThrow(BadRequestException);
      expect(mockService.getRecipientStats).not.toHaveBeenCalled();
    });

    it('rifiuta un pageSize non numerico con BadRequestException', () => {
      expect(() => controller.getRecipientStats('uuid-1', undefined, 'xyz')).toThrow(BadRequestException);
      expect(mockService.getRecipientStats).not.toHaveBeenCalled();
    });

    it('rifiuta un page negativo con BadRequestException', () => {
      expect(() => controller.getRecipientStats('uuid-1', '-1', undefined)).toThrow(BadRequestException);
      expect(mockService.getRecipientStats).not.toHaveBeenCalled();
    });

    it('rifiuta un pageSize pari a zero con BadRequestException', () => {
      expect(() => controller.getRecipientStats('uuid-1', undefined, '0')).toThrow(BadRequestException);
      expect(mockService.getRecipientStats).not.toHaveBeenCalled();
    });

    it('accetta valori validi e li inoltra al servizio', async () => {
      await controller.getRecipientStats('uuid-1', '2', '25');
      expect(mockService.getRecipientStats).toHaveBeenCalledWith('uuid-1', 2, 25);
    });
  });
});
