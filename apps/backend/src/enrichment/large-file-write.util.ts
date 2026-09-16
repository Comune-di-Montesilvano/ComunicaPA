import * as fs from 'fs';

/**
 * `fs.writeFileSync` rifiuta un Buffer oltre ~2 GiB con `RangeError` generico
 * ("length" out of range) — stesso limite Node (kIoMaxLength) già noto per
 * `fs.readFileSync` (vedi `readLargeFileSync`), ma applicato in scrittura.
 * Uno ZIP sorgente enrichment risultante da merge multi-ZIP può superarlo
 * (`mergeMaggioliZips`), va quindi scritto a mano in chunk.
 */
export function writeLargeFileSync(path: string, buffer: Buffer): void {
  const fd = fs.openSync(path, 'w');
  try {
    const chunkSize = 512 * 1024 * 1024;
    let offset = 0;
    while (offset < buffer.length) {
      const length = Math.min(chunkSize, buffer.length - offset);
      fs.writeSync(fd, buffer, offset, length);
      offset += length;
    }
  } finally {
    fs.closeSync(fd);
  }
}
