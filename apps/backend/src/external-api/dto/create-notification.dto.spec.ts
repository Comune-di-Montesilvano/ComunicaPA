import 'reflect-metadata';
import { validateCreateNotification } from './create-notification.dto.js';

const TOKEN = '3fbb1e2a-1234-4abc-9def-426614174000';
const LONG_BODY = '<p>' + 'Gentile cittadino, la informiamo che è disponibile un nuovo avviso. '.repeat(2) + '</p>';
const ADDRESS = { street: 'Via Roma 1', zip: '00100', municipality: 'Roma', province: 'RM' };

function email(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'EMAIL',
    recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'mario.rossi@example.com' },
    content: { subject: 'Avviso TARI 2026', body: '<p>Testo</p>' },
    ...overrides,
  };
}

function postal(overrides: Record<string, unknown> = {}, address: Record<string, unknown> = ADDRESS) {
  return {
    channel: 'POSTAL',
    recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address },
    content: { subject: 'Avviso' },
    attachments: [{ token: TOKEN }],
    ...overrides,
  };
}

async function fields(body: unknown): Promise<string[]> {
  const { issues } = await validateCreateNotification(body);
  return issues.map((i) => i.field).sort();
}

describe('validateCreateNotification — formato', () => {
  it('EMAIL minimo valido', async () => {
    expect(await fields(email())).toEqual([]);
  });

  it('campo sconosciuto annidato → issue con path completo', async () => {
    expect(await fields(email({ recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'a@b.it', foo: 1 } }))).toEqual(['recipient.foo']);
  });

  it('channel non valido → solo issue di formato, niente regole per canale a cascata', async () => {
    expect(await fields(email({ channel: 'FAX' }))).toEqual(['channel']);
  });

  it('PF con taxId da 11 cifre e PG con CF da 16 → errore su recipient.taxId', async () => {
    expect(await fields(email({ recipient: { type: 'PF', taxId: '01234567890', email: 'a@b.it' } }))).toEqual(['recipient.taxId']);
    expect(await fields(email({ recipient: { type: 'PG', taxId: 'RSSMRA80A01H501U', email: 'a@b.it' } }))).toEqual(['recipient.taxId']);
  });

  it('PG con P.IVA valida', async () => {
    expect(await fields(email({ recipient: { type: 'PG', taxId: '01234567890', email: 'a@b.it' } }))).toEqual([]);
  });

  it('token allegato non UUID → errore (anti path traversal)', async () => {
    expect(await fields(postal({ attachments: [{ token: '../altro/tok' }] }))).toEqual(['attachments.0.token']);
  });

  it('payment: dueDate YYYY-MM-DD, amountCents intero > 0', async () => {
    const f = await fields({
      channel: 'SEND',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
      content: { subject: 'Notifica atto' },
      attachments: [{ token: TOKEN }],
      send: { taxonomyCode: '010101P' },
      payment: { noticeCode: '302000000000000000', amountCents: 0, creditorTaxId: '01234567890', dueDate: '31/12/2026' },
    });
    expect(f).toEqual(['payment.amountCents', 'payment.dueDate']);
  });

  it('indirizzo italiano senza provincia → errore; estero senza provincia → valido', async () => {
    expect(await fields(postal({}, { street: 'Via Roma 1', municipality: 'Roma' }))).toEqual(['recipient.address.province']);
    expect(await fields(postal({}, { street: 'Rue X 1', municipality: 'Bruxelles', country: 'Belgio' }))).toEqual([]);
  });

  it('comune noto oltre 30 caratteri → abbreviato; altro comune oltre 30 → errore', async () => {
    const ok = await validateCreateNotification(postal({}, { street: 'Via Roma 1', municipality: 'Villa Santa Lucia degli Abruzzi', province: 'AQ' }));
    expect(ok.issues).toEqual([]);
    expect(ok.value.recipient.address!.municipality).toBe('VILLA SANTA LUCIA ABRUZZI');
    expect(await fields(postal({}, { street: 'Via Roma 1', municipality: 'Comune Inventato Con Nome Davvero Lunghissimo', province: 'XX' }))).toEqual([
      'recipient.address.municipality',
    ]);
  });

  it('postal.agol con serviceType non Agol → errore', async () => {
    expect(await fields(postal({ postal: { serviceType: 'Raccomandata', agol: { notifierType: 'NonUtilizzato' } } }))).toEqual(['postal.agol']);
  });
});

