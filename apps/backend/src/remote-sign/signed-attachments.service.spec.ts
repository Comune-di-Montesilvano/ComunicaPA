// apps/backend/src/remote-sign/signed-attachments.service.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import { SignedAttachmentsService } from './signed-attachments.service.js';
import { getUnsignedBackupDir, getUploadsDir } from '../attachments/attachment-paths.js';

const CAMPAIGN = '44444444-4444-4444-4444-444444444444';
const ADMIN = { username: 'admin', role: 'admin' as const };

function build() {
  const remoteSign = {
    assertCanModify: vi.fn().mockResolvedValue({ id: CAMPAIGN, name: 'Prova' }),
    hasActiveJob: vi.fn().mockResolvedValue(false),
    listFilesToSign: vi.fn().mockResolvedValue({ toSign: ['A.pdf', 'B.pdf'], alreadyValid: ['V.pdf'] }),
  };
  const bulk = {
    getLatestStatus: vi.fn().mockResolvedValue({ status: 'done', invalidCount: 2 }),
    startForCampaign: vi.fn().mockResolvedValue({ jobId: 'v-2' }),
  };
  const audit = { log: vi.fn() };
  return { svc: new SignedAttachmentsService(remoteSign as any, bulk as any, audit as any), remoteSign, bulk, audit };
}

