import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationsSearchService } from './notifications-search.service';
import { Recipient } from '../entities/recipient.entity';

describe('NotificationsSearchService.search', () => {
  const qbMock = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
  };
  const recipientRepoMock = { createQueryBuilder: jest.fn(() => qbMock) };

  let service: NotificationsSearchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    qbMock.leftJoinAndSelect.mockReturnThis();
    qbMock.andWhere.mockReturnThis();
    qbMock.orderBy.mockReturnThis();
    qbMock.skip.mockReturnThis();
    qbMock.take.mockReturnThis();
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsSearchService,
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
  });

  it('applica il filtro codiceFiscale quando presente', async () => {
    qbMock.getManyAndCount.mockResolvedValue([[], 0]);
    await service.search({ codiceFiscale: 'rssmra80a01h501x', page: 1, pageSize: 20 });

    expect(qbMock.andWhere).toHaveBeenCalledWith('recipient.codiceFiscale = :cf', { cf: 'RSSMRA80A01H501X' });
  });

  it('mappa i risultati nel formato atteso', async () => {
    qbMock.getManyAndCount.mockResolvedValue([[
      {
        id: 'r1',
        campaignId: 'c1',
        codiceFiscale: 'RSSMRA80A01H501X',
        fullName: 'Mario Rossi',
        status: 'sent',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        campaign: { name: 'Avviso TARI', channelType: 'EMAIL' },
      },
    ], 1]);

    const result = await service.search({ page: 1, pageSize: 20 });

    expect(result).toEqual({
      rows: [{
        recipientId: 'r1',
        campaignId: 'c1',
        campaignName: 'Avviso TARI',
        codiceFiscale: 'RSSMRA80A01H501X',
        fullName: 'Mario Rossi',
        channelType: 'EMAIL',
        status: 'sent',
        createdAt: '2026-07-01T00:00:00.000Z',
      }],
      total: 1,
    });
  });
});
