import fc from 'fast-check';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { getAttachmentsRoot, getUploadsDir, safeGetUploadsDir } from '../attachments/attachment-paths.js';
import { resolveCustomAttachmentFilename } from '../attachments/attachment.service.js';
import { escapeLdapFilterValue } from '../auth/ldap/ldap.service.js';
import { escapeCsvField } from '../campaigns/csv.util.js';
import { cleanupChunkedUpload, initChunkedUpload, isValidChunkIndex, safeChunkUploadDir } from '../campaigns/chunked-upload.util.js';
import { flattenZipEntryName } from '../campaigns/zip-extract.util.js';
import { SEND_TIMELINE_STRIPPED_KEYS, stripSendPii } from '../channels/send/send-status-history.util.js';
import type { Recipient } from '../entities/recipient.entity.js';
import { safeAttachmentPath } from '../remote-sign/attachment-writer.util.js';

/**
 * Fuzzing (property-based, fast-check) delle funzioni che ricevono input non
 * fidato da CSV, body HTTP o parametri di route e lo trasformano in path su
 * disco, filtri LDAP o celle CSV. Ogni proprietà deve valere per QUALUNQUE
 * input generato, non solo per gli esempi dei test unitari.
 */

const CAMPAIGN_ID = '00000000-0000-0000-0000-000000000001';

// Stringhe casuali (unicode completo, NUL compreso) mescolate a frammenti
// noti per path traversal, injection LDAP e formule CSV.
const tricky = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc
    .array(
      fc.constantFrom('..', '.', '/', '\\', '\0', '%2e', '*', '(', ')', '=', '+', '-', '@', '"', 'a', 'Z', '1', ' ', '\n'),
      { maxLength: 20 },
    )
    .map((parts) => parts.join('')),
);

const RUNS = { numRuns: 2000 };