describe('SignedAttachmentsService', () => {
  let root: string;
  let scratch: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-sa-'));
    scratch = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-sa-up-'));
    process.env['ATTACHMENTS_PATH'] = root;
    fs.mkdirSync(getUploadsDir(CAMPAIGN), { recursive: true });
    for (const f of ['A.pdf', 'B.pdf', 'V.pdf']) fs.writeFileSync(join(getUploadsDir(CAMPAIGN), f), `orig-${f}`);
  });
  afterEach(() => {
    delete process.env['ATTACHMENTS_PATH'];
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('buildUnsignedZip contiene solo i file da firmare col nome originale', async () => {
    const { svc } = build();
    const zip = await svc.buildUnsignedZip(CAMPAIGN, ADMIN);
    expect(Buffer.isBuffer(zip)).toBe(true);
    const names = new AdmZip(zip as Buffer).getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual(['A.pdf', 'B.pdf']);
    expect(new AdmZip(zip as Buffer).getEntries().every((e) => e.header.method === 0)).toBe(true);
  });

  it('buildUnsignedZip con verifica non conclusa → error', async () => {
    const { svc, bulk } = build();
    bulk.getLatestStatus.mockResolvedValueOnce({ status: 'processing' });
    await expect(svc.buildUnsignedZip(CAMPAIGN, ADMIN)).resolves.toEqual({ error: 'Attendi la fine della verifica firma' });
  });

  it('ricarico ZIP: sottocartelle Windows, suffissi, p7m, già validi; backup e nuova verifica', async () => {
    const { svc, bulk, audit } = build();
    const zip = new AdmZip();
    zip.addFile('firmati\\A-signed.pdf', Buffer.from('firmato-A'));
    zip.addFile('B.pdf.p7m', Buffer.from('p7m'));
    zip.addFile('V_firmato.pdf', Buffer.from('firmato-V'));
    const zipPath = join(scratch, 'firmati.zip');
    zip.writeZip(zipPath);

    const res = await svc.applySignedUpload(CAMPAIGN, ADMIN, zipPath, 'firmati.zip');

    expect(res).toEqual({
      replaced: 1,
      rejected: [
        { file: 'B.pdf.p7m', reason: 'Serve firma PAdES (PDF), non CAdES (.p7m)' },
        { file: 'V_firmato.pdf', reason: 'Allegato già firmato validamente' },
      ],
    });
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('firmato-A');
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'V.pdf'), 'utf8')).toBe('orig-V.pdf');
    expect(fs.readFileSync(join(getUnsignedBackupDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('orig-A.pdf');
    expect(fs.readdirSync(getUploadsDir(CAMPAIGN)).sort()).toEqual(['A.pdf', 'B.pdf', 'V.pdf']);
    expect(bulk.startForCampaign).toHaveBeenCalledWith(CAMPAIGN);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPLOAD_SIGNED_ATTACHMENTS' }));
  });

  it('ricarico singolo PDF col nome originale', async () => {
    const { svc } = build();
    const pdfPath = join(scratch, 'upload.bin');
    fs.writeFileSync(pdfPath, 'firmato-B');
    const res = await svc.applySignedUpload(CAMPAIGN, ADMIN, pdfPath, 'B.pdf');
    expect(res).toEqual({ replaced: 1, rejected: [] });
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'B.pdf'), 'utf8')).toBe('firmato-B');
  });

  it('nessun file abbinato: niente nuova verifica', async () => {
    const { svc, bulk } = build();
    const pdfPath = join(scratch, 'upload.bin');
    fs.writeFileSync(pdfPath, 'x');
    const res = await svc.applySignedUpload(CAMPAIGN, ADMIN, pdfPath, 'ALTRO.pdf');
    expect(res).toEqual({ replaced: 0, rejected: [{ file: 'ALTRO.pdf', reason: 'Nessun allegato da firmare con questo nome' }] });
    expect(bulk.startForCampaign).not.toHaveBeenCalled();
  });

  it('firma remota in corso → error, nessuna scrittura', async () => {
    const { svc, remoteSign } = build();
    remoteSign.hasActiveJob.mockResolvedValueOnce(true);
    const pdfPath = join(scratch, 'upload.bin');
    fs.writeFileSync(pdfPath, 'x');
    await expect(svc.applySignedUpload(CAMPAIGN, ADMIN, pdfPath, 'A.pdf'))
      .resolves.toEqual({ error: 'Firma remota in corso: attendi la fine prima di ricaricare' });
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('orig-A.pdf');
  });

  it('assertCanModify rifiuta → errore e file caricato rimosso', async () => {
    const { svc, remoteSign } = build();
    remoteSign.assertCanModify.mockRejectedValueOnce(new Error('403'));
    const pdfPath = join(scratch, 'upload.bin');
    fs.writeFileSync(pdfPath, 'x');
    await expect(svc.applySignedUpload(CAMPAIGN, ADMIN, pdfPath, 'A.pdf')).rejects.toThrow('403');
    expect(fs.existsSync(pdfPath)).toBe(false);
  });

  it('ZIP corrotto → error, uploads invariati', async () => {
    const { svc } = build();
    const zipPath = join(scratch, 'x.zip');
    fs.writeFileSync(zipPath, Buffer.from('questo non e uno zip'));
    await expect(svc.applySignedUpload(CAMPAIGN, ADMIN, zipPath, 'x.zip'))
      .resolves.toEqual({ error: 'ZIP non valido o danneggiato' });
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('orig-A.pdf');
    expect(fs.existsSync(zipPath)).toBe(false);
  });

  it('errore di salvataggio su un file: gli altri sostituiti, nuova verifica avviata', async () => {
    const { svc, bulk } = build();
    // B.pdf diventa una cartella → replaceAttachment lancia
    fs.rmSync(join(getUploadsDir(CAMPAIGN), 'B.pdf'));
    fs.mkdirSync(join(getUploadsDir(CAMPAIGN), 'B.pdf'));
    const zip = new AdmZip();
    zip.addFile('A.pdf', Buffer.from('firmato-A'));
    zip.addFile('B.pdf', Buffer.from('firmato-B'));
    const zipPath = join(scratch, 'f.zip');
    zip.writeZip(zipPath);
    const res = await svc.applySignedUpload(CAMPAIGN, ADMIN, zipPath, 'f.zip');
    expect(res).toEqual({ replaced: 1, rejected: [{ file: 'B.pdf', reason: 'Errore durante il salvataggio del file' }] });
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'A.pdf'), 'utf8')).toBe('firmato-A');
    expect(bulk.startForCampaign).toHaveBeenCalledWith(CAMPAIGN);
  });
});
