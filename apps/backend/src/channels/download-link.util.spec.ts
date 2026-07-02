import { signDownloadLink, verifyDownloadLink } from './download-link.util';

describe('download-link.util', () => {
  const secret = 'test-secret';
  const recipientId = '11111111-1111-1111-1111-111111111111';
  const exp = 1893456000; // 2030-01-01

  it('genera una firma verificabile con lo stesso secret', () => {
    const sig = signDownloadLink(recipientId, exp, secret);
    expect(verifyDownloadLink(recipientId, exp, sig, secret)).toBe(true);
  });

  it('rifiuta la firma se il recipientId è diverso', () => {
    const sig = signDownloadLink(recipientId, exp, secret);
    expect(verifyDownloadLink('22222222-2222-2222-2222-222222222222', exp, sig, secret)).toBe(false);
  });

  it('rifiuta la firma se exp è diverso da quello firmato', () => {
    const sig = signDownloadLink(recipientId, exp, secret);
    expect(verifyDownloadLink(recipientId, exp + 1, sig, secret)).toBe(false);
  });

  it('rifiuta la firma se il secret è diverso', () => {
    const sig = signDownloadLink(recipientId, exp, secret);
    expect(verifyDownloadLink(recipientId, exp, sig, 'altro-secret')).toBe(false);
  });

  it('rifiuta una firma malformata senza lanciare eccezioni', () => {
    expect(verifyDownloadLink(recipientId, exp, 'non-hex-!!!', secret)).toBe(false);
  });
});
