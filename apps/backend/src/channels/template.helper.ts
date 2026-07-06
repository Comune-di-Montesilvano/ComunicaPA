import type { Recipient } from '../entities/recipient.entity';
import { signDownloadLink } from './download-link.util';

/**
 * Replaces fixed placeholders (%allegato1%, %allegato2%, ...), the standard
 * "elenco allegati" macro (%elenco_allegati%), standard fields (%nominativo%,
 * %nome%, %cf%, etc.), and dynamic CSV variables (both direct %chiave% and
 * %parametro1(mappato"chiave")%) with the corresponding recipient values.
 *
 * `attachmentLabels` è l'elenco delle etichette configurate sulla campagna
 * (in ordine: indice 0 → %allegato1%, indice 1 → %allegato2%, ...). Ogni
 * etichetta produce un link di download firmato per quell'indice specifico.
 */
export function processTemplate(
  bodyTemplate: string,
  recipient: Recipient,
  publicApiUrl: string,
  downloadLinkSecret: string,
  expiresAtUnix: number,
  attachmentLabels: string[] = [],
  format: 'html' | 'markdown' = 'html',
): string {
  let content = bodyTemplate;

  const buildDownloadUrl = (index: number): string => {
    const sig = signDownloadLink(recipient.id, index, expiresAtUnix, downloadLinkSecret);
    return `${publicApiUrl}/public/download/${recipient.id}/${index}?exp=${expiresAtUnix}&sig=${sig}`;
  };

  // 1. Placeholder individuali %allegato1%, %allegato2%, ... (uno per etichetta configurata)
  attachmentLabels.forEach((_, index) => {
    const placeholder = new RegExp(`%allegato${index + 1}%`, 'g');
    content = content.replace(placeholder, buildDownloadUrl(index));
  });

  // 2. Macro %elenco_allegati%: blocco con etichetta+link per ogni allegato
  if (content.includes('%elenco_allegati%')) {
    const block = attachmentLabels.length === 0
      ? ''
      : format === 'markdown'
        ? attachmentLabels
            .map((label, index) => `- **${label}**: [Scarica](${buildDownloadUrl(index)})`)
            .join('\n')
        : `<table style="width:100%; border-collapse: collapse;">${attachmentLabels
            .map(
              (label, index) =>
                `<tr><td style="padding:6px 12px; border-bottom:1px solid #edf2f7;">${label}</td><td style="padding:6px 12px; border-bottom:1px solid #edf2f7;"><a href="${buildDownloadUrl(index)}">Scarica</a></td></tr>`,
            )
            .join('')}</table>`;
    content = content.replace(/%elenco_allegati%/g, block);
  }

  // 3. Helper to get recipient value case-insensitively
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

  // 4. Replace %parametro\d+(mappato"key")%
  content = content.replace(/%parametro\d+\(mappato"([^"]+)"\)%/gi, (_match, key) => {
    return getVal(key);
  });

  // 5. Replace %key% (esclude %allegatoN% residui non consumati allo step 1:
  // nessuna etichetta configurata per quell'indice → il placeholder resta letterale)
  content = content.replace(/%([^%()]+)%/gi, (fullMatch, key) => {
    if (/^allegato\d+$/i.test(key.trim())) {
      return fullMatch;
    }
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

