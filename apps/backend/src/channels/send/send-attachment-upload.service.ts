import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as https from 'node:https';
import * as http from 'node:http';

export interface UploadedDocument {
  key: string;
  versionToken: string;
  sha256Base64: string;
}

interface PreloadResponseEntry {
  preloadIdx: string;
  secret: string;
  httpMethod: 'PUT' | 'POST';
  url: string;
  key: string;
}

@Injectable()
export class SendAttachmentUploadService {
  private readonly logger = new Logger(SendAttachmentUploadService.name);

  async preloadAndUpload(
    baseUrl: string,
    apiKey: string,
    voucher: string,
    buffer: Buffer,
    contentType: 'application/pdf' | 'application/json',
    preloadIdx: string,
  ): Promise<UploadedDocument> {
    const sha256Base64 = createHash('sha256').update(buffer).digest('base64');

    const preloadRes = await fetch(`${baseUrl}/delivery/attachments/preload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
      body: JSON.stringify([{ preloadIdx, contentType, sha256: sha256Base64 }]),
    });
    const preloadText = await preloadRes.text();
    if (!preloadRes.ok) {
      throw new Error(`Preload allegato SEND fallito: HTTP ${preloadRes.status} — ${preloadText.slice(0, 500)}`);
    }
    const preloadData = JSON.parse(preloadText) as PreloadResponseEntry[];
    const entry = preloadData.find((e) => e.preloadIdx === preloadIdx);
    if (!entry) {
      throw new Error(`Preload allegato SEND: risposta priva della entry per preloadIdx=${preloadIdx}`);
    }

    const versionToken = await this.uploadWithTrailer(entry.url, entry.httpMethod, entry.secret, contentType, buffer, sha256Base64);
    this.logger.log(`Allegato SEND caricato: key=${entry.key} versionToken=${versionToken}`);
    return { key: entry.key, versionToken, sha256Base64 };
  }

  private uploadWithTrailer(
    url: string,
    method: 'PUT' | 'POST',
    secret: string,
    contentType: string,
    buffer: Buffer,
    sha256Base64: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const client = parsed.protocol === 'http:' ? http : https;
      const req = client.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
          path: `${parsed.pathname}${parsed.search}`,
          method,
          headers: {
            'content-type': contentType,
            'x-amz-meta-secret': secret,
            trailer: 'x-amz-checksum-sha256',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Upload allegato SEND fallito: HTTP ${res.statusCode} — ${body.slice(0, 500)}`));
              return;
            }
            const versionToken = res.headers['x-amz-version-id'];
            if (!versionToken || Array.isArray(versionToken)) {
              reject(new Error('Upload allegato SEND: header x-amz-version-id mancante nella risposta'));
              return;
            }
            resolve(versionToken);
          });
        },
      );
      req.on('error', reject);
      req.write(buffer);
      req.addTrailers({ 'x-amz-checksum-sha256': sha256Base64 });
      req.end();
    });
  }
}
