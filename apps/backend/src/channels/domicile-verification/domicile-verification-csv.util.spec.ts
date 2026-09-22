import { buildDomicileVerificationCsvs } from './domicile-verification-csv.util.js';

describe('buildDomicileVerificationCsvs', () => {
  const baseInput = {
    sourceCsv: 'cf,nome\nRSSMRA85M01H501Z,Mario Rossi\nVRDLGI80A01H501W,Luigi Verdi\n12345678901,Acme Srl\n98765432109,Beta Srl\n',
    hasHeaders: true,
    cfColumn: 'cf',
  };

  it('priorità Registro Imprese su INAD per un CF fisico trovato da entrambi', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: { RSSMRA85M01H501Z: 'mario.inad@pec.it' },
      appIoResults: {},
      registroImpreseResults: { RSSMRA85M01H501Z: 'mario.registro@pec.it' },
    });
    expect(result.aggregatoCsv).toContain('mario.registro@pec.it');
    expect(result.aggregatoCsv).not.toContain('mario.inad@pec.it');
    expect(result.inadCsv).toContain('mario.inad@pec.it'); // il tracciato INAD-specifico resta indipendente dalla priorità aggregata
    expect(result.registroImpreseCsv).toContain('mario.registro@pec.it');
  });

  it('CF fisico trovato solo su App IO: aggregato "attivo" per il trovato, vuoto per il negativo (mai "non attivo")', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: { RSSMRA85M01H501Z: true, VRDLGI80A01H501W: false },
      registroImpreseResults: {},
    });
    expect(result.appIoCsv).toContain('RSSMRA85M01H501Z');
    expect(result.appIoCsv).not.toContain('VRDLGI80A01H501W');
    expect(result.aggregatoCsv).toMatch(/"RSSMRA85M01H501Z","Mario Rossi","","attivo"/);
    expect(result.aggregatoCsv).toMatch(/"VRDLGI80A01H501W","Luigi Verdi","",""/);
  });

  it('CF fisico senza nessun risultato: finisce in assenti, domicilio vuoto, App IO vuoto (mai "non attivo")', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: { RSSMRA85M01H501Z: false, VRDLGI80A01H501W: false },
      registroImpreseResults: {},
    });
    expect(result.assentiCsv).toContain('RSSMRA85M01H501Z');
    expect(result.assentiCsv).toContain('VRDLGI80A01H501W');
    expect(result.aggregatoCsv).toMatch(/"RSSMRA85M01H501Z","Mario Rossi","",""/);
  });

  it('PIVA trovata su Registro Imprese: colonna App IO sempre vuota (mai "n.d."), mai in assenti', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: { '12345678901': 'acme@pec.it' },
    });
    expect(result.registroImpreseCsv).toContain('acme@pec.it');
    expect(result.assentiCsv).not.toContain('12345678901');
    expect(result.aggregatoCsv).toMatch(/"12345678901","Acme Srl","acme@pec\.it",""/);
  });

  it('CF assente/malformato nel tracciato sorgente (dato mancante, non un bug di parsing): aggregato vuoto sempre, mai "n.d."', () => {
    const result = buildDomicileVerificationCsvs({
      sourceCsv: 'cf,nome\n,Riga senza CF\n',
      hasHeaders: true,
      cfColumn: 'cf',
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: {},
    });
    expect(result.aggregatoCsv).toMatch(/"","Riga senza CF","",""/);
    expect(result.aggregatoCsv).not.toContain('n.d.');
    expect(result.assentiCsv).toContain('Riga senza CF');
  });

  it('PIVA non trovata (chiave assente da registroImpreseResults): finisce in assenti', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: { '12345678901': 'acme@pec.it' }, // 98765432109 mai interrogata/trovata
    });
    expect(result.assentiCsv).toContain('98765432109');
  });

  it('PIVA con esito "non trovata" esplicito (valore null): finisce comunque in assenti', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: { '98765432109': null },
    });
    expect(result.assentiCsv).toContain('98765432109');
  });

  it('appIoCsv/inadCsv/registroImpreseCsv sono null quando zero risultati (nessuna riga "se almeno un risultato")', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: {},
    });
    expect(result.appIoCsv).toBeNull();
    expect(result.inadCsv).toBeNull();
    expect(result.registroImpreseCsv).toBeNull();
  });

  it('assentiCsv e aggregatoCsv sono SEMPRE stringhe, anche a zero risultati (tutte le righe assenti)', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: {},
    });
    expect(typeof result.assentiCsv).toBe('string');
    expect(typeof result.aggregatoCsv).toBe('string');
    // tutte e 4 le righe del CSV sorgente sono assenti
    expect(result.assentiCsv).toContain('RSSMRA85M01H501Z');
    expect(result.assentiCsv).toContain('VRDLGI80A01H501W');
    expect(result.assentiCsv).toContain('12345678901');
    expect(result.assentiCsv).toContain('98765432109');
  });

  it('aggregatoCsv contiene SEMPRE tutte le righe, indipendentemente dall\'esito', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: { RSSMRA85M01H501Z: 'mario@pec.it' },
      appIoResults: {},
      registroImpreseResults: { '12345678901': 'acme@pec.it' },
    });
    expect(result.aggregatoCsv).toContain('RSSMRA85M01H501Z');
    expect(result.aggregatoCsv).toContain('VRDLGI80A01H501W');
    expect(result.aggregatoCsv).toContain('12345678901');
    expect(result.aggregatoCsv).toContain('98765432109');
  });
});
