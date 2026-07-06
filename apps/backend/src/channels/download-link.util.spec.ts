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
});
