import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { replaceAttachment } from './attachment-writer.util.js';
import { getUnsignedBackupDir, getUploadsDir } from '../attachments/attachment-paths.js';

const CAMPAIGN = '11111111-1111-1111-1111-111111111111';

describe('replaceAttachment', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-sign-'));
    process.env['ATTACHMENTS_PATH'] = root;
    fs.mkdirSync(getUploadsDir(CAMPAIGN), { recursive: true });
    fs.writeFileSync(join(getUploadsDir(CAMPAIGN), 'DOC_1.pdf'), 'ORIGINALE');
  });
  afterEach(() => {
    delete process.env['ATTACHMENTS_PATH'];
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('salva il backup FUORI da uploads e sostituisce il file', () => {
    replaceAttachment(CAMPAIGN, 'DOC_1.pdf', Buffer.from('FIRMATO'));
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'DOC_1.pdf'), 'utf8')).toBe('FIRMATO');
    expect(fs.readFileSync(join(getUnsignedBackupDir(CAMPAIGN), 'DOC_1.pdf'), 'utf8')).toBe('ORIGINALE');
    expect(getUnsignedBackupDir(CAMPAIGN).startsWith(getUploadsDir(CAMPAIGN))).toBe(false);
    expect(fs.readdirSync(getUploadsDir(CAMPAIGN))).toEqual(['DOC_1.pdf']);
  });

  it('non sovrascrive il backup alla seconda sostituzione', () => {
    replaceAttachment(CAMPAIGN, 'DOC_1.pdf', Buffer.from('FIRMATO-1'));
    replaceAttachment(CAMPAIGN, 'DOC_1.pdf', Buffer.from('FIRMATO-2'));
    expect(fs.readFileSync(join(getUnsignedBackupDir(CAMPAIGN), 'DOC_1.pdf'), 'utf8')).toBe('ORIGINALE');
    expect(fs.readFileSync(join(getUploadsDir(CAMPAIGN), 'DOC_1.pdf'), 'utf8')).toBe('FIRMATO-2');
  });

  it('rifiuta nomi con path traversal', () => {
    expect(() => replaceAttachment(CAMPAIGN, '../x.pdf', Buffer.from('X'))).toThrow('Nome allegato non valido');
  });
});
