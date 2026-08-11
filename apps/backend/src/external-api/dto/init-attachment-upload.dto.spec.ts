import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InitAttachmentUploadDto } from './init-attachment-upload.dto';

async function validateDto(payload: Record<string, unknown>) {
  const dto = plainToInstance(InitAttachmentUploadDto, payload);
  return validate(dto);
}

describe('InitAttachmentUploadDto', () => {
  it('payload valido non produce errori', async () => {
    expect(await validateDto({ filename: 'avviso.pdf', totalChunks: 3 })).toHaveLength(0);
  });

  it('filename mancante produce errore', async () => {
    const errors = await validateDto({ totalChunks: 1 });
    expect(errors.some((e) => e.property === 'filename')).toBe(true);
  });

  it('filename vuoto produce errore', async () => {
    const errors = await validateDto({ filename: '', totalChunks: 1 });
    expect(errors.some((e) => e.property === 'filename')).toBe(true);
  });

  it('filename non stringa produce errore', async () => {
    const errors = await validateDto({ filename: 12345, totalChunks: 1 });
    expect(errors.some((e) => e.property === 'filename')).toBe(true);
  });

  it('totalChunks mancante produce errore', async () => {
    const errors = await validateDto({ filename: 'avviso.pdf' });
    expect(errors.some((e) => e.property === 'totalChunks')).toBe(true);
  });

  it('totalChunks non intero produce errore', async () => {
    const errors = await validateDto({ filename: 'avviso.pdf', totalChunks: 1.5 });
    expect(errors.some((e) => e.property === 'totalChunks')).toBe(true);
  });

  it('totalChunks < 1 produce errore', async () => {
    const errors = await validateDto({ filename: 'avviso.pdf', totalChunks: 0 });
    expect(errors.some((e) => e.property === 'totalChunks')).toBe(true);
  });

  it('filename con path traversal è comunque una stringa valida a livello DTO — la sanitizzazione reale è in initChunkedUpload() (basename), verificata separatamente nell\'integration spec', async () => {
    // Il DTO valida forma/tipo, non semantica del path — documentato qui per
    // chiarire che il gate anti-traversal vero è chunked-upload.util.ts.
    expect(await validateDto({ filename: '../../../../etc/passwd', totalChunks: 1 })).toHaveLength(0);
  });
});
