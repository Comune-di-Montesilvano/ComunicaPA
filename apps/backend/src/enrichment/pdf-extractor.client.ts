import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/configuration';

export interface ExtractedAddress {
  indirizzo: string;
  cap: string;
  comune: string;
  provincia: string;
  stato_estero: string;
}

export interface ExtractedPaymentDetail {
  numero_avviso: string;
  numero_avviso_alternativo: string;
  cf_ente: string;
  importo: string;
  scadenza: string;
}

export interface ExtractedPayment {
  totale: ExtractedPaymentDetail | null;
  rate: ExtractedPaymentDetail[];
}

export interface ExtractResult {
  address: ExtractedAddress | null;
  payment: ExtractedPayment | null;
  warnings: string[];
}

@Injectable()
export class PdfExtractorClient {
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  async extract(pdf: Buffer, filename: string): Promise<ExtractResult> {
    const baseUrl = this.config.get('pdfExtractor.url', { infer: true });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);

    const res = await fetch(`${baseUrl}/extract`, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`pdf-extractor HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as ExtractResult;
  }
}
