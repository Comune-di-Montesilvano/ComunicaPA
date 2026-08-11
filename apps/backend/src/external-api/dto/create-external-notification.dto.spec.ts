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

  it('SEND senza subject/body non produce errore (opzionali per SEND)', async () => {
    const { subject, body, ...rest } = base;
    const errors = await validateDto({ ...rest, channelType: 'SEND', protocolla: true, attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }] });
    expect(errors.some((e) => e.property === 'subject')).toBe(false);
    expect(errors.some((e) => e.property === 'body')).toBe(false);
  });

  it('SEND con subject non stringa produce comunque errore (type-check anche se opzionale)', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'SEND',
      protocolla: true,
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
      subject: 999,
    });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('POSTAL senza subject/body non produce errore su subject/body (contenuto reale sono gli allegati)', async () => {
    const { subject, body, ...rest } = base;
    const errors = await validateDto({
      ...rest,
      channelType: 'POSTAL',
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000' }],
    });
    expect(errors.some((e) => e.property === 'subject')).toBe(false);
    expect(errors.some((e) => e.property === 'body')).toBe(false);
  });

  it('SEND senza protocolla=true produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'SEND', attachments: [{ token: 't1' }], protocolla: false });
    expect(errors.some((e) => e.property === 'protocolla')).toBe(true);
  });

  it('SEND senza attachments produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'SEND', protocolla: true, attachments: [] });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  it('POSTAL senza attachments produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'POSTAL', attachments: [] });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  it('POSTAL con attachments del tutto omesso (non solo array vuoto) produce errore', async () => {
    const errors = await validateDto({ channelType: 'POSTAL', codiceFiscale: base.codiceFiscale, extraData: {} });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  it('SEND con attachments del tutto omesso produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'SEND', protocolla: true });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  it('secondaryAppIo valido (parallel, campi opzionali) non produce errori', async () => {
    const errors = await validateDto({ ...base, secondaryAppIo: { subjectOverride: 'oggetto valido' } });
    expect(errors).toHaveLength(0);
  });

  it('SEND/POSTAL valido con attachments popolato non produce errori', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'SEND',
      protocolla: true,
      attachments: [{ token: '123e4567-e89b-12d3-a456-426614174000', label: 'Atto' }],
    });
    expect(errors).toHaveLength(0);
  });

  it('attachments con token non-UUID (es. path traversal) produce errore', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'SEND',
      protocolla: true,
      attachments: [{ token: '../other-client/some-token' }],
    });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  it('attachments con token generico non-UUID produce errore', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'POSTAL',
      attachments: [{ token: 'not-a-uuid' }],
    });
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });
});
