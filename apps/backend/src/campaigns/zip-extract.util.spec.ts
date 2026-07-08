import * as fs from 'fs';
import { join } from 'path';
import AdmZip from 'adm-zip';
import { extractZipWithYauzl } from './zip-extract.util';

describe('extractZipWithYauzl', () => {
  const tmpDir = join(__dirname, '../../test-zip-extract-tmp');
  const zipPath = join(tmpDir, 'test.zip');
  const destDir = join(tmpDir, 'extracted');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });

    // Create a mock zip using AdmZip
    const zip = new AdmZip();
    zip.addFile('document1.pdf', Buffer.from('pdf content 1'));
    zip.addFile('folder/', Buffer.alloc(0)); // directory entry
    zip.addFile('folder/document2.PDF', Buffer.from('pdf content 2')); // case-insensitive check
    zip.addFile('notes.txt', Buffer.from('text content')); // non-pdf
    zip.addFile('../escaped.pdf', Buffer.from('escaped content')); // path traversal attempt

    zip.writeZip(zipPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should extract PDF files only, flatten directories, and prevent path traversal', async () => {
    await extractZipWithYauzl(zipPath, destDir);

    // document1.pdf should exist
    expect(fs.existsSync(join(destDir, 'document1.pdf'))).toBe(true);
    expect(fs.readFileSync(join(destDir, 'document1.pdf'), 'utf8')).toBe('pdf content 1');

    // document2.PDF should exist (flattened in destDir root)
    expect(fs.existsSync(join(destDir, 'document2.PDF'))).toBe(true);
    expect(fs.readFileSync(join(destDir, 'document2.PDF'), 'utf8')).toBe('pdf content 2');

    // notes.txt should not exist (since it is not a PDF)
    expect(fs.existsSync(join(destDir, 'notes.txt'))).toBe(false);

    // escaped.pdf should be saved under destDir/escaped.pdf, NOT destDir/../escaped.pdf
    expect(fs.existsSync(join(destDir, 'escaped.pdf'))).toBe(true);
    expect(fs.readFileSync(join(destDir, 'escaped.pdf'), 'utf8')).toBe('escaped content');
    expect(fs.existsSync(join(tmpDir, 'escaped.pdf'))).toBe(false);
  });

  it('should propagate errors for non-existent zip files', async () => {
    await expect(extractZipWithYauzl(join(tmpDir, 'missing.zip'), destDir)).rejects.toThrow();
  });
});
