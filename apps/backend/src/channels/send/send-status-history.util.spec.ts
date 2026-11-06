import { extractSendStatusHistory, extractSendDigitalDomicile, extractSendAnalogCost, extractSendTimeline } from './send-status-history.util.js';

describe('send-status-history.util', () => {
  describe('extractSendStatusHistory', () => {
    it('estrae lo storico stati dalla notifica', () => {
      const data = { notificationStatusHistory: [{ status: 'ACCEPTED', activeFrom: '2026-01-01T00:00:00Z' }] };
      expect(extractSendStatusHistory(data)).toEqual([{ status: 'ACCEPTED', activeFrom: '2026-01-01T00:00:00Z' }]);
    });
  });

  describe('extractSendDigitalDomicile', () => {
    it('estrae il domicilio digitale', () => {
      const data = { timeline: [{ category: 'SEND_DIGITAL_DOMICILE', details: { digitalAddress: { type: 'PEC', address: 'a@pec.it' } } }] };
      expect(extractSendDigitalDomicile(data)).toEqual({ type: 'PEC', address: 'a@pec.it', source: null });
    });
  });

  describe('extractSendAnalogCost', () => {
    it('somma analogCost di tutti gli eventi SEND_ANALOG_DOMICILE con dettagli SendAnalogDetails', () => {
      const data = {
        timeline: [
          { category: 'SEND_DIGITAL_DOMICILE', details: { digitalAddress: { type: 'PEC', address: 'x@pec.it' } } },
          { category: 'SEND_ANALOG_DOMICILE', details: { productType: 'AR', analogCost: 970, envelopeWeight: 20, numberOfPages: 2 } },
        ],
      };

      const result = extractSendAnalogCost(data);

      expect(result.analogCostCents).toBe(970);
      expect(result.events).toEqual([{ productType: 'AR', analogCostCents: 970, envelopeWeight: 20, numberOfPages: 2 }]);
    });

    it('somma più eventi analogici sullo stesso IUN (es. rispedizione dopo tentativo fallito)', () => {
      const data = {
        timeline: [
          { category: 'SEND_ANALOG_DOMICILE', details: { productType: 'RS', analogCost: 400, envelopeWeight: 10, numberOfPages: 1 } },
          { category: 'SEND_SIMPLE_REGISTERED_LETTER', details: { productType: 'RS', analogCost: 450, envelopeWeight: 10, numberOfPages: 1 } },
        ],
      };

      const result = extractSendAnalogCost(data);

      expect(result.analogCostCents).toBe(850);
      expect(result.events).toHaveLength(2);
    });

    it('ritorna 0/array vuoto se nessun evento analogico è presente (notifica rimasta digitale)', () => {
      const data = { timeline: [{ category: 'SEND_DIGITAL_DOMICILE', details: { digitalAddress: { type: 'PEC', address: 'x@pec.it' } } }] };

      const result = extractSendAnalogCost(data);

      expect(result.analogCostCents).toBe(0);
      expect(result.events).toEqual([]);
    });

    it('gestisce timeline assente senza lanciare', () => {
      const result = extractSendAnalogCost({});

      expect(result.analogCostCents).toBe(0);
      expect(result.events).toEqual([]);
    });
  });
  describe('extractSendTimeline', () => {
    it('tiene i normalizzati e i dettagli, senza indirizzi né dati del destinatario', () => {
      const data = {
        timeline: [
          { category: 'REQUEST_ACCEPTED', timestamp: '2026-10-13T09:46:43Z', details: {} },
          { category: 'SEND_ANALOG_DOMICILE', timestamp: '2026-10-13T09:47:30Z', details: { physicalAddress: { address: 'VIA ROMA 1' }, productType: 'AR', analogCost: 494, sentAttemptMade: 0 } },
          { category: 'SEND_ANALOG_PROGRESS', timestamp: '2026-10-20T07:58:00Z', details: { deliveryDetailCode: 'RECRN010', registeredLetterCode: '123' } },
          { category: 'SEND_ANALOG_FEEDBACK', timestamp: '2026-10-23T13:18:08Z', details: { physicalAddress: { address: 'VIA ROMA 1' }, responseStatus: 'OK', deliveryDetailCode: 'RECRN003C', sentAttemptMade: 0 } },
          { category: 'SEND_COURTESY_MESSAGE', timestamp: '2026-10-13T09:47:00Z', details: { digitalAddress: { type: 'EMAIL', address: 'mario@example.it' } } },
          { category: 'NOTIFICATION_RADD_RETRIEVED', timestamp: '2026-10-26T10:51:36Z', details: { raddType: 'ALT', raddTransactionId: 'x' } },
          { category: 'REFINEMENT', timestamp: '2026-11-02T13:18:08Z', details: {} },
        ],
      };

      const result = extractSendTimeline(data);

      expect(result).toEqual([
        { category: 'REQUEST_ACCEPTED', at: '2026-10-13T09:46:43Z', details: {} },
        { category: 'SEND_ANALOG_DOMICILE', at: '2026-10-13T09:47:30Z', productType: 'AR', attempt: 0, details: { productType: 'AR', analogCost: 494, sentAttemptMade: 0 } },
        { category: 'SEND_ANALOG_PROGRESS', at: '2026-10-20T07:58:00Z', code: 'RECRN010', registeredLetterCode: '123', details: { deliveryDetailCode: 'RECRN010', registeredLetterCode: '123' } },
        { category: 'SEND_ANALOG_FEEDBACK', at: '2026-10-23T13:18:08Z', code: 'RECRN003C', responseStatus: 'OK', attempt: 0, details: { responseStatus: 'OK', deliveryDetailCode: 'RECRN003C', sentAttemptMade: 0 } },
        { category: 'SEND_COURTESY_MESSAGE', at: '2026-10-13T09:47:00Z', channel: 'EMAIL', details: {} },
        { category: 'NOTIFICATION_RADD_RETRIEVED', at: '2026-10-26T10:51:36Z', raddType: 'ALT', details: { raddType: 'ALT', raddTransactionId: 'x' } },
        { category: 'REFINEMENT', at: '2026-11-02T13:18:08Z', details: {} },
      ]);
      expect(JSON.stringify(result)).not.toMatch(/VIA ROMA|mario@example/);
    });

    it('keeps categories outside the old whitelist', () => {
      const data = { timeline: [{ category: 'SCHEDULE_REFINEMENT', timestamp: '2026-11-02T10:00:00Z', details: { recIndex: 0, schedulingDate: '2026-11-23T10:00:00Z' } }] };

      expect(extractSendTimeline(data)).toEqual([
        { category: 'SCHEDULE_REFINEMENT', at: '2026-11-02T10:00:00Z', details: { recIndex: 0, schedulingDate: '2026-11-23T10:00:00Z' } },
      ]);
    });

    it('strips PII keys at any depth', () => {
      const data = {
        timeline: [{
          category: 'SEND_DIGITAL_DOMICILE',
          timestamp: '2026-11-02T10:00:00Z',
          details: {
            physicalAddress: { address: 'VIA ROMA 1', zip: '00100' },
            digitalAddress: { type: 'PEC', address: 'rossi@pec.example' },
            attachments: [{ documentType: 'AR', physicalAddress: { address: 'X' } }],
            recipient: { taxId: 'RSSMRA80A01H501U' },
            analogCost: 900,
          },
        }],
      };

      const [ev] = extractSendTimeline(data);

      expect(ev.details).toEqual({ attachments: [{ documentType: 'AR' }], analogCost: 900 });
      expect(ev.channel).toBe('PEC');
      const json = JSON.stringify(ev);
      expect(json).not.toContain('RSSMRA80A01H501U');
      expect(json).not.toContain('VIA ROMA');
      expect(json).not.toContain('rossi@pec');
    });

    it('strips address details, delegate info, analog address rows and refusal detail', () => {
      const data = {
        timeline: [{
          category: 'REQUEST_REFUSED',
          timestamp: '2026-11-02T10:00:00Z',
          details: {
            foundAddress: { address: 'VIA X', addressDetails: 'SCALA B INT 4' },
            addressDetails: 'PIANO 3 SCALA C',
            delegateInfo: { internalId: 'x-int', operatorUuid: 'y-op', mandateId: 'z-man' },
            prepareRequest: {
              fullname: 'ROSSI MARIO',
              nameRow2: 'PRESSO ACME SRL',
              addressRow2: 'CORTILE INTERNO',
              cap: '00199',
              city: 'CITTAFINTA',
              city2: 'FRAZIONEFINTA',
              pr: 'ZZ',
              country: 'ITALIAFINTA',
              productType: 'AR',
            },
            refusalReasons: [{ errorCode: 'E1', detail: 'RSSMRA80A01H501U non valido' }],
          },
        }],
      };

      const [ev] = extractSendTimeline(data);

      expect(ev.details).toEqual({ prepareRequest: { productType: 'AR' }, refusalReasons: [{ errorCode: 'E1' }] });
      const json = JSON.stringify(ev);
      for (const v of ['VIA X', 'SCALA B', 'PIANO 3', 'x-int', 'y-op', 'z-man', 'ROSSI MARIO', 'ACME SRL', 'CORTILE', '00199', 'CITTAFINTA', 'FRAZIONEFINTA', '"ZZ"', 'ITALIAFINTA', 'RSSMRA80A01H501U']) {
        expect(json).not.toContain(v);
      }
    });

    it('keeps detail outside refusalReasons', () => {
      const data = { timeline: [{ category: 'X', timestamp: '2026-11-02T10:00:00Z', details: { detail: 'ok' } }] };
      expect(extractSendTimeline(data)[0].details).toEqual({ detail: 'ok' });
    });

    it('keeps event timestamp at while stripping details.at', () => {
      const data = { timeline: [{ category: 'REFINEMENT', timestamp: '2026-11-02T10:00:00Z', details: { at: 'VIA X' } }] };

      const [ev] = extractSendTimeline(data);

      expect(ev.at).toBe('2026-11-02T10:00:00Z');
      expect(ev.details).toEqual({});
    });

    it('timeline assente → array vuoto', () => {
      expect(extractSendTimeline({})).toEqual([]);
    });
  });
});
