import { ExternalDomicilioController } from './external-domicilio.controller.js';
import { DomicilioService } from '../channels/domicilio/domicilio.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';

describe('ExternalDomicilioController', () => {
  let controller: ExternalDomicilioController;
  let domicilioService: { cercaDomicilio: jest.Mock };
  let audit: { log: jest.Mock };
  const req = { apiClient: { id: 'client-1', name: 'Comune X' } } as any;

  beforeEach(() => {
    domicilioService = { cercaDomicilio: jest.fn().mockResolvedValue({ codiceFiscale: 'RSSMRA80A01H501U', inad: {}, appIo: {}, anpr: {} }) };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new ExternalDomicilioController(
      domicilioService as unknown as DomicilioService,
      audit as unknown as AuditLogsService,
    );
  });

  it('cerca delega a DomicilioService con label operatore "external:<name>" e ritorna success:true + risultato', async () => {
    const result = await controller.cerca({ taxId: 'rssmra80a01h501u' }, req);
    expect(domicilioService.cercaDomicilio).toHaveBeenCalledWith('RSSMRA80A01H501U', 'external:Comune X');
    expect(result).toEqual({ success: true, codiceFiscale: 'RSSMRA80A01H501U', inad: {}, appIo: {}, anpr: {} });
  });

  it('logga su AuditLogsService con action EXTERNAL_DOMICILIO_SEARCH e il taxId mascherato (mai il CF in chiaro)', async () => {
    await controller.cerca({ taxId: 'RSSMRA80A01H501U' }, req);
    expect(audit.log).toHaveBeenCalledWith({
      operator: 'external:Comune X',
      action: 'EXTERNAL_DOMICILIO_SEARCH',
      details: { taxId: '***501U' },
    });
  });

  it('accetta una Partita IVA e la passa a DomicilioService (che la instrada al Registro Imprese)', async () => {
    await controller.cerca({ taxId: '01234567890' }, req);
    expect(domicilioService.cercaDomicilio).toHaveBeenCalledWith('01234567890', 'external:Comune X');
  });
});
