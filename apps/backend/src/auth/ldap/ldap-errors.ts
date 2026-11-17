import { createRequire } from 'node:module';

interface LdapResultLike {
  errorMessage?: string;
  diagnosticMessage?: string;
}

interface LdapjsErrorsModule {
  getError: (res: LdapResultLike) => Error;
  comunicapaDiagnosticPatch?: boolean;
}

/**
 * ldapjs 3.0.7 crea l'errore da `res.errorMessage`, ma `@ldapjs/messages` 1.x
 * espone solo `diagnosticMessage`: il testo del server (per AD
 * `... AcceptSecurityContext error, data 775 ...`) si perde e resta sempre il
 * generico "Invalid Credentials". Il client chiama `errors.getError` sul proprio
 * modulo `lib/errors` (non sul re-export di `ldapjs`), quindi si avvolge quello.
 * Idempotente.
 */
export function patchLdapjsDiagnosticMessage(): void {
  const require = createRequire(import.meta.url);
  const errors = createRequire(require.resolve('ldapjs'))('./errors') as LdapjsErrorsModule;
  if (errors.comunicapaDiagnosticPatch) return;
  const original = errors.getError;
  errors.getError = (res: LdapResultLike) => {
    const err = original(res);
    if (!res.errorMessage && res.diagnosticMessage) err.message = res.diagnosticMessage;
    return err;
  };
  errors.comunicapaDiagnosticPatch = true;
}

/** Sottocodici AD del bind fallito (`data <hex>` nel messaggio diagnostico). */
const AD_BIND_SUBCODES: Record<string, string> = {
  '525': 'utente non trovato',
  '52e': 'password errata',
  '530': 'accesso non consentito in questo orario',
  '531': 'accesso non consentito da questa postazione',
  '532': 'password scaduta',
  '533': 'account disabilitato',
  '701': 'account scaduto',
  '773': 'cambio password obbligatorio',
  '775': 'account bloccato',
};

/** Errore LDAP per il log, con la causa AD in chiaro quando il server la indica. */
export function describeLdapError(err: unknown): string {
  const text = String(err);
  const code = /\bdata ([0-9a-f]{3})\b/i.exec(text)?.[1]?.toLowerCase();
  const hint = code ? AD_BIND_SUBCODES[code] : undefined;
  return hint ? `${text} (AD: ${hint})` : text;
}
