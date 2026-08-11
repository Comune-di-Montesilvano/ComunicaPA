import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateExternalNotificationDto } from './create-external-notification.dto';

async function validateDto(payload: Record<string, unknown>) {
  const dto = plainToInstance(CreateExternalNotificationDto, payload);
  return validate(dto);
}

describe('CreateExternalNotificationDto', () => {
  const base = {
    channelType: 'EMAIL',
    codiceFiscale: 'RSSMRA80A01H501U',
    email: 'test@example.com',
    extraData: {},
    subject: 'Oggetto di test',
    body: 'Corpo del messaggio di test.',
  };

  it('payload EMAIL minimo valido non produce errori', async () => {
    expect(await validateDto(base)).toHaveLength(0);
  });

  it('CF malformato (lunghezza sbagliata) produce errore', async () => {
    const errors = await validateDto({ ...base, codiceFiscale: 'TROPPOCORTO' });
    expect(errors.some((e) => e.property === 'codiceFiscale')).toBe(true);
  });

  it('EMAIL senza campo email né pec produce errore', async () => {
    const errors = await validateDto({ channelType: 'EMAIL', codiceFiscale: base.codiceFiscale, extraData: {} });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('PEC senza campo email né pec produce errore', async () => {
    const errors = await validateDto({ channelType: 'PEC', codiceFiscale: base.codiceFiscale, extraData: {} });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('CF di 15 caratteri (troppo corto) produce errore', async () => {
    const errors = await validateDto({ ...base, codiceFiscale: 'x'.repeat(15) });
    expect(errors.some((e) => e.property === 'codiceFiscale')).toBe(true);
  });

  it('CF di 17 caratteri (troppo lungo) produce errore', async () => {
    const errors = await validateDto({ ...base, codiceFiscale: 'x'.repeat(17) });
    expect(errors.some((e) => e.property === 'codiceFiscale')).toBe(true);
  });

  it('CF di 16 caratteri non alfanumerico produce errore', async () => {
    const errors = await validateDto({ ...base, codiceFiscale: 'RSSMRA80A01H50!U' });
    expect(errors.some((e) => e.property === 'codiceFiscale')).toBe(true);
  });

  it('CF di 16 caratteri alfanumerici è valido', async () => {
    const errors = await validateDto({ ...base, codiceFiscale: 'x'.repeat(16) });
    expect(errors.some((e) => e.property === 'codiceFiscale')).toBe(false);
  });

  // --- APP_IO: subject/body obbligatori + vincoli di lunghezza PagoPA ---

  it('APP_IO senza subject produce errore (obbligatorio)', async () => {
    const { subject, ...payload } = base;
    const errors = await validateDto({ ...payload, channelType: 'APP_IO', body: 'x'.repeat(80) });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('APP_IO senza body produce errore (obbligatorio)', async () => {
    const { body, ...payload } = base;
    const errors = await validateDto({ ...payload, channelType: 'APP_IO', subject: 'oggetto valido di 12+' });
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('APP_IO con subject sotto i 10 caratteri produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'APP_IO', subject: 'corto', body: 'x'.repeat(80) });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('APP_IO con body sotto gli 80 caratteri produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'APP_IO', subject: 'oggetto valido di 12+', body: 'troppo corto' });
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('APP_IO con subject/body ai bordi esatti minimi [10,80] è valido', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'APP_IO',
      subject: 'x'.repeat(10),
      body: 'x'.repeat(80),
    });
    expect(errors).toHaveLength(0);
  });

  it('APP_IO con subject/body ai bordi esatti massimi [120,10000] è valido', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'APP_IO',
      subject: 'x'.repeat(120),
      body: 'x'.repeat(10000),
    });
    expect(errors).toHaveLength(0);
  });

  it('APP_IO con subject di 121 caratteri (oltre il massimo) produce errore', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'APP_IO',
      subject: 'x'.repeat(121),
      body: 'x'.repeat(80),
    });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('APP_IO con body di 10001 caratteri (oltre il massimo) produce errore', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'APP_IO',
      subject: 'oggetto valido di 12+',
      body: 'x'.repeat(10001),
    });
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('APP_IO con body HTML: testo visibile sotto 80 caratteri ma markup grezzo sopra produce comunque errore (tag non contati come contenuto)', async () => {
    const paddedHtml = '<p>corto</p>' + '<b></b>'.repeat(15); // raw > 80, visibile = "corto" (5)
    const errors = await validateDto({
      ...base,
      channelType: 'APP_IO',
      subject: 'oggetto valido di 12+',
      body: paddedHtml,
    });
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('APP_IO con body HTML: testo visibile abbastanza lungo con markup che porterebbe il grezzo sopra 10000 resta valido se il visibile è entro i limiti', async () => {
    // Testo visibile di 8000 caratteri, ma con tag ripetuti il grezzo
    // supera abbondantemente 10000 — deve restare VALIDO perché il
    // conteggio è sul testo visibile, non sul markup.
    const visibleText = 'x'.repeat(8000);
    const paddedHtml = `<p>${visibleText}</p>` + '<span></span>'.repeat(200);
    const errors = await validateDto({
      ...base,
      channelType: 'APP_IO',
      subject: 'oggetto valido di 12+',
      body: paddedHtml,
    });
    expect(errors.some((e) => e.property === 'body')).toBe(false);
  });

  // --- EMAIL/PEC: subject/body sempre obbligatori, nessun vincolo di lunghezza ---

  it('EMAIL senza subject produce errore', async () => {
    const { subject, ...payload } = base;
    const errors = await validateDto(payload);
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('EMAIL senza body produce errore', async () => {
    const { body, ...payload } = base;
    const errors = await validateDto(payload);
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('EMAIL con subject non stringa (numero) produce errore', async () => {
    const errors = await validateDto({ ...base, subject: 12345 });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('EMAIL con body non stringa (numero) produce errore', async () => {
    const errors = await validateDto({ ...base, body: 12345 });
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('EMAIL con subject/body stringa valida non produce errori', async () => {
    const errors = await validateDto({ ...base, subject: 'Oggetto valido', body: 'Corpo valido.' });
    expect(errors).toHaveLength(0);
  });

  it('EMAIL con subject stringa vuota produce errore', async () => {
    const errors = await validateDto({ ...base, subject: '' });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('PEC senza subject/body produce errore', async () => {
    const { subject, body, ...rest } = base;
    const errors = await validateDto({ ...rest, channelType: 'PEC', pec: 'test@pec.it', email: undefined });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('PEC con subject/body non stringa (numero) produce errore', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'PEC',
      pec: 'test@pec.it',
      email: undefined,
      subject: 111,
      body: 222,
    });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('APP_IO con subject/body non stringa (numero) produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'APP_IO', subject: 111, body: 222 });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('POSTAL con subject non stringa (numero) produce errore', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'POSTAL',
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
      subject: 333,
    });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  // --- SEND: subject sempre obbligatorio (bug corretto: prima era opzionale
  // come per POSTAL); body strutturalmente non gestito, mai renderizzato in
  // UI per questo canale — un valore fornito è un errore, non un opzionale
  // ignorato ---

  it('SEND senza subject produce errore (obbligatorio, come nel wizard)', async () => {
    const { subject, body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'SEND',
      protocolla: true,
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
    });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('SEND con subject valido e senza body non produce errore (body opzionale/non gestito)', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'SEND',
      protocolla: true,
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
    });
    expect(errors.some((e) => e.property === 'subject')).toBe(false);
    expect(errors.some((e) => e.property === 'body')).toBe(false);
  });

  it('SEND con body valorizzato produce errore (campo non gestito da questo canale)', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'SEND',
      protocolla: true,
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
    });
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('SEND con subject non stringa produce comunque errore (type-check anche se il campo è obbligatorio)', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'SEND',
      protocolla: true,
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
      subject: 999,
    });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  // --- POSTAL: subject SEMPRE obbligatorio (stesso gate incondizionato di
  // SEND allo step6 in modalità singola — vedi App.tsx righe 11021/11029 —
  // non il gate step4 "Riepilogo", MAI raggiunto per POSTAL in
  // wizSingleMode: lo step Template viene saltato del tutto). body sempre
  // rifiutato se valorizzato, mai renderizzato in UI per questo canale. Il
  // contenuto notificato reale restano comunque gli allegati, non subject. ---

  it('POSTAL senza subject produce errore (obbligatorio, gate step6 single-mode incondizionato)', async () => {
    const { subject, body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'POSTAL',
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
    });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('POSTAL con subject presente e senza body non produce errore (body non gestito da questo canale)', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'POSTAL',
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
    });
    expect(errors.some((e) => e.property === 'subject')).toBe(false);
    expect(errors.some((e) => e.property === 'body')).toBe(false);
  });

  it('POSTAL con body valorizzato produce errore (campo non gestito da questo canale)', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'POSTAL',
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
    });
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('POSTAL con secondaryAppIo e subject presente non produce errore su subject (obbligatorio a prescindere, già rispettato)', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'POSTAL',
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
      secondaryAppIo: { subjectOverride: 'x'.repeat(15), bodyOverride: 'x'.repeat(90) },
    });
    expect(errors.some((e) => e.property === 'subject')).toBe(false);
  });

  it('SEND senza protocolla=true produce errore', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({ ...rest, channelType: 'SEND', attachments: [{ token: 't1' }], protocolla: false });
    expect(errors.some((e) => e.property === 'protocolla')).toBe(true);
  });

  it('SEND senza attachments produce errore', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({ ...rest, channelType: 'SEND', protocolla: true });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  it('POSTAL senza attachments produce errore', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({ ...rest, channelType: 'POSTAL', attachments: [] });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  it('POSTAL con attachments del tutto omesso (non solo array vuoto) produce errore', async () => {
    const errors = await validateDto({ channelType: 'POSTAL', codiceFiscale: base.codiceFiscale, extraData: {} });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  it('SEND con attachments del tutto omesso produce errore', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({ ...rest, channelType: 'SEND', protocolla: true });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  // --- secondaryAppIo: disponibile solo per EMAIL/PEC/POSTAL, con vincoli
  // di lunghezza PagoPA sul testo effettivamente inviato (override, o
  // fallback su subject/body principali se l'override manca) ---

  it('secondaryAppIo valido (parallel, override entro i limiti) non produce errori', async () => {
    const errors = await validateDto({
      ...base,
      secondaryAppIo: { subjectOverride: 'oggetto valido App IO', bodyOverride: 'x'.repeat(80) },
    });
    expect(errors).toHaveLength(0);
  });

  it('secondaryAppIo senza override ricade su subject/body principali: se troppo corti per App IO produce errore', async () => {
    // base.body è ~29 caratteri, sotto la soglia minima App IO (80)
    const errors = await validateDto({ ...base, secondaryAppIo: {} });
    expect(errors.some((e) => e.property === 'secondaryAppIo')).toBe(true);
  });

  it('secondaryAppIo senza override ricade su subject/body principali: se abbastanza lunghi non produce errori', async () => {
    const errors = await validateDto({
      ...base,
      subject: 'Oggetto abbastanza lungo per App IO',
      body: 'x'.repeat(80),
      secondaryAppIo: {},
    });
    expect(errors).toHaveLength(0);
  });

  it('secondaryAppIo con override esplicito troppo corto (sotto i minimi PagoPA) produce errore', async () => {
    const errors = await validateDto({
      ...base,
      secondaryAppIo: { subjectOverride: 'corto', bodyOverride: 'troppo corto' },
    });
    expect(errors.some((e) => e.property === 'secondaryAppIo')).toBe(true);
  });

  it('secondaryAppIo con bodyOverride HTML: testo visibile sotto 80 caratteri ma markup sopra produce comunque errore', async () => {
    // <p></p> ripetuto per superare 80 caratteri grezzi, ma il testo
    // visibile reale è solo "corto" (5 caratteri) — deve restare sotto il
    // minimo App IO, non essere considerato valido per via del markup.
    const paddedHtml = '<p>corto</p>' + '<b></b>'.repeat(15);
    const errors = await validateDto({
      ...base,
      secondaryAppIo: { subjectOverride: 'oggetto valido App IO', bodyOverride: paddedHtml },
    });
    expect(errors.some((e) => e.property === 'secondaryAppIo')).toBe(true);
  });

  it('secondaryAppIo per canale APP_IO primario produce errore (ridondante, non disponibile nel wizard)', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'APP_IO',
      subject: 'x'.repeat(20),
      body: 'x'.repeat(80),
      secondaryAppIo: { subjectOverride: 'x'.repeat(15), bodyOverride: 'x'.repeat(90) },
    });
    expect(errors.some((e) => e.property === 'secondaryAppIo')).toBe(true);
  });

  it('secondaryAppIo per canale SEND produce errore (non disponibile nel wizard, pipeline propria)', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'SEND',
      protocolla: true,
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
      secondaryAppIo: { subjectOverride: 'x'.repeat(15), bodyOverride: 'x'.repeat(90) },
    });
    expect(errors.some((e) => e.property === 'secondaryAppIo')).toBe(true);
  });

  it('secondaryAppIo per canale POSTAL senza override produce errore (differenziazione sempre forzata)', async () => {
    const { subject, body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'POSTAL',
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
      subject: 'Oggetto POSTAL',
      secondaryAppIo: {},
    });
    expect(errors.some((e) => e.property === 'secondaryAppIo')).toBe(true);
  });

  it('secondaryAppIo per canale POSTAL con override completi ed entro i limiti non produce errore su secondaryAppIo', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'POSTAL',
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
      secondaryAppIo: { subjectOverride: 'x'.repeat(15), bodyOverride: 'x'.repeat(90) },
    });
    expect(errors.some((e) => e.property === 'secondaryAppIo')).toBe(false);
  });

  it('SEND/POSTAL valido con attachments popolato non produce errori', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'SEND',
      protocolla: true,
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000', label: 'Atto' }],
    });
    expect(errors).toHaveLength(0);
  });

  it('attachments con token non-UUID (es. path traversal) produce errore', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'SEND',
      protocolla: true,
      attachments: [{ token: '../other-client/some-token' }],
    });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  it('attachments con token generico non-UUID produce errore', async () => {
    const { body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'POSTAL',
      attachments: [{ token: 'not-a-uuid' }],
    });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });
});
