// Default del passo 1 del wizard campagna (logica pura, testata in tests/wizard-defaults.spec.ts).

type MailConfigRef = { id: string; type: 'EMAIL' | 'PEC'; active: boolean; isDefault: boolean };

/**
 * Mittente da mostrare per il canale scelto. Con EMAIL/PEC, se il valore attuale è vuoto
 * o appartiene all'altro tipo (es. passaggio EMAIL → PEC), propone la configurazione attiva
 * predefinita del canale, altrimenti la prima attiva. Un valore dello stesso tipo resta
 * com'è (bozza riaperta, scelta dell'operatore). Elenco non ancora caricato → nessun cambio.
 */
export function pickWizardMailConfigId(
  configs: readonly MailConfigRef[],
  channel: string,
  current: string,
): string {
  if (channel !== 'EMAIL' && channel !== 'PEC') return current;
  if (configs.length === 0) return current;
  const cur = configs.find((c) => c.id === current);
  if (current && (!cur || cur.type === channel)) return current;
  const def =
    configs.find((c) => c.type === channel && c.active && c.isDefault) ??
    configs.find((c) => c.type === channel && c.active);
  return def?.id ?? '';
}

/**
 * Co-consegna App IO senza alcun servizio configurato: non può essere attiva (il passo 1
 * resterebbe bloccato sul servizio obbligatorio) → "none". Prima che l'elenco servizi sia
 * caricato non si tocca nulla.
 */
export function coDeliveryModeWithServices<M extends string>(
  mode: M | 'none',
  servicesLoaded: boolean,
  servicesCount: number,
): M | 'none' {
  return servicesLoaded && servicesCount === 0 ? 'none' : mode;
}
