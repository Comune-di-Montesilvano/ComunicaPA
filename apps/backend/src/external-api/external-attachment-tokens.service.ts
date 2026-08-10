import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { assembleChunkedUpload, cleanupChunkedUpload } from '../campaigns/chunked-upload.util';
import { getAttachmentsRoot } from '../attachments/attachment-paths';

interface TokenMeta {
  filename: string;
  createdAt: string;
  consumed: boolean;
}

@Injectable()
export class ExternalAttachmentTokensService {
  private root = join(getAttachmentsRoot(), 'external-attachments');

  private tokenDir(clientId: string, token: string): string {
    return join(this.root, clientId, token);
  }

  async completeUpload(clientId: string, uploadId: string): Promise<{ token: string }> {
    const { path, filename } = await assembleChunkedUpload(uploadId);
    const token = randomUUID();
    const dir = this.tokenDir(clientId, token);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path, join(dir, filename));
    const meta: TokenMeta = { filename, createdAt: new Date().toISOString(), consumed: false };
    fs.writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    cleanupChunkedUpload(uploadId);
    return { token };
  }

  resolve(clientId: string, token: string): { path: string; filename: string } | null {
    const dir = this.tokenDir(clientId, token);
    const metaPath = join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as TokenMeta;
    return { path: join(dir, meta.filename), filename: meta.filename };
  }

  markConsumed(clientId: string, token: string): void {
    const metaPath = join(this.tokenDir(clientId, token), 'meta.json');
    if (!fs.existsSync(metaPath)) return;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as TokenMeta;
    meta.consumed = true;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  }

  /** Usata dal retention cron (Step 8): elenca token più vecchi di `maxAgeMs`. */
  listStaleTokenDirs(maxAgeMs: number): string[] {
    if (!fs.existsSync(this.root)) return [];
    const stale: string[] = [];
    for (const clientId of fs.readdirSync(this.root)) {
      const clientDir = join(this.root, clientId);
      for (const token of fs.readdirSync(clientDir)) {
        const dir = join(clientDir, token);
        const metaPath = join(dir, 'meta.json');
        if (!fs.existsSync(metaPath)) continue;
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as TokenMeta;
        if (Date.now() - new Date(meta.createdAt).getTime() > maxAgeMs) stale.push(dir);
      }
    }
    return stale;
  }
}
