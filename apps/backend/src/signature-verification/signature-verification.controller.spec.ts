import { NotFoundException } from '@nestjs/common';
import { SignatureVerificationController } from './signature-verification.controller.js';
import type { SignatureVerificationBulkService } from './signature-verification-bulk.service.js';
import type { AppSettingsService } from '../settings/app-settings.service.js';

const ID = '7f1c2d3e-0000-4000-8000-000000000001';
const STATUS = { status: 'done', totalRows: 3, validCount: 2, invalidCount: 1, errorMessage: null };

const INVALID = { items: [{ filename: 'stipula.pdf', reason: 'File non firmato', recipients: 1 }], total: 1 };

function build(required: unknown, status: unknown = STATUS) {
  const bulk = {
    getLatestStatus: jest.fn(async () => status),
    getInvalidFiles: jest.fn(async () => INVALID),
  } as unknown as SignatureVerificationBulkService;
  const settings = { get: jest.fn(async (key: string) => (key === 'send.requireSignedAttachments' ? required : null)) } as unknown as AppSettingsService;
  return new SignatureVerificationController(bulk, settings);
}

describe('SignatureVerificationController.status', () => {
  it('riporta `required` dall\'impostazione SEND', async () => {
    await expect(build(true).status(ID)).resolves.toEqual(expect.objectContaining({ ...STATUS, required: true }));
    await expect(build(false).status(ID)).resolves.toEqual(expect.objectContaining({ ...STATUS, required: false }));
    await expect(build(null).status(ID)).resolves.toEqual(expect.objectContaining({ ...STATUS, required: false }));
  });

  it('verifica conclusa con allegati non validi → elenco dei file', async () => {
    await expect(build(false).status(ID)).resolves.toEqual(expect.objectContaining({ invalidFiles: INVALID.items, invalidFilesTotal: 1 }));
  });

  it('verifica tutta valida o in corso → nessuna query sui file', async () => {
    for (const s of [{ ...STATUS, invalidCount: 0 }, { ...STATUS, status: 'processing' }]) {
      const controller = build(false, s);
      await expect(controller.status(ID)).resolves.toEqual(expect.objectContaining({ invalidFiles: [], invalidFilesTotal: 0 }));
      expect((controller as unknown as { bulkService: { getInvalidFiles: jest.Mock } }).bulkService.getInvalidFiles).not.toHaveBeenCalled();
    }
  });

  it('nessuna verifica avviata → 404', async () => {
    await expect(build(true, null).status(ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
