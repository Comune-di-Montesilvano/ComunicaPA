import { postalStatusLabel, POSTAL_STATUS_HISTORY_COLUMNS } from './postal-status-labels.util';

describe('postalStatusLabel', () => {
  it('traduce uno stato GBC noto', () => {
    expect(postalStatusLabel('Consegnato')).toBe('Consegnato');
    expect(postalStatusLabel('NonConsegnato')).toBe('Non consegnato');
  });
  it('ritorna "In corso" per null', () => {
    expect(postalStatusLabel(null)).toBe('In corso');
  });
  it('ritorna il valore grezzo per uno stato non mappato', () => {
    expect(postalStatusLabel('NUOVO_STATO_MAI_VISTO')).toBe('NUOVO_STATO_MAI_VISTO');
  });
  it('traduce lo stato sintetico FAILED (attempt fallito prima di raggiungere GlobalCom)', () => {
    expect(postalStatusLabel('FAILED')).toBe('Fallito');
  });
});

describe('POSTAL_STATUS_HISTORY_COLUMNS', () => {
  it('contiene 14 colonne, una per ciascuno stato GBC', () => {
    expect(POSTAL_STATUS_HISTORY_COLUMNS).toHaveLength(14);
    expect(POSTAL_STATUS_HISTORY_COLUMNS.map((c) => c.status)).toEqual([
      'Accettato', 'Sospeso', 'Verificato', 'Normalizzazione', 'Inviato', 'Elaborato',
      'AttesaStampa', 'Confermato', 'Rimandato', 'Consegnato', 'NonConsegnato',
      'ConsegnaParziale', 'Errore', 'Eliminato',
    ]);
  });
});
