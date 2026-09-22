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

  it('CF fisico trovato solo su App IO: nell\'aggregato con "attivo" — resta un "trovato" anche senza domicilio digitale', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: { RSSMRA85M01H501Z: true, VRDLGI80A01H501W: false },
      registroImpreseResults: {},
    });
    expect(result.appIoCsv).toContain('RSSMRA85M01H501Z');
    expect(result.appIoCsv).not.toContain('VRDLGI80A01H501W');
    expect(result.aggregatoCsv).toMatch(/"RSSMRA85M01H501Z","Mario Rossi","","attivo"/);
    // VRDLGI: né INAD né App IO né Registro Imprese → assente, MAI nell'aggregato
    expect(result.aggregatoCsv).not.toContain('VRDLGI80A01H501W');
    expect(result.assentiCsv).toContain('VRDLGI80A01H501W');
  });

  it('CF fisico senza nessun risultato: finisce SOLO in assenti, mai nell\'aggregato', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: { RSSMRA85M01H501Z: false, VRDLGI80A01H501W: false },
      registroImpreseResults: {},
    });
    expect(result.assentiCsv).toContain('RSSMRA85M01H501Z');
    expect(result.assentiCsv).toContain('VRDLGI80A01H501W');
    expect(result.aggregatoCsv).not.toContain('RSSMRA85M01H501Z');
    expect(result.aggregatoCsv).not.toContain('VRDLGI80A01H501W');
  });

  it('PIVA trovata su Registro Imprese: nell\'aggregato, colonna App IO vuota (mai "n.d."), mai in assenti', () => {
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

  it('CF assente/malformato nel tracciato sorgente (dato mancante, non un bug di parsing): SOLO in assenti, mai nell\'aggregato', () => {
    const result = buildDomicileVerificationCsvs({
      sourceCsv: 'cf,nome\n,Riga senza CF\n',
      hasHeaders: true,
      cfColumn: 'cf',
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: {},
    });
    expect(result.assentiCsv).toContain('Riga senza CF');
    expect(result.aggregatoCsv).not.toContain('Riga senza CF');
    expect(result.aggregatoCsv).not.toContain('n.d.');
  });

  it('PIVA non trovata (chiave assente da registroImpreseResults): finisce in assenti, mai nell\'aggregato', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: { '12345678901': 'acme@pec.it' }, // 98765432109 mai interrogata/trovata
    });
    expect(result.assentiCsv).toContain('98765432109');
    expect(result.aggregatoCsv).not.toContain('98765432109');
  });

  it('PIVA con esito "non trovata" esplicito (valore null): finisce comunque in assenti, mai nell\'aggregato', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: { '98765432109': null },
    });
    expect(result.assentiCsv).toContain('98765432109');
    expect(result.aggregatoCsv).not.toContain('98765432109');
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

  it('assentiCsv e aggregatoCsv sono SEMPRE stringhe — a zero risultati assentiCsv ha tutte le righe, aggregatoCsv è vuoto (solo header)', () => {
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
    // aggregato: zero righe trovate, resta solo l'header
    expect(result.aggregatoCsv).not.toContain('RSSMRA85M01H501Z');
    expect(result.aggregatoCsv).not.toContain('VRDLGI80A01H501W');
    expect(result.aggregatoCsv).not.toContain('12345678901');
    expect(result.aggregatoCsv).not.toContain('98765432109');
  });

  it('aggregatoCsv contiene SOLO le righe trovate (mutuamente esclusivo con assentiCsv)', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: { RSSMRA85M01H501Z: 'mario@pec.it' },
      appIoResults: {},
      registroImpreseResults: { '12345678901': 'acme@pec.it' },
    });
    expect(result.aggregatoCsv).toContain('RSSMRA85M01H501Z');
    expect(result.aggregatoCsv).toContain('12345678901');
    // VRDLGI e 98765432109 non trovati da nessuna fonte: assenti, non nell'aggregato
    expect(result.aggregatoCsv).not.toContain('VRDLGI80A01H501W');
    expect(result.aggregatoCsv).not.toContain('98765432109');
    expect(result.assentiCsv).toContain('VRDLGI80A01H501W');
    expect(result.assentiCsv).toContain('98765432109');
    expect(result.assentiCsv).not.toContain('RSSMRA85M01H501Z');
    expect(result.assentiCsv).not.toContain('12345678901');
  });
});
