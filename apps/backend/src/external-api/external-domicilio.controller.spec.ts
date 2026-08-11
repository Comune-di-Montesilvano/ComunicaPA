import { ExternalDomicilioController } from './external-domicilio.controller';
import { DomicilioService } from '../channels/domicilio/domicilio.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

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
    const result = await controller.cerca({ codiceFiscale: 'RSSMRA80A01H501U' }, req);
    expect(domicilioService.cercaDomicilio).toHaveBeenCalledWith('RSSMRA80A01H501U', 'external:Comune X');
    expect(result).toEqual({ success: true, codiceFiscale: 'RSSMRA80A01H501U', inad: {}, appIo: {}, anpr: {} });
  });

  it('logga su AuditLogsService con action EXTERNAL_DOMICILIO_SEARCH e il CF cercato', async () => {
    await controller.cerca({ codiceFiscale: 'RSSMRA80A01H501U' }, req);
    expect(audit.log).toHaveBeenCalledWith({
      operator: 'external:Comune X',
      action: 'EXTERNAL_DOMICILIO_SEARCH',
      details: { codiceFiscale: 'RSSMRA80A01H501U' },
    });
  });
});
