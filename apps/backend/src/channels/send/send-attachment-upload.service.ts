import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

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

    const versionToken = await this.uploadFile(entry.url, entry.httpMethod, entry.secret, contentType, buffer, sha256Base64);
    this.logger.log(`Allegato SEND caricato: key=${entry.key} versionToken=${versionToken}`);
    return { key: entry.key, versionToken, sha256Base64 };
  }

  // x-amz-checksum-sha256 è un header normale, NON un trailer HTTP — confermato
  // dalla documentazione ufficiale developer.pagopa.it (esempio curl verbatim,
  // guida "Inserimento notifica con il comando curl"): la firma dell'URL
  // presigned S3 è calcolata assumendo il checksum tra gli header firmati, non
  // in coda al body via chunked-trailer — inviarlo come trailer produce
  // SignatureDoesNotMatch da S3 (verificato contro l'ambiente reale).
  private async uploadFile(
    url: string,
    method: 'PUT' | 'POST',
    secret: string,
    contentType: string,
    buffer: Buffer,
    sha256Base64: string,
  ): Promise<string> {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': contentType,
        'x-amz-meta-secret': secret,
        'x-amz-checksum-sha256': sha256Base64,
      },
      body: new Uint8Array(buffer),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Upload allegato SEND fallito: HTTP ${res.status} — ${body.slice(0, 500)}`);
    }
    const versionToken = res.headers.get('x-amz-version-id');
    if (!versionToken) {
      throw new Error('Upload allegato SEND: header x-amz-version-id mancante nella risposta');
    }
    return versionToken;
  }
}
