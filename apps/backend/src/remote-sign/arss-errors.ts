export type RemoteSignErrorKind = 'credentials' | 'domain' | 'session' | 'file' | 'network';

export class RemoteSignError extends Error {
  constructor(readonly kind: RemoteSignErrorKind, message: string) {
    super(message);
    this.name = 'RemoteSignError';
  }
}

/**
 * I codici ARSS non sono documentati pubblicamente: classificazione per
 * codice noto (0030 = dominio non abilitato) e per testo della descrizione.
 * Il codice/descrizione grezzi vanno loggati dal chiamante (non contengono
 * segreti) per affinare la mappatura sui casi reali.
 */
export function classifyArssError(stage: 'open' | 'sign', returnCode: string | null, description: string | null): RemoteSignError {
  const desc = description ?? '';
  if (returnCode === '0030' || /domain/i.test(desc)) {
    return new RemoteSignError('domain', 'Dominio non abilitato: verifica Impostazioni → Firma remota');
  }
  if (/session/i.test(desc)) {
    return new RemoteSignError('session', 'Sessione di firma scaduta o non valida');
  }
  if (stage === 'open') {
    return new RemoteSignError('credentials', 'Credenziali o OTP non validi');
  }
  return new RemoteSignError('file', `Aruba ha rifiutato il file (codice ${returnCode ?? '?'}: ${desc || 'nessuna descrizione'})`);
}
