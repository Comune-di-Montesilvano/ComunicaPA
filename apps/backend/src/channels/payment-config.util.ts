import type { Recipient } from '../entities/recipient.entity';

export interface ResolvedPaymentData {
  noticeCode: string;
  amountCents: number;
  creditorTaxId: string;
  dueDateIso: string | null;
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

  if (!noticeCode || amountCents <= 0) return null;

  let creditorTaxId = '';
  if (paymentConfig.payeeFiscalCodeType === 'static') {
    creditorTaxId = paymentConfig.payeeFiscalCodeStatic || '';
  } else if (paymentConfig.payeeFiscalCodeType === 'column') {
    creditorTaxId = getColumnValue(recipient, paymentConfig.payeeFiscalCodeColumn);
  }
  creditorTaxId = creditorTaxId.toUpperCase().trim();

  let dueDateIso: string | null = null;
  if (paymentConfig.dueDateColumn) {
    dueDateIso = parseDateToIso(getColumnValue(recipient, paymentConfig.dueDateColumn));
  }

  return { noticeCode, amountCents, creditorTaxId, dueDateIso };
}
