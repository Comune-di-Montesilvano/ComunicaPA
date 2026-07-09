import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditLog } from '../entities/audit-log.entity';
import { AuditLogsService } from './audit-logs.service';

const mockAuditLogRepo = {
  create: jest.fn(),
  save: jest.fn(),
  findAndCount: jest.fn(),
};

describe('AuditLogsService', () => {
  let service: AuditLogsService;
  let repo: jest.Mocked<any>;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        AuditLogsService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: mockAuditLogRepo,
        },
      ],
    }).compile();

    service = module.get<AuditLogsService>(AuditLogsService);
    repo = module.get(getRepositoryToken(AuditLog));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('log', () => {
    it('should create and save a new audit log entry', async () => {
      const input = {
        campaignId: '9da0865f-43e6-4b0f-ae50-a665f71884bd',
        campaignName: 'Test Campaign',
        operator: 'albina.disalvo',
        action: 'LAUNCH',
        details: { launched: 5 },
      };

      const mockSaved = { id: 'some-uuid', ...input, createdAt: new Date() };
      repo.create.mockReturnValue(input);
      repo.save.mockResolvedValue(mockSaved);

      const result = await service.log(input);

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
        campaignId: input.campaignId,
        campaignName: input.campaignName,
        operator: input.operator,
        action: input.action,
        details: input.details,
      }));
      expect(repo.save).toHaveBeenCalledWith(input);
      expect(result).toEqual(mockSaved);
    });
  });

  describe('findAll', () => {
    it('should return paginated audit logs with search filter', async () => {
      const mockLogs = [
        { id: '1', operator: 'operator', action: 'CREATE', campaignName: 'Camp1', createdAt: new Date() },
        { id: '2', operator: 'admin', action: 'LAUNCH', campaignName: 'Camp2', createdAt: new Date() },
      ];

      repo.findAndCount.mockResolvedValue([mockLogs, 2]);

      const result = await service.findAll({ page: 2, pageSize: 10, search: 'Camp' });

      expect(repo.findAndCount).toHaveBeenCalledWith({
        where: [
          { operator: expect.any(Object) },
          { campaignName: expect.any(Object) },
          { action: expect.any(Object) },
        ],
        order: { createdAt: 'DESC' },
        skip: 10,
        take: 10,
      });

      expect(result).toEqual({
        data: mockLogs,
        total: 2,
        page: 2,
        pageSize: 10,
      });
    });

    it('should fall back to defaults when no parameters are provided', async () => {
      repo.findAndCount.mockResolvedValue([[], 0]);

      await service.findAll({});

      expect(repo.findAndCount).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: 'DESC' },
        skip: 0,
        take: 50,
      });
    });
  });
});
