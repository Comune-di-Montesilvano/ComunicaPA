import { describe, it, expect } from 'vitest';
import { pickWizardMailConfigId, coDeliveryModeWithServices } from '../src/wizard-defaults';

const cfg = (id: string, type: 'EMAIL' | 'PEC', active = true, isDefault = false) => ({ id, type, active, isDefault });

describe('pickWizardMailConfigId', () => {
  const configs = [
    cfg('e1', 'EMAIL'),
    cfg('e2', 'EMAIL', true, true),
    cfg('e3', 'EMAIL', false, true),
    cfg('p1', 'PEC'),
  ];

  it('vuoto con EMAIL già selezionata all\'apertura → predefinita attiva', () => {
    expect(pickWizardMailConfigId(configs, 'EMAIL', '')).toBe('e2');
  });

  it('predefinita non attiva ignorata, senza predefinita attiva → prima attiva', () => {
    expect(pickWizardMailConfigId([cfg('e3', 'EMAIL', false, true), cfg('e1', 'EMAIL')], 'EMAIL', '')).toBe('e1');
  });

  it('passaggio EMAIL → PEC: il mittente EMAIL non resta sulla PEC', () => {
    expect(pickWizardMailConfigId(configs, 'PEC', 'e2')).toBe('p1');
  });

  it('nessuna configurazione attiva del canale → vuoto', () => {
    expect(pickWizardMailConfigId([cfg('e1', 'EMAIL')], 'PEC', 'e1')).toBe('');
  });

  it('scelta dello stesso tipo conservata (anche non predefinita)', () => {
    expect(pickWizardMailConfigId(configs, 'EMAIL', 'e1')).toBe('e1');
  });

  it('id sconosciuto (bozza con configurazione eliminata) non sostituito in silenzio', () => {
    expect(pickWizardMailConfigId(configs, 'EMAIL', 'gone')).toBe('gone');
  });

  it('elenco non ancora caricato o canale senza mittente → nessun cambio', () => {
    expect(pickWizardMailConfigId([], 'EMAIL', '')).toBe('');
    expect(pickWizardMailConfigId([], 'EMAIL', 'e1')).toBe('e1');
    expect(pickWizardMailConfigId(configs, 'SEND', 'e1')).toBe('e1');
    expect(pickWizardMailConfigId(configs, 'APP_IO', '')).toBe('');
  });
});

describe('coDeliveryModeWithServices', () => {
  it('nessun servizio App IO configurato → disabilitata', () => {
    expect(coDeliveryModeWithServices('parallel', true, 0)).toBe('none');
    expect(coDeliveryModeWithServices('exclusive', true, 0)).toBe('none');
  });

  it('servizi presenti → modalità invariata', () => {
    expect(coDeliveryModeWithServices('parallel', true, 2)).toBe('parallel');
  });

  it('elenco non ancora caricato → modalità invariata', () => {
    expect(coDeliveryModeWithServices('parallel', false, 0)).toBe('parallel');
  });
});
