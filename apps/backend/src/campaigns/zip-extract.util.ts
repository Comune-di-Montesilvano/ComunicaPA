import * as fs from 'fs';
import { join, basename } from 'path';
import * as yauzl from 'yauzl';

/**
 * Extracts PDF files from a ZIP archive directly to the destination directory.
 * Avoids loading the whole file or extracted content into memory by using streams.
 * Uses a concurrency limit of 50 to extract files in parallel, avoiding 504 timeouts.
 */
export function extractZipWithYauzl(filePath: string, destDir: string): Promise<void> {
  const CONCURRENCY_LIMIT = 50;

  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err);

      let activeCount = 0;
      let hasEnded = false;
      let errorOccurred = false;
      let isReading = false;

      const handleError = (error: Error) => {
        if (errorOccurred) return;
        errorOccurred = true;
        zipfile.close();
        reject(error);
      };

      zipfile.on('error', (zipErr) => {
        handleError(zipErr);
      });

      zipfile.on('end', () => {
        hasEnded = true;
        if (activeCount === 0 && !errorOccurred) {
          resolve();
        }
      });

      function readNext() {
        if (errorOccurred || hasEnded || isReading) return;
        if (activeCount < CONCURRENCY_LIMIT) {
          isReading = true;
          zipfile.readEntry();
        }
      }

      zipfile.on('entry', (entry) => {
        isReading = false;

        // Skip directories
        if (/\/$/.test(entry.fileName)) {
          readNext();
          return;
        }

        // Neutralize path traversal by getting only the basename
        const name = basename(entry.fileName);
        if (!name.toLowerCase().endsWith('.pdf')) {
          readNext();
          return;
        }

        activeCount++;

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) {
            activeCount--;
            return handleError(streamErr);
          }

          const destPath = join(destDir, name);
          const writeStream = fs.createWriteStream(destPath);

          let streamErrorHandled = false;
          const handleStreamError = (streamErrToHandle: Error) => {
            if (streamErrorHandled) return;
            streamErrorHandled = true;
            readStream.destroy();
            writeStream.destroy();
            handleError(streamErrToHandle);
          };

          readStream.on('error', handleStreamError);
          writeStream.on('error', handleStreamError);

          writeStream.on('finish', () => {
            activeCount--;
            if (hasEnded && activeCount === 0 && !errorOccurred) {
              resolve();
            } else {
              readNext();
            }
          });

          readStream.pipe(writeStream);
        });

        // Request next entry (concurrency permitting)
        readNext();
      });

      // Start the reader
      readNext();
    });
  });
}
