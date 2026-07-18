import { EnrichmentEventsService } from './enrichment-events.service';

describe('EnrichmentEventsService', () => {
  let service: EnrichmentEventsService;

  beforeEach(() => {
    service = new EnrichmentEventsService();
  });

  it('subscribe riceve gli eventi emessi per lo stesso jobId dopo la subscription', () => {
    const received: unknown[] = [];
    service.subscribe('job-1', (e) => received.push(e));

    service.emitLog('job-1', { row: 1, pdf: 'a.pdf', detail: 'full', payload: { x: 1 } });
    service.emitTerminal('job-1', { type: 'done' });

    expect(received).toEqual([
      { type: 'log', row: 1, pdf: 'a.pdf', detail: 'full', payload: { x: 1 } },
      { type: 'done' },
    ]);
  });

  it('subscriber su un jobId diverso non riceve nulla', () => {
    const received: unknown[] = [];
    service.subscribe('job-1', (e) => received.push(e));

    service.emitLog('job-2', { row: 1, pdf: 'a.pdf', detail: 'full', payload: {} });

    expect(received).toEqual([]);
  });

  it('unsubscribe: nessun evento consegnato dopo la chiamata', () => {
    const received: unknown[] = [];
    const unsubscribe = service.subscribe('job-1', (e) => received.push(e));
    unsubscribe();

    service.emitLog('job-1', { row: 1, pdf: 'a.pdf', detail: 'summary', payload: {} });

    expect(received).toEqual([]);
  });

  it('multi-subscriber sullo stesso jobId ricevono entrambi lo stesso evento', () => {
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    service.subscribe('job-1', (e) => receivedA.push(e));
    service.subscribe('job-1', (e) => receivedB.push(e));

    service.emitTerminal('job-1', { type: 'error', message: 'boom' });

    expect(receivedA).toEqual([{ type: 'error', message: 'boom' }]);
    expect(receivedB).toEqual([{ type: 'error', message: 'boom' }]);
  });

  it('emit senza subscriber non lancia errori', () => {
    expect(() => service.emitLog('job-senza-subscriber', { row: 1, pdf: 'a.pdf', detail: 'summary', payload: {} })).not.toThrow();
  });
});
