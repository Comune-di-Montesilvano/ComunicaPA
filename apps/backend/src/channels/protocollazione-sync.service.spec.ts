import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProtocollazioneSyncService } from './protocollazione-sync.service';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { ProtocolloService } from '../protocollo/protocollo.service';
import { AttachmentService } from '../attachments/attachment.service';

describe('ProtocollazioneSyncService', () => {
  let service: ProtocollazioneSyncService;
  const mockQb = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
  };
  const mockAttemptRepo = {
    createQueryBuilder: jest.fn(() => mockQb),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const mockProtocollo = { protocolla: jest.fn() };
  const mockAttachments = { generatePdfBuffer: jest.fn().mockResolvedValue(Buffer.from('%PDF')) };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAttemptRepo.createQueryBuilder.mockReturnValue(mockQb);
    const module = await Test.createTestingModule({
      providers: [
        ProtocollazioneSyncService,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: ProtocolloService, useValue: mockProtocollo },
        { provide: AttachmentService, useValue: mockAttachments },
      ],
    }).compile();
    service = module.get(ProtocollazioneSyncService);
  });

  it('interroga attempt QUEUED non protocollati di campagne con protocolla=true', async () => {
    mockQb.getMany.mockResolvedValueOnce([]);
    await service.handleCron();
    expect(mockQb.where).toHaveBeenCalledWith('attempt.status = :status', { status: AttemptStatus.QUEUED });
    expect(mockQb.andWhere).toHaveBeenCalledWith('attempt.protocolled_at IS NULL');
    expect(mockQb.andWhere).toHaveBeenCalledWith("campaign.channel_config ->> 'protocolla' = 'true'");
  });

  it('protocolla un attempt e scrive protocolNumber/protocolYear/protocolledAt', async () => {
    const attempt: Partial<NotificationAttempt> = {
      id: 'att-1',
      recipient: {
        codiceFiscale: 'RSSMRA85M01H501Z',
        fullName: 'Mario Rossi',
        campaign: { name: 'TARI', channelConfig: { subject: 'Avviso TARI' } },
      } as any,
    };
    mockQb.getMany.mockResolvedValueOnce([attempt]);
    mockProtocollo.protocolla.mockResolvedValueOnce({ numeroProtocollo: 111, annoProtocollo: 2026, dataProtocollazione: '14/07/2026' });

    await service.handleCron();

    expect(mockProtocollo.protocolla).toHaveBeenCalledWith(expect.objectContaining({
      oggetto: 'Avviso TARI',
      destinatario: expect.objectContaining({ codiceFiscale: 'RSSMRA85M01H501Z', nome: 'Mario', cognome: 'Rossi' }),
    }));
    expect(mockAttemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'att-1',
      protocolNumber: 111,
      protocolYear: 2026,
      protocolledAt: expect.any(Date),
    }));
  });

  it('non interrompe il batch se un attempt fallisce la protocollazione', async () => {
    const attempt1: Partial<NotificationAttempt> = {
      id: 'att-1',
      recipient: { codiceFiscale: 'AAA', fullName: 'A B', campaign: { name: 'X', channelConfig: {} } } as any,
    };
    const attempt2: Partial<NotificationAttempt> = {
      id: 'att-2',
      recipient: { codiceFiscale: 'BBB', fullName: 'C D', campaign: { name: 'X', channelConfig: {} } } as any,
    };
    mockQb.getMany.mockResolvedValueOnce([attempt1, attempt2]);
    mockProtocollo.protocolla
      .mockRejectedValueOnce(new Error('SOAP timeout'))
      .mockResolvedValueOnce({ numeroProtocollo: 5, annoProtocollo: 2026, dataProtocollazione: '14/07/2026' });

    await service.handleCron();

    expect(mockProtocollo.protocolla).toHaveBeenCalledTimes(2);
    expect(mockAttemptRepo.save).toHaveBeenCalledTimes(1);
    expect(mockAttemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'att-2', protocolNumber: 5 }));
  });
});
