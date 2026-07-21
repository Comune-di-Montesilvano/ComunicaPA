import { extractSendStatusHistory, extractSendDigitalDomicile, extractSendAnalogCost } from './send-status-history.util';

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
});