describe('fuzz: escapeLdapFilterValue', () => {
  const unescape = (s: string) => s.replace(/\\([0-9a-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

  it('nessun metacarattere RFC 4515 sopravvive non escapato', () => {
    fc.assert(
      fc.property(tricky, (value) => {
        const rest = escapeLdapFilterValue(value).replace(/\\[0-9a-f]{2}/g, '');
        expect(rest).not.toMatch(/[\\*()\0]/);
      }),
      RUNS,
    );
  });

  it("l'escape è reversibile: il server LDAP riceve esattamente il valore digitato", () => {
    fc.assert(
      fc.property(tricky, (value) => {
        expect(unescape(escapeLdapFilterValue(value))).toBe(value);
      }),
      RUNS,
    );
  });
});

describe('fuzz: escapeCsvField', () => {
  it('campo sempre quotato, mai una formula, contenuto originale recuperabile', () => {
    fc.assert(
      fc.property(tricky, (value) => {
        const out = escapeCsvField(value);
        expect(out.startsWith('"') && out.endsWith('"') && out.length >= 2).toBe(true);
        const inner = out.slice(1, -1);
        expect(inner.replace(/""/g, '')).not.toContain('"');
        const cell = inner.replace(/""/g, '"');
        expect(cell).not.toMatch(/^[=+\-@]/);
        expect([value, `'${value}`]).toContain(cell);
      }),
      RUNS,
    );
  });
});

describe('fuzz: path da input non fidato', () => {
  const uploadsDir = resolve(getUploadsDir(CAMPAIGN_ID));

  it('safeAttachmentPath: null oppure un file direttamente dentro uploads della campagna', () => {
    fc.assert(
      fc.property(tricky, (filename) => {
        const path = safeAttachmentPath(CAMPAIGN_ID, filename);
        if (path !== null) expect(dirname(resolve(path))).toBe(uploadsDir);
      }),
      RUNS,
    );
  });

  it('resolveCustomAttachmentFilename: un nome dal CSV non esce mai da uploads', () => {
    fc.assert(
      fc.property(tricky, (raw) => {
        const recipient = {
          extraData: { allegato: `${raw}.pdf` },
          campaign: { channelConfig: { attachments: [{ key: 'allegato', label: 'Allegato' }] } },
        } as unknown as Recipient;
        const name = resolveCustomAttachmentFilename(recipient, 0);
        if (name !== undefined) {
          expect(name).not.toMatch(/[\\\0]/);
          expect(dirname(resolve(join(uploadsDir, name)))).toBe(uploadsDir);
        }
      }),
      RUNS,
    );
  });

  it('safeGetUploadsDir: mai throw, null oppure una cartella figlia diretta di uploads', () => {
    const uploadsRoot = resolve(join(getAttachmentsRoot(), 'uploads'));
    fc.assert(
      fc.property(fc.oneof(tricky, fc.uuid(), fc.anything()), (campaignId) => {
        const dir = safeGetUploadsDir(campaignId);
        if (dir !== null) expect(dirname(resolve(dir))).toBe(uploadsRoot);
      }),
      RUNS,
    );
  });

  it('safeChunkUploadDir: mai throw, null oppure una cartella figlia diretta della radice chunk', () => {
    fc.assert(
      fc.property(fc.oneof(tricky, fc.uuid(), fc.anything()), (uploadId) => {
        const dir = safeChunkUploadDir(uploadId);
        if (dir !== null) expect(dirname(dir)).toBe('/tmp/comunicapa-uploads/chunked');
      }),
      RUNS,
    );
  });

  it('flattenZipEntryName: una voce .pdf (unica estratta) resta un file dentro la cartella di estrazione', () => {
    fc.assert(
      fc.property(tricky, (entryName) => {
        const name = flattenZipEntryName(`${entryName}.pdf`);
        expect(name).not.toMatch(/[/\\]/);
        expect(dirname(resolve(join('/estrazione', name)))).toBe('/estrazione');
      }),
      RUNS,
    );
  });

  // Scrive su disco (meta.json per sessione): meno run, sessione rimossa subito.
  it('initChunkedUpload: il filename salvato resta un file dentro la cartella della sessione', () => {
    fc.assert(
      fc.property(tricky, (filename) => {
        const uploadId = initChunkedUpload(filename, 1);
        try {
          const dir = safeChunkUploadDir(uploadId)!;
          const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { filename: string };
          expect(dirname(resolve(join(dir, `assembled-${meta.filename}`)))).toBe(dir);
        } finally {
          cleanupChunkedUpload(uploadId);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('isValidChunkIndex: un indice accettato resta un file dentro la cartella di upload', () => {
    fc.assert(
      fc.property(fc.oneof(tricky, fc.nat().map(String), fc.anything()), (index) => {
        if (isValidChunkIndex(index)) {
          expect(dirname(resolve(join('/upload', `${index}.part`)))).toBe('/upload');
        }
      }),
      RUNS,
    );
  });
});

describe('fuzz: stripSendPii', () => {
  const hasPiiKey = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(hasPiiKey);
    if (v && typeof v === 'object') {
      return Object.entries(v).some(([k, x]) => SEND_TIMELINE_STRIPPED_KEYS.includes(k) || hasPiiKey(x));
    }
    return false;
  };
  const piiKey = fc.constantFrom(...SEND_TIMELINE_STRIPPED_KEYS);
  const tree = fc.letrec((tie) => ({
    node: fc.oneof(
      { depthSize: 'small' },
      fc.string(),
      fc.integer(),
      fc.array(tie('node'), { maxLength: 3 }),
      fc.dictionary(fc.oneof(piiKey, fc.string({ maxLength: 6 })), tie('node'), { maxKeys: 4 }),
    ),
  })).node;

  it('nessuna chiave PII sopravvive a qualunque profondità', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.oneof(piiKey, fc.string({ maxLength: 6 })), tree, { maxKeys: 5 }), piiKey, (obj, key) => {
        const withPii = { ...obj, nested: [{ [key]: 'x', deep: { [key]: 'y' } }] };
        expect(hasPiiKey(withPii)).toBe(true);
        expect(hasPiiKey(stripSendPii(withPii))).toBe(false);
      }),
      RUNS,
    );
  });
});
