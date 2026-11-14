import { describe, it, expect } from 'vitest';
import { describeSendTimelineEvent, type SendTimelineEvent } from '../src/components/notification-detail/send-timeline';

const AT = '2026-03-10T09:00:00.000Z';
const ev = (e: Partial<SendTimelineEvent> & { category: string }): SendTimelineEvent => ({ at: AT, ...e });

describe('describeSendTimelineEvent', () => {
  it('categoria sconosciuta: null (non si mostra)', () => {
    expect(describeSendTimelineEvent(ev({ category: 'QUALCOSA_DI_NUOVO' }))).toBeNull();
  });

  describe('domicilio digitale', () => {
    it('invio con canale PEC e indirizzo', () => {
      const r = describeSendTimelineEvent(ev({ category: 'SEND_DIGITAL_DOMICILE', channel: 'PEC', details: { digitalAddress: { type: 'PEC', address: 'rossi.mario@pec.example.it' } } }));
      expect(r).toEqual({ title: 'Inviata al domicilio digitale (PEC)', detail: 'Inviata a: rossi.mario@pec.example.it', tone: 'neutral' });
    });

    it('SERCQ: indirizzo interno non mostrato', () => {
      const r = describeSendTimelineEvent(ev({ category: 'SEND_DIGITAL_DOMICILE', channel: 'SERCQ', details: { digitalAddress: { type: 'SERCQ', address: 'x-pagopa-pn-sercq:interno' } } }));
      expect(r?.title).toBe('Inviata al domicilio digitale SEND');
      expect(r?.detail).not.toContain('x-pagopa');
    });

    it('secondo tentativo: suffisso nel titolo', () => {
      expect(describeSendTimelineEvent(ev({ category: 'SEND_DIGITAL_DOMICILE', attempt: 1 }))?.title).toBe('Inviata al domicilio digitale (secondo tentativo)');
    });

    it('feedback OK e KO', () => {
      expect(describeSendTimelineEvent(ev({ category: 'SEND_DIGITAL_FEEDBACK', responseStatus: 'OK' }))).toMatchObject({ title: 'Consegnata al domicilio digitale', tone: 'ok' });
      expect(describeSendTimelineEvent(ev({ category: 'SEND_DIGITAL_FEEDBACK', responseStatus: 'KO' }))).toMatchObject({ title: 'Mancata consegna al domicilio digitale', tone: 'ko' });
    });

    it('DIGITAL_FAILURE_WORKFLOW: passaggio al cartaceo', () => {
      expect(describeSendTimelineEvent(ev({ category: 'DIGITAL_FAILURE_WORKFLOW' }))).toMatchObject({ tone: 'warn' });
    });
  });

  describe('avviso di cortesia', () => {
    it('App IO: logo e dettaglio con prima lettera maiuscola', () => {
      const r = describeSendTimelineEvent(ev({ category: 'SEND_COURTESY_MESSAGE', channel: 'APPIO', details: { digitalAddress: { type: 'APPIO', address: 'ENABLED' }, ioSendMessageResult: 'SENT_COURTESY' } }));
      expect(r).toEqual({ title: 'Avviso di cortesia inviato via', detail: 'App IO attiva per il destinatario · messaggio recapitato in App IO', tone: 'neutral', logo: 'APP_IO' });
    });

    it('altri canali: titolo con etichetta e indirizzo', () => {
      const r = describeSendTimelineEvent(ev({ category: 'SEND_COURTESY_MESSAGE', channel: 'EMAIL', details: { digitalAddress: { type: 'EMAIL', address: 'rossi.mario@example.it' } } }));
      expect(r).toEqual({ title: 'Avviso di cortesia inviato via email', detail: 'Inviato a: rossi.mario@example.it', tone: 'neutral' });
    });
  });

  describe('PROBABLE_SCHEDULING_ANALOG_DATE', () => {
    const scheduled = ev({ category: 'PROBABLE_SCHEDULING_ANALOG_DATE', details: { schedulingAnalogDate: '2026-03-20T12:00:00.000Z' } });

    it('data futura: raccomandata prevista dal giorno', () => {
      expect(describeSendTimelineEvent(scheduled)?.title).toBe('Raccomandata prevista dal 20/03/2026');
    });

    it('superata dal cartaceo già partito: null', () => {
      expect(describeSendTimelineEvent(scheduled, [scheduled, ev({ category: 'SEND_ANALOG_DOMICILE' })])).toBeNull();
    });

    it('data uguale all\'evento (nessuna attesa) o non valida: null', () => {
      expect(describeSendTimelineEvent(ev({ category: 'PROBABLE_SCHEDULING_ANALOG_DATE', details: { schedulingAnalogDate: AT } }))).toBeNull();
      expect(describeSendTimelineEvent(ev({ category: 'PROBABLE_SCHEDULING_ANALOG_DATE', details: { schedulingAnalogDate: 'boh' } }))).toBeNull();
    });
  });

  describe('cartaceo', () => {
    it('spedizione: prodotto noto, secondo tentativo, indirizzo', () => {
      const r = describeSendTimelineEvent(ev({
        category: 'SEND_ANALOG_DOMICILE', productType: 'AR', attempt: 1,
        details: { physicalAddress: { address: 'Via Roma 1', zip: '00100', municipality: 'Roma', province: 'RM' } },
      }));
      expect(r).toEqual({ title: 'Affidata al recapitista: raccomandata A/R (secondo tentativo)', detail: 'Inviata a: Via Roma 1, 00100 Roma (RM)', tone: 'neutral' });
    });

    it('spedizione: indirizzo ripreso dalla preparazione dello stesso tentativo', () => {
      const prepare = ev({ category: 'PREPARE_ANALOG_DOMICILE', attempt: 0, details: { physicalAddress: { address: 'Via Milano 2', zip: '20100', municipality: 'Milano', province: 'MI' } } });
      const send = ev({ category: 'SEND_ANALOG_DOMICILE', attempt: 0 });
      expect(describeSendTimelineEvent(send, [prepare, send])?.detail).toBe('Inviata a: Via Milano 2, 20100 Milano (MI)');
    });

    it('indirizzo estero mostra lo stato, Italia no', () => {
      const mk = (foreignState: string) => describeSendTimelineEvent(ev({ category: 'SEND_ANALOG_DOMICILE', details: { physicalAddress: { address: 'Rue 1', municipality: 'Paris', foreignState } } }))?.detail;
      expect(mk('Francia')).toBe('Inviata a: Rue 1, Paris, Francia');
      expect(mk('Italia')).toBe('Inviata a: Rue 1, Paris');
    });

    it('indirizzo fisico non trovato', () => {
      expect(describeSendTimelineEvent(ev({ category: 'PREPARE_ANALOG_DOMICILE_FAILURE' }))).toMatchObject({ title: 'Indirizzo fisico non trovato', tone: 'ko' });
    });

    it('raccomandata semplice di avviso', () => {
      expect(describeSendTimelineEvent(ev({ category: 'SEND_SIMPLE_REGISTERED_LETTER' }))?.title).toBe('Raccomandata semplice di avviso affidata al recapitista');
    });

    it('recapito non riuscito e ritiro RADD', () => {
      expect(describeSendTimelineEvent(ev({ category: 'ANALOG_FAILURE_WORKFLOW' }))).toMatchObject({ tone: 'ko' });
      expect(describeSendTimelineEvent(ev({ category: 'NOTIFICATION_RADD_RETRIEVED' }))).toMatchObject({ tone: 'ok' });
    });
  });

  describe('SEND_ANALOG_PROGRESS', () => {
    it('senza codice o con codice intermedio (A/B): null', () => {
      expect(describeSendTimelineEvent(ev({ category: 'SEND_ANALOG_PROGRESS' }))).toBeNull();
      expect(describeSendTimelineEvent(ev({ category: 'SEND_ANALOG_PROGRESS', code: 'RECRN001A' }))).toBeNull();
      expect(describeSendTimelineEvent(ev({ category: 'SEND_ANALOG_PROGRESS', code: 'RECRN001B' }))).toBeNull();
    });

    it('codice noto', () => {
      expect(describeSendTimelineEvent(ev({ category: 'SEND_ANALOG_PROGRESS', code: 'RECRN010' }))).toEqual({ title: 'Destinatario assente: avviso di giacenza', detail: 'Codice evento RECRN010', tone: 'warn' });
      expect(describeSendTimelineEvent(ev({ category: 'SEND_ANALOG_PROGRESS', code: 'CON080' }))?.title).toBe('Stampata e imbustata');
    });

    it('codice sconosciuto: aggiornamento generico', () => {
      expect(describeSendTimelineEvent(ev({ category: 'SEND_ANALOG_PROGRESS', code: 'ZZZ999' }))).toEqual({ title: 'Aggiornamento del recapitista', detail: 'ZZZ999', tone: 'neutral' });
    });
  });

  describe('SEND_ANALOG_FEEDBACK', () => {
    it('OK con codice noto', () => {
      expect(describeSendTimelineEvent(ev({ category: 'SEND_ANALOG_FEEDBACK', code: 'RECRN001C', responseStatus: 'OK' }))).toEqual({ title: 'Esito recapito: consegnata', detail: 'RECRN001C', tone: 'ok' });
    });

    it('KO con causa nota', () => {
      expect(describeSendTimelineEvent(ev({ category: 'SEND_ANALOG_FEEDBACK', code: 'RECRN002F', responseStatus: 'KO', deliveryFailureCause: 'M01' }))).toEqual({ title: 'Esito recapito: irreperibilità assoluta', detail: 'destinatario irreperibile · RECRN002F', tone: 'ko' });
    });

    it('senza codice: esito generico e nessun dettaglio', () => {
      expect(describeSendTimelineEvent(ev({ category: 'SEND_ANALOG_FEEDBACK', responseStatus: 'KO' }))).toEqual({ title: 'Esito recapito: non consegnata', detail: null, tone: 'ko' });
      expect(describeSendTimelineEvent(ev({ category: 'SEND_ANALOG_FEEDBACK' }))).toMatchObject({ title: 'Esito recapito: consegnata', tone: 'ok' });
    });
  });
});
