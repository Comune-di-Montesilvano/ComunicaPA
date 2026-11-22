import { buildDomicileVerificationCsvs } from './domicile-verification-csv.util.js';

const BOM = '﻿';

describe('buildDomicileVerificationCsvs', () => {
  const baseInput = {
    sourceCsv: 'cf,nome\nRSSMRA85M01H501Q,Mario Rossi\nVRDLGI80A01H501E,Luigi Verdi\n12345678903,Acme Srl\n98765432103,Beta Srl\n',
    hasHeaders: true,
    cfColumn: 'cf',
  };

  it('priorità Registro Imprese su INAD per un CF fisico trovato da entrambi', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: { RSSMRA85M01H501Q: 'mario.inad@pec.it' },
      appIoResults: {},
      registroImpreseResults: { RSSMRA85M01H501Q: 'mario.registro@pec.it' },
    });
    expect(result.aggregatoCsv).toContain('mario.registro@pec.it');
    expect(result.aggregatoCsv).not.toContain('mario.inad@pec.it');
    expect(result.inadCsv).toContain('mario.inad@pec.it'); // il tracciato INAD-specifico resta indipendente dalla priorità aggregata
    expect(result.registroImpreseCsv).toContain('mario.registro@pec.it');
  });

  it('App IO: solo i CF attivi nel tracciato App IO, "attivo" nell\'aggregato', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: { RSSMRA85M01H501Q: true, VRDLGI80A01H501E: false },
      registroImpreseResults: {},
    });
    expect(result.appIoCsv).toContain('RSSMRA85M01H501Q');
    expect(result.appIoCsv).not.toContain('VRDLGI80A01H501E');
    expect(result.aggregatoCsv).toContain('RSSMRA85M01H501Q,Mario Rossi,,attivo,\n');
    expect(result.assentiCsv).toContain('VRDLGI80A01H501E');
  });

  it('assenti: righe senza nessun risultato (CF, PIVA, valori non validi)', () => {
    const result = buildDomicileVerificationCsvs({
      sourceCsv: 'cf,nome\nRSSMRA85M01H501Q,Mario\n12345678903,Acme\n,Riga senza CF\n',
      hasHeaders: true,
      cfColumn: 'cf',
      inadFoundMap: {},
      appIoResults: { RSSMRA85M01H501Q: false },
      registroImpreseResults: { '12345678903': null },
    });
    expect(result.assentiCsv).toContain('RSSMRA85M01H501Q');
    expect(result.assentiCsv).toContain('12345678903');
    expect(result.assentiCsv).toContain('Riga senza CF');
  });

  it('appIoCsv/inadCsv/registroImpreseCsv sono null quando zero risultati', () => {
    const result = buildDomicileVerificationCsvs({ ...baseInput, inadFoundMap: {}, appIoResults: {}, registroImpreseResults: {} });
    expect(result.appIoCsv).toBeNull();
    expect(result.inadCsv).toBeNull();
    expect(result.registroImpreseCsv).toBeNull();
  });

  describe('aggregato = copia del tracciato + domicilio_digitale, app_io, errori', () => {
    it('tutte le righe, stesso ordine, celle originali invariate, anche quelle senza risultati', () => {
      const result = buildDomicileVerificationCsvs({
        ...baseInput,
        inadFoundMap: { RSSMRA85M01H501Q: 'mario@pec.it' },
        appIoResults: { RSSMRA85M01H501Q: true },
        registroImpreseResults: { '12345678903': 'acme@pec.it', '98765432103': null },
        registroImpreseFoundMap: { '12345678903': { found: true }, '98765432103': { found: true } },
      });
      expect(result.aggregatoCsv).toBe(
        BOM +
          'cf,nome,domicilio_digitale,app_io,errori\n' +
          'RSSMRA85M01H501Q,Mario Rossi,mario@pec.it,attivo,\n' +
          'VRDLGI80A01H501E,Luigi Verdi,,,\n' +
          '12345678903,Acme Srl,acme@pec.it,,\n' +
          '98765432103,Beta Srl,,,\n',
      );
    });

    it('mantiene separatore ";", virgolette originali e fine riga CRLF', () => {
      const result = buildDomicileVerificationCsvs({
        sourceCsv: 'cf;nome;importo\r\n"RSSMRA85M01H501Q";"Rossi; Mario";27,00\r\n',
        hasHeaders: true,
        cfColumn: 'cf',
        inadFoundMap: {},
        appIoResults: {},
        registroImpreseResults: {},
      });
      expect(result.aggregatoCsv).toBe(
        BOM + 'cf;nome;importo;domicilio_digitale;app_io;errori\r\n"RSSMRA85M01H501Q";"Rossi; Mario";27,00;;;\r\n',
      );
    });

    it('senza intestazione nel tracciato: nessuna riga di intestazione aggiunta', () => {
      const result = buildDomicileVerificationCsvs({
        sourceCsv: 'RSSMRA85M01H501Q,Mario\n',
        hasHeaders: false,
        cfColumn: 'Colonna 1',
        inadFoundMap: { RSSMRA85M01H501Q: 'mario@pec.it' },
        appIoResults: {},
        registroImpreseResults: {},
      });
      expect(result.aggregatoCsv).toBe(BOM + 'RSSMRA85M01H501Q,Mario,mario@pec.it,,\n');
    });

    it('errori del controllo formale: CF/PIVA non validi, mancanti, zeri persi', () => {
      const result = buildDomicileVerificationCsvs({
        sourceCsv: 'cf,nome\nRSSMRA85M01H501A,A\n12345678901,B\n,C\n159560366,D\n',
        hasHeaders: true,
        cfColumn: 'cf',
        inadFoundMap: {},
        appIoResults: {},
        // anche con un esito presente, un valore non valido non lo usa mai
        registroImpreseResults: { '12345678901': 'x@pec.it' },
      });
      const lines = result.aggregatoCsv.split('\n');
      expect(lines[1]).toContain('codice fiscale non valido');
      expect(lines[2]).toContain('partita IVA non valida');
      expect(lines[2]).not.toContain('x@pec.it');
      expect(lines[3]).toContain('codice fiscale/partita IVA mancante');
      expect(lines[4]).toContain('meno di 11 cifre');
    });

    it('PIVA non trovata nel Registro Imprese: avviso; trovata senza PEC: nessun errore; esito mancante: verifica non riuscita', () => {
      const result = buildDomicileVerificationCsvs({
        sourceCsv: 'cf\n12345678903\n98765432103\n00159560366\n',
        hasHeaders: true,
        cfColumn: 'cf',
        inadFoundMap: {},
        appIoResults: {},
        registroImpreseResults: { '12345678903': null, '98765432103': null, '00159560366': null },
        registroImpreseFoundMap: { '12345678903': { found: false }, '98765432103': { found: true } },
      });
      const lines = result.aggregatoCsv.split('\n');
      expect(lines[1]).toBe('12345678903,,,partita IVA non trovata nel Registro Imprese');
      expect(lines[2]).toBe('98765432103,,,');
      expect(lines[3]).toBe('00159560366,,,verifica Registro Imprese non riuscita');
    });

    const CEASED = { found: true, stato: 'CANCELLATA', dtCancellazione: '12/03/2019', causale: 'FALLIMENTO' };
    const CEASED_ERROR = 'impresa cessata nel Registro Imprese (stato: CANCELLATA, dal 12/03/2019, causale: FALLIMENTO)';

    it('impresa cessata con PEC: domicilio e errore', () => {
      const result = buildDomicileVerificationCsvs({
        sourceCsv: 'cf;nome\n12345678903;ACME SRL\n',
        hasHeaders: true,
        cfColumn: 'cf',
        inadFoundMap: {},
        appIoResults: {},
        registroImpreseResults: { '12345678903': 'acme@pec.it' },
        registroImpreseFoundMap: { '12345678903': CEASED },
      });
      expect(result.aggregatoCsv.split('\n')[1]).toBe(`12345678903;ACME SRL;acme@pec.it;;${CEASED_ERROR}`);
    });

    it('impresa cessata senza data né causale', () => {
      const result = buildDomicileVerificationCsvs({
        sourceCsv: 'cf;nome\n12345678903;ACME SRL\n',
        hasHeaders: true,
        cfColumn: 'cf',
        inadFoundMap: {},
        appIoResults: {},
        registroImpreseResults: { '12345678903': null },
        registroImpreseFoundMap: { '12345678903': { found: true, stato: 'CANCELLATA' } },
      });
      expect(result.aggregatoCsv.split('\n')[1]).toBe('12345678903;ACME SRL;;;impresa cessata nel Registro Imprese (stato: CANCELLATA)');
    });

    it('impresa cessata, separatore ",": cella quotata', () => {
      const result = buildDomicileVerificationCsvs({
        sourceCsv: 'cf,nome\n12345678903,ACME SRL\n',
        hasHeaders: true,
        cfColumn: 'cf',
        inadFoundMap: {},
        appIoResults: {},
        registroImpreseResults: { '12345678903': 'acme@pec.it' },
        registroImpreseFoundMap: { '12345678903': CEASED },
      });
      expect(result.aggregatoCsv.split('\n')[1]).toBe(`12345678903,ACME SRL,acme@pec.it,,"${CEASED_ERROR}"`);
    });

    it('CF fisico con ditta individuale cessata: nessun errore', () => {
      const result = buildDomicileVerificationCsvs({
        sourceCsv: 'cf\nRSSMRA80A01H501U\n',
        hasHeaders: true,
        cfColumn: 'cf',
        inadFoundMap: {},
        appIoResults: {},
        registroImpreseResults: { RSSMRA80A01H501U: null },
        registroImpreseFoundMap: { RSSMRA80A01H501U: { found: true, stato: 'CANCELLATA' } },
      });
      expect(result.aggregatoCsv.split('\n')[1]).toBe('RSSMRA80A01H501U,,,');
    });

    it('CF non presente in ANPR: avviso solo per i CF verificati con esito negativo', () => {
      const result = buildDomicileVerificationCsvs({
        sourceCsv: 'cf\nRSSMRA85M01H501Q\nVRDLGI80A01H501E\nRSSMRA80A01H501U\n',
        hasHeaders: true,
        cfColumn: 'cf',
        inadFoundMap: {},
        appIoResults: {},
        registroImpreseResults: {},
        anprResults: { RSSMRA85M01H501Q: false, VRDLGI80A01H501E: true }, // RSSMRA80… non verificato
      });
      const lines = result.aggregatoCsv.split('\n');
      expect(lines[1]).toContain('non presente in ANPR');
      expect(lines[2]).toBe('VRDLGI80A01H501E,,,');
      expect(lines[3]).toBe('RSSMRA80A01H501U,,,');
    });

    it('esistenza in vita (C007): deceduto e non presente; un solo messaggio "non presente" anche con C030', () => {
      const result = buildDomicileVerificationCsvs({
        sourceCsv: 'cf\nRSSMRA85M01H501Q\nVRDLGI80A01H501E\nRSSMRA80A01H501U\n',
        hasHeaders: true,
        cfColumn: 'cf',
        inadFoundMap: {},
        appIoResults: {},
        registroImpreseResults: {},
        anprResults: { VRDLGI80A01H501E: false },
        anprVitaResults: { RSSMRA85M01H501Q: 'N', VRDLGI80A01H501E: null, RSSMRA80A01H501U: 'S' },
      });
      const lines = result.aggregatoCsv.split('\n');
      expect(lines[1]).toBe('RSSMRA85M01H501Q,,,soggetto deceduto (ANPR)');
      expect(lines[2]).toBe('VRDLGI80A01H501E,,,codice fiscale non presente in ANPR (mai iscritto o cancellato)');
      expect(lines[3]).toBe('RSSMRA80A01H501U,,,');
    });

    it('celle aggiunte con separatore o virgolette vengono quotate', () => {
      const result = buildDomicileVerificationCsvs({
        sourceCsv: 'cf\n12345678903\n',
        hasHeaders: true,
        cfColumn: 'cf',
        inadFoundMap: {},
        appIoResults: {},
        registroImpreseResults: { '12345678903': 'a,"b"@pec.it' },
        registroImpreseFoundMap: { '12345678903': { found: true } },
      });
      expect(result.aggregatoCsv.split('\n')[1]).toBe('12345678903,"a,""b""@pec.it",,');
    });

    it('riga più corta dell\'intestazione: completata, colonne aggiunte allineate', () => {
      const result = buildDomicileVerificationCsvs({
        sourceCsv: 'cf,nome,via\nRSSMRA85M01H501Q,Mario\n',
        hasHeaders: true,
        cfColumn: 'cf',
        inadFoundMap: { RSSMRA85M01H501Q: 'm@pec.it' },
        appIoResults: {},
        registroImpreseResults: {},
      });
      expect(result.aggregatoCsv.split('\n')[1]).toBe('RSSMRA85M01H501Q,Mario,,m@pec.it,,');
    });
  });
});
