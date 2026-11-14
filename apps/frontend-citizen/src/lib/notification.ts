export function getTextSnippet(content: string): string {
  if (!content) return '';
  // Rimuovi tag HTML semplici
  let plain = content.replace(/<[^>]*>/g, ' ');
  // Rimuovi link markdown [testo](url) -> testo
  plain = plain.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  // Rimuovi stili grassetto/corsivo markdown
  plain = plain.replace(/\*\*([^*]+)\*\*/g, '$1');
  plain = plain.replace(/\*([^*]+)\*/g, '$1');
  // Rimuovi liste e caratteri speciali
  plain = plain.replace(/^\s*-\s+/gm, '');
  // Normalizza gli spazi bianchi e a capo
  plain = plain.replace(/\s+/g, ' ').trim();
  
  if (plain.length > 85) {
    return plain.slice(0, 82) + '...';
  }
  return plain;
}

export function findPhysicalAddress(extraData: Record<string, any> | undefined): string | null {
  if (!extraData) return null;
  const keys = Object.keys(extraData);
  const addressKey = keys.find(k => /^(indirizzo|address|via|piazza|strada|viale|corso)$/i.test(k));
  const cityKey = keys.find(k => /^(citta|comune|municipality|localita)$/i.test(k));
  const capKey = keys.find(k => /^(cap|zip|codice_postale|zip_code)$/i.test(k));
  const provKey = keys.find(k => /^(provincia|prov|sigla)$/i.test(k));
  const civicoKey = keys.find(k => /^(civico|numero_civico|n_civico|n)$/i.test(k));

  if (addressKey && extraData[addressKey]) {
    let addr = String(extraData[addressKey]);
    if (civicoKey && extraData[civicoKey]) {
      addr += `, ${extraData[civicoKey]}`;
    }
    const city = cityKey && extraData[cityKey] ? String(extraData[cityKey]) : '';
    const cap = capKey && extraData[capKey] ? String(extraData[capKey]) : '';
    const prov = provKey && extraData[provKey] ? String(extraData[provKey]) : '';

    let location = '';
    if (cap) location += cap + ' ';
    if (city) location += city;
    if (prov) location += ` (${prov.toUpperCase()})`;

    return location ? `${addr} - ${location}` : addr;
  }
  return null;
}

export function statusBadge(status: 'pending' | 'queued' | 'sent' | 'failed' | 'skipped'): { cls: string; label: string } {
  if (status === 'sent') return { cls: 'status-notif-received', label: 'Ricevuta' };
  if (status === 'failed' || status === 'skipped') return { cls: 'status-notif-failed', label: 'Non recapitata' };
  return { cls: 'status-notif-pending', label: 'In corso' };
}

export function getSendStatusMeta(status: string): { label: string; cls: string; desc: string } {
  switch (status) {
    case 'VALIDATING':
      return { label: 'In validazione', cls: 'status-validating', desc: 'La piattaforma SEND verifica la conformità dei documenti caricati.' };
    case 'ACCEPTED':
      return { label: 'Depositata', cls: 'status-accepted', desc: 'L\'ente ha depositato la notifica in piattaforma.' };
    case 'DELIVERING':
      return { label: 'Invio in corso', cls: 'status-delivering', desc: 'L\'invio della notifica è in corso.' };
    case 'DELIVERED':
      return { label: 'Consegnata', cls: 'status-delivered', desc: 'L\'invio della notifica è terminato in quanto almeno un recapito digitale è valido.' };
    case 'VIEWED':
      return { label: 'Avvenuto accesso', cls: 'status-viewed', desc: 'Il destinatario ha letto la notifica.' };
    case 'EFFECTIVE_DATE':
      return { label: 'Perfezionata per decorrenza termini', cls: 'status-effective-date', desc: 'Notifica legalmente perfezionata per decorrenza dei termini di legge.' };
    case 'UNREACHABLE':
      return { label: 'Irreperibile', cls: 'status-unreachable', desc: 'Tutti i tentativi di consegna digitali e analogici sono falliti.' };
    case 'CANCELLED':
      return { label: 'Annullata', cls: 'status-cancelled', desc: 'La notifica è stata annullata dall\'ente emittente.' };
    case 'RETURNED_TO_SENDER':
      return { label: 'Restituita al mittente', cls: 'status-returned-to-sender', desc: 'Gli atti sono stati restituiti al mittente per compiuta giacenza cartacea.' };
    case 'REFUSED':
      return { label: 'Rifiutata', cls: 'status-refused', desc: 'La notifica è stata rifiutata in fase di accettazione da parte della piattaforma.' };
    default:
      return { label: status, cls: 'status-unknown', desc: 'Stato non codificato.' };
  }
}
