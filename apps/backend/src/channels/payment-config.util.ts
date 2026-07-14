import type { Recipient } from '../entities/recipient.entity';

export interface ResolvedPaymentData {
  noticeCode: string | null;
  amountCents: number | null;
  creditorTaxId: string | null;
  dueDateIso: string | null;
}

export interface ResolvedPhysicalAddress {
  address: string;
  municipality: string;
  zip?: string;
  province?: string;
}

export function getColumnValue(recipient: Recipient, columnName?: string): string {
  if (!columnName) return '';
  const col = columnName.toLowerCase().trim();
  if (col === 'codice_fiscale' || col === 'cf') return recipient.codiceFiscale;
  if (col === 'full_name' || col === 'nome' || col === 'nominativo') return recipient.fullName || '';
  if (col === 'email') return recipient.email || '';
  if (col === 'pec') return recipient.pec || '';

  if (recipient.extraData) {
    for (const [key, val] of Object.entries(recipient.extraData)) {
      if (key.toLowerCase().trim() === col) {
        return String(val ?? '');
      }
    }
  }
  return '';
}

export function parseDateToIso(dateStr?: string): string | null {
  if (!dateStr) return null;

  let match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}T23:59:59.000Z`;
  }

  match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    return `${year}-${month}-${day}T23:59:59.000Z`;
  }

  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  } catch {}

  return null;
}

/** Risolve i dati di pagamento pagoPA per un destinatario, o null se non applicabile. */
export function resolvePaymentData(
  recipient: Recipient,
  paymentConfig: Record<string, any> | undefined,
): ResolvedPaymentData | null {
  if (!paymentConfig || !paymentConfig.enabled) return null;

  const rawAmount = getColumnValue(recipient, paymentConfig.amountColumn);
  const noticeCode = getColumnValue(recipient, paymentConfig.noticeNumberColumn).replace(/\s+/g, '');

  let amountCents = 0;
  if (paymentConfig.amountType === 'cents') {
    amountCents = parseInt(rawAmount, 10) || 0;
  } else {
    const cleaned = (rawAmount || '').replace(',', '.');
    const parsed = parseFloat(cleaned) || 0;
    amountCents = Math.round(parsed * 100);
  }

  const hasValidPayment = !!noticeCode && amountCents > 0;

  // Il due_date è indipendente dalla validità di notice/amount: valorizzato
  // ogni volta che dueDateColumn è configurata, anche se il resto non risolve.
  let dueDateIso: string | null = null;
  if (paymentConfig.dueDateColumn) {
    dueDateIso = parseDateToIso(getColumnValue(recipient, paymentConfig.dueDateColumn));
  }

  if (!hasValidPayment && !dueDateIso) return null;

  if (!hasValidPayment) {
    return { noticeCode: null, amountCents: null, creditorTaxId: null, dueDateIso };
  }

  let creditorTaxId = '';
  if (paymentConfig.payeeFiscalCodeType === 'static') {
    creditorTaxId = paymentConfig.payeeFiscalCodeStatic || '';
  } else if (paymentConfig.payeeFiscalCodeType === 'column') {
    creditorTaxId = getColumnValue(recipient, paymentConfig.payeeFiscalCodeColumn);
  }
  creditorTaxId = creditorTaxId.toUpperCase().trim();

  return { noticeCode, amountCents, creditorTaxId, dueDateIso };
}

/**
 * Risolve l'indirizzo fisico di fallback per SEND (PN richiede physicalAddress
 * quando non riesce a risolvere un domicilio digitale legale per il
 * destinatario, es. via ANPR/INAD): address e municipality sono obbligatori
 * nello schema PN, ritorna null se anche solo uno dei due non risolve.
 */
export function resolvePhysicalAddress(
  recipient: Recipient,
  physicalAddressConfig: Record<string, any> | undefined,
): ResolvedPhysicalAddress | null {
  if (!physicalAddressConfig || !physicalAddressConfig.enabled) return null;

  const address = getColumnValue(recipient, physicalAddressConfig.addressColumn).trim();
  const municipality = getColumnValue(recipient, physicalAddressConfig.municipalityColumn).trim();
  if (!address || !municipality) return null;

  const zip = getColumnValue(recipient, physicalAddressConfig.zipColumn).trim();
  const province = getColumnValue(recipient, physicalAddressConfig.provinceColumn).trim();

  return {
    address,
    municipality,
    ...(zip ? { zip } : {}),
    ...(province ? { province } : {}),
  };
}
