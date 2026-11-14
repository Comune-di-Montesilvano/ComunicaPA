import { describe, it, expect } from 'vitest';
import { sendDocumentLabel } from '../src/components/notification-detail/send-documents';

const item = (category: string, documentType?: string) => ({ legalFactId: 'lf-1', category, documentType });

describe('sendDocumentLabel', () => {
  it('categorie note: attestazioni opponibili a terzi', () => {
    expect(sendDocumentLabel(item('SENDER_ACK'))).toBe('Attestazione opponibile a terzi: notifica presa in carico');
    expect(sendDocumentLabel(item('RECIPIENT_ACCESS'))).toBe('Attestazione opponibile a terzi: avvenuto accesso');
    expect(sendDocumentLabel(item('PEC_RECEIPT'))).toBe('Ricevuta PEC');
  });

  it('AAR: avviso, non prova di consegna', () => {
    expect(sendDocumentLabel(item('AAR'))).toContain('non prova di consegna');
  });

  it('categoria sconosciuta: ricade sul nome della categoria', () => {
    expect(sendDocumentLabel(item('QUALCOSA_DI_NUOVO'))).toBe('QUALCOSA_DI_NUOVO');
  });

  describe('ANALOG_DELIVERY', () => {
    it('senza documentType: etichetta generica', () => {
      expect(sendDocumentLabel(item('ANALOG_DELIVERY'))).toBe('Documento della consegna cartacea');
    });

    it('documentType noto', () => {
      expect(sendDocumentLabel(item('ANALOG_DELIVERY', 'AR'))).toBe('Cartolina AR firmata (ricevuta di ritorno)');
      expect(sendDocumentLabel(item('ANALOG_DELIVERY', 'Copia Conforme AAR'))).toBe('Copia conforme dell\'avviso spedito (AAR)');
      expect(sendDocumentLabel(item('ANALOG_DELIVERY', 'Plico'))).toBe('Plico restituito (destinatario irreperibile)');
    });

    it('documentType sconosciuto: generico con il tipo tra parentesi', () => {
      expect(sendDocumentLabel(item('ANALOG_DELIVERY', 'XYZ'))).toBe('Documento della consegna cartacea (XYZ)');
    });
  });
});
