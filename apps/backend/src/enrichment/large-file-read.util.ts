import * as fs from 'fs';

/**
 * `fs.readFileSync` rifiuta qualunque file oltre 2 GiB con
 * `RangeError [ERR_FS_FILE_TOO_LARGE]` — limite hardcoded in Node (kIoMaxLength),
 * non un parametro configurabile lato app. `AdmZip(path)` usa internamente
 * `fs.readFileSync`, quindi uno ZIP sorgente enrichment oltre 2 GiB va sempre
 * letto a mano in chunk e passato come Buffer (`new AdmZip(buffer)`), mai come path.
 */
export function readLargeFileSync(path: string): Buffer {
  const { size } = fs.statSync(path);
  const buffer = Buffer.allocUnsafe(size);
  const fd = fs.openSync(path, 'r');
  try {
    const chunkSize = 512 * 1024 * 1024;
    let offset = 0;
    while (offset < size) {
      const length = Math.min(chunkSize, size - offset);
      fs.readSync(fd, buffer, offset, length, offset);
      offset += length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return buffer;
}
