import * as fs from 'fs';
import { join } from 'path';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import * as chunkedUpload from '../campaigns/chunked-upload.util';

// `jest.mock('fs')` (automock) invece di `jest.spyOn(fs, ...)`: con
// `esModuleInterop` l'helper `__createBinding` di TS copia le funzioni del
// modulo builtin `fs` come getter non configurabili (`configurable: false`)
// sul namespace importato con `import * as fs from 'fs'` — `jest.spyOn`
// prova a rimpiazzare la proprietà con `Object.defineProperty` e fallisce con
// "Cannot redefine property". L'automock intercetta invece `require('fs')`
// stesso, sostituendo ogni export con un `jest.fn()` a monte (stesso motivo
// per cui `jest.mock('../campaigns/chunked-upload.util')` già funziona senza
// spyOn qui sotto).
jest.mock('fs');
jest.mock('../campaigns/chunked-upload.util');

describe('ExternalAttachmentTokensService', () => {
  let service: ExternalAttachmentTokensService;
  const root = '/tmp/comunicapa-uploads/external-attachments-test';

  beforeEach(() => {
    service = new ExternalAttachmentTokensService();
    (service as any).root = root;
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('completeUpload assembla il chunked upload e lo materializza sotto un token scoped per client', async () => {
    (chunkedUpload.assembleChunkedUpload as jest.Mock).mockResolvedValue({ path: '/tmp/fake-assembled.pdf', filename: 'avviso.pdf' });
    (fs.copyFileSync as jest.Mock).mockImplementation(() => undefined);
    (fs.mkdirSync as jest.Mock).mockImplementation(() => undefined);
    (fs.writeFileSync as jest.Mock).mockImplementation(() => undefined);
    (chunkedUpload.cleanupChunkedUpload as jest.Mock).mockImplementation(() => undefined);

    const { token } = await service.completeUpload('client-1', 'upload-1');

    expect(token).toEqual(expect.any(String));
    expect(chunkedUpload.assembleChunkedUpload).toHaveBeenCalledWith('upload-1');
    expect(chunkedUpload.cleanupChunkedUpload).toHaveBeenCalledWith('upload-1');
  });

  it('resolve ritorna null per un token di un altro client (nessun leak cross-client)', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    expect(service.resolve('client-2', 'token-di-client-1')).toBeNull();
  });

  it('resolve del path corretto per il proprio client ma non per un client diverso con lo stesso token (isolamento reale via path)', () => {
    const existing = new Set<string>();
    (fs.existsSync as jest.Mock).mockImplementation((p: string) => existing.has(p));
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify({ filename: 'avviso.pdf', createdAt: new Date().toISOString(), consumed: false }),
    );

    const ownMetaPath = join(root, 'client-1', 'shared-token', 'meta.json');
    existing.add(ownMetaPath);

    expect(service.resolve('client-1', 'shared-token')).toEqual({
      path: join(root, 'client-1', 'shared-token', 'avviso.pdf'),
      filename: 'avviso.pdf',
    });
    expect(service.resolve('client-2', 'shared-token')).toBeNull();
  });
});