describe('validateCreateNotification — regole per canale', () => {
  it('EMAIL senza email, PEC senza pec → errore sul contatto', async () => {
    expect(await fields(email({ recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U' } }))).toEqual(['recipient.email']);
    expect(await fields(email({ channel: 'PEC' }))).toEqual(['recipient.pec']);
  });

  it('subject vuoto dopo trim → errore per ogni canale', async () => {
    expect(await fields(email({ content: { subject: '   ', body: '<p>x</p>' } }))).toEqual(['content.subject']);
  });

  it('body con solo markup vuoto → errore (shell Tiptap <p></p>)', async () => {
    expect(await fields(email({ content: { subject: 'Avviso', body: '<p></p>' } }))).toEqual(['content.body']);
  });

  it('APP_IO: subject corto e body sotto 80 caratteri visibili', async () => {
    expect(await fields(email({ channel: 'APP_IO', content: { subject: 'Breve', body: '<p>corto</p>' } }))).toEqual(['content.body', 'content.subject']);
  });

  it('SEND completo valido', async () => {
    expect(
      await fields({
        channel: 'SEND',
        recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
        content: { subject: 'Notifica atto' },
        attachments: [{ token: TOKEN }],
        send: { taxonomyCode: '010101N' },
      }),
    ).toEqual([]);
  });

  it('SEND: body vietato, address/fullName/attachments/send obbligatori', async () => {
    const f = await fields({
      channel: 'SEND',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U' },
      content: { subject: 'Notifica atto', body: '<p>x</p>' },
    });
    expect(f).toEqual(['attachments', 'content.body', 'recipient.address', 'recipient.fullName', 'send']);
  });

  it('blocchi canale-specifici fuori canale → errore', async () => {
    const f = await fields(email({ send: { taxonomyCode: '010101N' }, postal: {}, payment: { noticeCode: '302000000000000000', amountCents: 1, creditorTaxId: '01234567890' } }));
    expect(f).toEqual(['payment', 'postal', 'send']);
  });

  it('address vietato fuori da SEND/POSTAL', async () => {
    expect(await fields(email({ recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'a@b.it', address: ADDRESS } }))).toEqual(['recipient.address']);
  });

  it('appIoParallel: vietato su APP_IO; su POSTAL subject+body obbligatori', async () => {
    expect(await fields(email({ channel: 'APP_IO', content: { subject: 'Avviso TARI 2026', body: LONG_BODY }, appIoParallel: {} }))).toEqual(['appIoParallel']);
    expect(await fields(postal({ appIoParallel: { subject: 'Hai una nuova comunicazione' } }))).toEqual(['appIoParallel']);
  });

  it('EMAIL + appIoParallel senza override ricade su content: vincoli App IO sul testo effettivo', async () => {
    expect(await fields(email({ appIoParallel: {} }))).toEqual(['appIoParallel']);
    expect(await fields(email({ content: { subject: 'Avviso TARI 2026', body: LONG_BODY }, appIoParallel: {} }))).toEqual([]);
  });

  it('EMAIL con allegati: content.body deve contenere %%elenco_allegati%% o tutti i %%allegatoN%%', async () => {
    const att = [{ token: TOKEN }, { token: '4fbb1e2a-1234-4abc-9def-426614174000' }];
    expect(await fields(email({ attachments: att }))).toEqual(['content.body']);
    expect(await fields(email({ attachments: att, content: { subject: 'Avviso', body: '<p>%%elenco_allegati%%</p>' } }))).toEqual([]);
    expect(await fields(email({ attachments: att, content: { subject: 'Avviso', body: '<p>%%allegato1%% %%allegato2%%</p>' } }))).toEqual([]);
  });

  it('POSTAL + appIoParallel: appIoParallel.body deve contenere il placeholder allegati', async () => {
    const parallel = (body: string) => postal({ appIoParallel: { subject: 'Hai una nuova comunicazione', body } });
    expect(await fields(parallel('<p>' + 'Ti abbiamo inviato una raccomandata con un avviso importante. '.repeat(2) + '</p>'))).toEqual(['appIoParallel.body']);
    expect(await fields(parallel('<p>' + 'Ti abbiamo inviato una raccomandata con un avviso importante. '.repeat(2) + '%%elenco_allegati%%</p>'))).toEqual([]);
  });
});

describe('validateCreateNotification — oggetti obbligatori', () => {
  it('recipient o content mancanti → VALIDATION_ERROR, mai eccezione', async () => {
    expect(await fields({ channel: 'EMAIL', content: { subject: 'Avviso', body: '<p>x</p>' } })).toEqual(['recipient']);
    expect(await fields({ channel: 'EMAIL', recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'a@b.it' } })).toEqual(['content']);
  });
});
