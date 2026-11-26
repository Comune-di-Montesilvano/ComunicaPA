import { describe, it, expect } from 'vitest';
import { sendTaxonomyLabel, sendTaxonomyOptions, type SendTaxonomyStat } from '../src/send-taxonomy';

const row = (taxonomyCode: string | null): SendTaxonomyStat => ({
  taxonomyCode, campaigns: 1, recipients: 1, perfected: 0, inProgress: 1, unreachable: 0, failed: 0, cancelled: 0, costCents: 0,
});

describe('sendTaxonomyLabel', () => {
  it('codice del catalogo PN: codice + titolo', () => {
    expect(sendTaxonomyLabel('010201P')).toBe('010201P · Notifiche Riscossione Tributi con pagamento');
  });

  it('codice fuori catalogo: solo il codice', () => {
    expect(sendTaxonomyLabel('999999N')).toBe('999999N');
  });

  it('assente: "Tassonomia non indicata"', () => {
    expect(sendTaxonomyLabel(null)).toBe('Tassonomia non indicata');
    expect(sendTaxonomyLabel('')).toBe('Tassonomia non indicata');
  });
});

describe('sendTaxonomyOptions', () => {
  it('scarta la riga senza codice e ordina per codice', () => {
    expect(sendTaxonomyOptions([row('010201P'), row(null), row('010101P')]).map((o) => o.code)).toEqual(['010101P', '010201P']);
  });
});
