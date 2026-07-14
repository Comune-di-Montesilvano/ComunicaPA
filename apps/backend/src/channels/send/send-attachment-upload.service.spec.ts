import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { SendAttachmentUploadService } from './send-attachment-upload.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('SendAttachmentUploadService', () => {
  let service: SendAttachmentUploadService;

  beforeEach(async () => {
    mockFetch.mockClear();
    const module = await Test.createTestingModule({ providers: [SendAttachmentUploadService] }).compile();
    service = module.get(SendAttachmentUploadService);
  });

  it('chiama preload, poi carica il file con x-amz-checksum-sha256 come header normale (non trailer) e ritorna key+versionToken', async () => {
    const buffer = Buffer.from('%PDF-1.4 contenuto di test');
    const expectedSha256 = createHash('sha256').update(buffer).digest('base64');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify([
        { preloadIdx: 'doc-0', secret: 'my-secret', httpMethod: 'PUT', url: 'https://s3.example/upload', key: 'PN_ATTACHMENTS-0001' },
      ])),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (name: string) => (name === 'x-amz-version-id' ? 'version-abc-123' : null) },
    });

    const result = await service.preloadAndUpload('https://send.test', 'apikey-xyz', 'voucher-abc', buffer, 'application/pdf', 'doc-0');

    expect(mockFetch).toHaveBeenNthCalledWith(1,
      'https://send.test/delivery/attachments/preload',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'apikey-xyz', Authorization: 'Bearer voucher-abc' }),
      }),
    );
    const preloadBody = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
    expect(preloadBody).toEqual([{ preloadIdx: 'doc-0', contentType: 'application/pdf', sha256: expectedSha256 }]);

    const uploadCall = mockFetch.mock.calls[1];
    expect(uploadCall[0]).toBe('https://s3.example/upload');
    expect(uploadCall[1]).toEqual(expect.objectContaining({
      method: 'PUT',
      headers: {
        'Content-Type': 'application/pdf',
        'x-amz-meta-secret': 'my-secret',
        'x-amz-checksum-sha256': expectedSha256,
      },
    }));
    expect(Buffer.from(uploadCall[1].body).equals(buffer)).toBe(true);

    expect(result).toEqual({ key: 'PN_ATTACHMENTS-0001', versionToken: 'version-abc-123', sha256Base64: expectedSha256 });
  });

  it('lancia errore leggibile se il preload fallisce', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('{"error":"bad request"}') });
    await expect(
      service.preloadAndUpload('https://send.test', 'apikey-xyz', 'voucher-abc', Buffer.from('x'), 'application/pdf', 'doc-0'),
    ).rejects.toThrow(/Preload allegato SEND fallito: HTTP 400/);
  });

  it('lancia errore se il server di upload risponde diverso da 200 (es. SignatureDoesNotMatch)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify([
        { preloadIdx: 'doc-0', secret: 's', httpMethod: 'PUT', url: 'https://s3.example/upload', key: 'K' },
      ])),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve('<Error><Code>SignatureDoesNotMatch</Code></Error>'),
    });

    await expect(
      service.preloadAndUpload('https://send.test', 'apikey-xyz', 'voucher-abc', Buffer.from('x'), 'application/pdf', 'doc-0'),
    ).rejects.toThrow(/Upload allegato SEND fallito: HTTP 403/);
  });

  it('lancia errore se manca x-amz-version-id nella risposta di upload', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify([
        { preloadIdx: 'doc-0', secret: 's', httpMethod: 'PUT', url: 'https://s3.example/upload', key: 'K' },
      ])),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
    });

    await expect(
      service.preloadAndUpload('https://send.test', 'apikey-xyz', 'voucher-abc', Buffer.from('x'), 'application/pdf', 'doc-0'),
    ).rejects.toThrow(/x-amz-version-id mancante/);
  });
});
