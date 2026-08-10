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

  it('APP_IO con subject sotto i 10 caratteri produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'APP_IO', subject: 'corto', body: 'x'.repeat(80) });
    expect(errors.some((e) => e.property === 'subject')).toBe(true);
  });

  it('APP_IO con body sotto gli 80 caratteri produce errore', async () => {
    const errors = await validateDto({ ...base, channelType: 'APP_IO', subject: 'oggetto valido di 12+', body: 'troppo corto' });
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('APP_IO con subject/body ai bordi esatti [10,120]/[80,10000] è valido', async () => {
    const errors = await validateDto({
      ...base,
      channelType: 'APP_IO',
      subject: 'x'.repeat(10),
      body: 'x'.repeat(80),
    });
    expect(errors).toHaveLength(0);
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
      attachments: [{ token: 't1', label: 'Atto' }],
    });
    expect(errors).toHaveLength(0);
  });
});
