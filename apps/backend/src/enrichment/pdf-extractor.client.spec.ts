import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/configuration';
import { PdfExtractorClient } from './pdf-extractor.client';

describe('PdfExtractorClient', () => {
  const config = { get: jest.fn().mockReturnValue('http://pdf-extractor:8000') } as unknown as ConfigService<AppConfiguration, true>;
  let client: PdfExtractorClient;

  beforeEach(() => {
    client = new PdfExtractorClient(config);
    global.fetch = jest.fn();
  });

  it('POST multipart a /extract con mode in query e parse della risposta', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ address: { cap: '00100' }, payment: null, warnings: ['w1'] }),
    });

    const result = await client.extract(Buffer.from('%PDF'), 'doc.pdf', 'unica');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://pdf-extractor:8000/extract?mode=unica',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.address).toEqual({ cap: '00100' });
    expect(result.warnings).toEqual(['w1']);
  });

  it('HTTP non-ok → Error con status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    await expect(client.extract(Buffer.from('x'), 'doc.pdf', 'unica')).rejects.toThrow(/500/);
  });
});
