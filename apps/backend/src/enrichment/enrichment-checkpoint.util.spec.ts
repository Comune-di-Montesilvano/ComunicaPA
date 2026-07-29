import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { getEnrichmentDir, getEnrichmentCheckpoint } from './enrichment-paths';
import { writeCheckpointSync, readCheckpointSync, deleteCheckpointSync } from './enrichment-checkpoint.util';

describe('enrichment-checkpoint.util', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'enrich-ckpt-'));
    process.env['ATTACHMENTS_PATH'] = tmpDir;
    fs.mkdirSync(getEnrichmentDir('j1'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['ATTACHMENTS_PATH'];
  });

  it('scrive e rilegge un checkpoint valido', () => {
    writeCheckpointSync('j1', { lastRow: 100, rows: [{ codice_fiscale: 'ABC' }], warnings: [], maxRate: 2 });
    const read = readCheckpointSync('j1');
    expect(read).toEqual({ lastRow: 100, rows: [{ codice_fiscale: 'ABC' }], warnings: [], maxRate: 2 });
  });

  it('nessun file checkpoint → null', () => {
    expect(readCheckpointSync('j1')).toBeNull();
  });

  it('file checkpoint corrotto (JSON non parsabile) → null, non lancia', () => {
    fs.writeFileSync(getEnrichmentCheckpoint('j1'), '{not valid json');
    expect(readCheckpointSync('j1')).toBeNull();
  });

  it('scrittura non lascia mai un file .tmp residuo', () => {
    writeCheckpointSync('j1', { lastRow: 1, rows: [], warnings: [], maxRate: 0 });
    expect(fs.existsSync(getEnrichmentCheckpoint('j1') + '.tmp')).toBe(false);
  });

  it('delete rimuove il file, idempotente se già assente', () => {
    writeCheckpointSync('j1', { lastRow: 1, rows: [], warnings: [], maxRate: 0 });
    deleteCheckpointSync('j1');
    expect(fs.existsSync(getEnrichmentCheckpoint('j1'))).toBe(false);
    expect(() => deleteCheckpointSync('j1')).not.toThrow();
  });
});
