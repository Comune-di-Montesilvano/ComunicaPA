import { Test } from '@nestjs/testing';
import { MailConfigsController } from './mail-configs.controller';
import { MailConfigsService } from './mail-configs.service';

describe('MailConfigsController', () => {
  let controller: MailConfigsController;
  const svc = {
    listMasked: jest.fn().mockResolvedValue([{ id: '1' }]),
    create: jest.fn().mockResolvedValue({ id: '2' }),
    update: jest.fn().mockResolvedValue({ id: '1' }),
    remove: jest.fn().mockResolvedValue(undefined),
    test: jest.fn().mockResolvedValue({ success: true, message: 'ok' }),
    setActive: jest.fn().mockResolvedValue({ id: '1', active: false }),
    setDefault: jest.fn().mockResolvedValue({ id: '1', isDefault: true }),
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [MailConfigsController],
      providers: [{ provide: MailConfigsService, useValue: svc }],
    }).compile();
    controller = module.get(MailConfigsController);
  });

  it('GET lista filtra per tipo', async () => {
    const res = await controller.list('EMAIL');
    expect(svc.listMasked).toHaveBeenCalledWith('EMAIL');
    expect(res).toEqual({ configs: [{ id: '1' }] });
  });

  it('POST /:id/test delega al service', async () => {
    const res = await controller.test('abc', { to: 'x@y.it' });
    expect(svc.test).toHaveBeenCalledWith('abc', 'x@y.it');
    expect(res.success).toBe(true);
  });

  it('PATCH /:id/active delega al service', async () => {
    await controller.setActive('abc', { active: false });
    expect(svc.setActive).toHaveBeenCalledWith('abc', false);
  });

  it('PATCH /:id/default delega al service', async () => {
    const res = await controller.setDefault('abc');
    expect(svc.setDefault).toHaveBeenCalledWith('abc');
    expect(res.isDefault).toBe(true);
  });
});
