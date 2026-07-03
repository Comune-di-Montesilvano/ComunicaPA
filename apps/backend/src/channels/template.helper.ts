import type { Recipient } from '../entities/recipient.entity';
import { signDownloadLink } from './download-link.util';

/**
 * Replaces fixed placeholders (%allegato1%), standard fields (%nominativo%, %nome%, %cf%, etc.),
 * and dynamic CSV variables (both direct %chiave% and %parametro1(mappato"chiave")%)
 * with the corresponding recipient values.
 */
export function processTemplate(
  bodyTemplate: string,
  recipient: Recipient,
  publicApiUrl: string,
  downloadLinkSecret: string,
  expiresAtUnix: number,
): string {
  const sig = signDownloadLink(recipient.id, expiresAtUnix, downloadLinkSecret);
  const downloadUrl = `${publicApiUrl}/public/download/${recipient.id}?exp=${expiresAtUnix}&sig=${sig}`;
  let content = bodyTemplate;

  // 1. Replace %allegato1%
  content = content.replace(/%allegato1%/g, downloadUrl);

  // 2. Helper to get recipient value case-insensitively
  const getVal = (key: string): string => {
    const k = key.toLowerCase().trim();
    if (k === 'codice_fiscale' || k === 'codicefiscale' || k === 'cf') {
      return recipient.codiceFiscale;
    }
    if (k === 'full_name' || k === 'fullname' || k === 'nome' || k === 'nominativo') {
      return recipient.fullName || '';
    }
    if (k === 'email') {
      return recipient.email || '';
    }
    if (k === 'pec') {
      return recipient.pec || '';
    }
    // Search in extraData keys case-insensitively
    if (recipient.extraData) {
      for (const [exKey, exVal] of Object.entries(recipient.extraData)) {
        if (exKey.toLowerCase() === k) {
          return String(exVal ?? '');
        }
      }
    }
    return '';
  };

  // 3. Replace %parametro\d+(mappato"key")%
  content = content.replace(/%parametro\d+\(mappato"([^"]+)"\)%/gi, (_match, key) => {
    return getVal(key);
  });

  // 4. Replace %key%
  content = content.replace(/%([^%()]+)%/gi, (_match, key) => {
    return getVal(key);
  });

  return content;
}

export interface HtmlLayoutOptions {
  /** URL assoluto del logo ente (già risolto dal chiamante). */
  logoUrl?: string | null;
  /** URL del portale pubblico cittadini per il footer. */
  portalUrl?: string | null;
}

/**
 * Wraps body content in a standard styled HTML template mimicking the GovPay brand design.
 */
export function wrapInHtmlLayout(
  bodyContent: string,
  brandName: string,
  options: HtmlLayoutOptions = {},
): string {
  // Convert newlines to HTML line breaks
  const formattedContent = bodyContent.replace(/\n/g, '<br />');

  const logoHtml = options.logoUrl
    ? `<img src="${options.logoUrl}" alt="${brandName}" style="max-height: 48px; max-width: 180px; vertical-align: middle; margin-right: 12px;" />`
    : '';

  const portalHtml = options.portalUrl
    ? `<br />Consulta le tue comunicazioni sul <a href="${options.portalUrl}" style="color: #0066cc; font-weight: bold;">Portale del Cittadino</a>.`
    : '';

  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
  <div style="background-color: #0066cc; padding: 24px; color: white; display: flex; align-items: center; justify-content: space-between;">
    <div style="font-size: 1.25rem; font-weight: bold; letter-spacing: -0.025em; display: flex; align-items: center;">${logoHtml}${brandName}</div>
    <div style="font-size: 0.875rem; opacity: 0.9; font-weight: 500;">ComunicaPA</div>
  </div>
  <div style="padding: 32px 24px; color: #1a202c; line-height: 1.6; font-size: 0.95rem; background-color: #ffffff;">
    ${formattedContent}
  </div>
  <div style="background-color: #f7fafc; padding: 20px 24px; font-size: 0.775rem; color: #718096; text-align: center; border-top: 1px solid #edf2f7;">
    Questa è una comunicazione ufficiale inviata da <strong>ComunicaPA</strong> per conto di <strong>${brandName}</strong>.<br />
    Si prega di non rispondere direttamente a questa e-mail.${portalHtml}
  </div>
</div>
  `;
}

