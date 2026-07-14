import { Test } from '@nestjs/testing';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { SendAttachmentUploadService } from './send-attachment-upload.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('SendAttachmentUploadService', () => {
  let service: SendAttachmentUploadService;
  let server: http.Server;
  let serverPort: number;
  let receivedHeaders: http.IncomingHttpHeaders;
  let receivedTrailers: NodeJS.Dict<string>;
  let receivedBody: Buffer;

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedHeaders = req.headers;
        receivedTrailers = req.trailers;
        receivedBody = Buffer.concat(chunks);
        res.setHeader('x-amz-version-id', 'version-abc-123');
        res.statusCode = 200;
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(async () => {
    mockFetch.mockClear();
    const module = await Test.createTestingModule({ providers: [SendAttachmentUploadService] }).compile();
    service = module.get(SendAttachmentUploadService);
  });

  it('chiama preload, poi carica il file con trailer sha256 corretto e ritorna key+versionToken', async () => {
    const buffer = Buffer.from('%PDF-1.4 contenuto di test');
    const expectedSha256 = createHash('sha256').update(buffer).digest('base64');

    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify([
        { preloadIdx: 'doc-0', secret: 'my-secret', httpMethod: 'PUT', url: `http://127.0.0.1:${serverPort}/upload`, key: 'PN_ATTACHMENTS-0001' },
      ])),
    });

    const result = await service.preloadAndUpload('https://send.test', 'apikey-xyz', 'voucher-abc', buffer, 'application/pdf', 'doc-0');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/attachments/preload',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'apikey-xyz', Authorization: 'Bearer voucher-abc' }),
      }),
    );
    const preloadBody = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
    expect(preloadBody).toEqual([{ preloadIdx: 'doc-0', contentType: 'application/pdf', sha256: expectedSha256 }]);

    expect(result).toEqual({ key: 'PN_ATTACHMENTS-0001', versionToken: 'version-abc-123', sha256Base64: expectedSha256 });
    expect(receivedHeaders['content-type']).toBe('application/pdf');
    expect(receivedHeaders['x-amz-meta-secret']).toBe('my-secret');
    expect(receivedHeaders['trailer']).toBe('x-amz-checksum-sha256');
    expect(receivedTrailers['x-amz-checksum-sha256']).toBe(expectedSha256);
    expect(receivedBody.equals(buffer)).toBe(true);
  });

  it('lancia errore leggibile se il preload fallisce', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('{"error":"bad request"}') });
    await expect(
      service.preloadAndUpload('https://send.test', 'apikey-xyz', 'voucher-abc', Buffer.from('x'), 'application/pdf', 'doc-0'),
    ).rejects.toThrow(/Preload allegato SEND fallito: HTTP 400/);
  });

  it('lancia errore se il server di upload risponde diverso da 200', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify([
        { preloadIdx: 'doc-0', secret: 's', httpMethod: 'PUT', url: `http://127.0.0.1:${serverPort}/fail-path-does-not-exist-but-server-always-200`, key: 'K' },
      ])),
    });
    // Nota: il server di test risponde sempre 200; questo test verifica solo
    // che il codice gestisca un mock diverso — copre il path via un secondo
    // server ad-hoc che risponde 500.
    const failServer = http.createServer((req, res) => { req.resume(); res.statusCode = 500; res.end('boom'); });
    await new Promise<void>((resolve) => failServer.listen(0, '127.0.0.1', resolve));
    const failPort = (failServer.address() as any).port;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify([
        { preloadIdx: 'doc-0', secret: 's', httpMethod: 'PUT', url: `http://127.0.0.1:${failPort}/upload`, key: 'K' },
      ])),
    });
    await expect(
      service.preloadAndUpload('https://send.test', 'apikey-xyz', 'voucher-abc', Buffer.from('x'), 'application/pdf', 'doc-0'),
    ).rejects.toThrow(/Upload allegato SEND fallito: HTTP 500/);
    failServer.close();
  });
});
