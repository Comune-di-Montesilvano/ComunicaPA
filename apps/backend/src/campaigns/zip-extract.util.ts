import * as fs from 'fs';
import { join, basename } from 'path';
import * as yauzl from 'yauzl';

/**
 * Extracts PDF files from a ZIP archive directly to the destination directory.
 * Avoids loading the whole file or extracted content into memory by using streams.
 */
export function extractZipWithYauzl(filePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err);

      zipfile.on('error', (zipErr) => {
        reject(zipErr);
      });

      zipfile.on('end', () => {
        resolve();
      });

      zipfile.on('entry', (entry) => {
        // Skip directories
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        // Neutralize path traversal by getting only the basename
        const name = basename(entry.fileName);
        if (!name.toLowerCase().endsWith('.pdf')) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) {
            zipfile.close();
            return reject(streamErr);
          }

          const destPath = join(destDir, name);
          const writeStream = fs.createWriteStream(destPath);

          let errorHandled = false;
          const handleError = (streamErrToHandle: Error) => {
            if (errorHandled) return;
            errorHandled = true;
            zipfile.close();
            readStream.destroy();
            writeStream.destroy();
            reject(streamErrToHandle);
          };

          readStream.on('error', handleError);
          writeStream.on('error', handleError);

          writeStream.on('finish', () => {
            zipfile.readEntry();
          });

          readStream.pipe(writeStream);
        });
      });

      // Start the reader
      zipfile.readEntry();
    });
  });
}
