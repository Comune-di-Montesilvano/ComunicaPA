import { createHmac } from 'crypto';
import { signDownloadLink, verifyDownloadLink } from './download-link.util';

describe('download-link.util con indice allegato', () => {
  const secret = 'test-secret';
  const exp = 1893456000;

  it('genera una firma valida per recipientId+index+exp', () => {
    const sig = signDownloadLink('r-1', 0, exp, secret);
    expect(verifyDownloadLink('r-1', 0, exp, sig, secret)).toBe(true);
  });

  it('una firma generata per index 0 NON è valida per index 1', () => {
    const sig = signDownloadLink('r-1', 0, exp, secret);
    expect(verifyDownloadLink('r-1', 1, exp, sig, secret)).toBe(false);
  });

  it('una firma generata per un recipientId NON è valida per un altro', () => {
    const sig = signDownloadLink('r-1', 0, exp, secret);
    expect(verifyDownloadLink('r-2', 0, exp, sig, secret)).toBe(false);
  });

  it('rifiuta una firma malformata senza lanciare eccezioni', () => {
    expect(verifyDownloadLink('r-1', 0, exp, 'non-esadecimale-!!!', secret)).toBe(false);
  });

  it('una firma generata con canale EMAIL non è valida per canale APP_IO', () => {
    const sig = signDownloadLink('r-1', 0, exp, secret, 'EMAIL');
    expect(verifyDownloadLink('r-1', 0, exp, sig, secret, 'APP_IO')).toBe(false);
  });

  it('canale di default (nessun canale passato) resta retrocompatibile su entrambi i lati', () => {
    const sig = signDownloadLink('r-1', 0, exp, secret);
    expect(verifyDownloadLink('r-1', 0, exp, sig, secret)).toBe(true);
  });

  it('retrocompatibilità: una firma calcolata con la formula pre-esistente (senza flag preview) resta valida', () => {
    // Formula originale, prima dell'introduzione del flag preview: nessun operatore
    // deve poter invalidare i link già spediti in campagne passate (email/PEC/
    // AppIO/SEND) aggiungendo il supporto alle anteprime backoffice.
    const legacySig = createHmac('sha256', secret).update(`r-1:0:${exp}:EMAIL`).digest('hex');
    expect(verifyDownloadLink('r-1', 0, exp, legacySig, secret, 'EMAIL')).toBe(true);
  });

  it('una firma generata con preview=true non è valida senza il flag preview', () => {
    const sig = signDownloadLink('r-1', 0, exp, secret, 'EMAIL', true);
    expect(verifyDownloadLink('r-1', 0, exp, sig, secret, 'EMAIL', false)).toBe(false);
    expect(verifyDownloadLink('r-1', 0, exp, sig, secret, 'EMAIL', true)).toBe(true);
  });
});
