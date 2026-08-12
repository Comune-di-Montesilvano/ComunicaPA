# Override admin individuale (indipendente dal gruppo AD)

Data: 2026-08-13

## Problema

Ruolo `admin` oggi deriva SOLO dall'appartenenza al gruppo AD `adminGroup`
(`LdapService.connectAndAuthenticate()`, `apps/backend/src/auth/ldap/ldap.service.ts`).
Non c'è modo di promuovere un singolo operatore ad admin senza modificare i
gruppi AD (fuori controllo di questo repo, spesso non gestibile rapidamente
dall'operatore ComunicaPA).

## Soluzione

Nuova env var bootstrap-only `LDAP_ADMIN_USERNAMES`: lista CSV di username
che vengono SEMPRE trattati come `admin`, indipendentemente dal gruppo AD.
Solo promozione — mai degrado: un admin da gruppo AD resta admin anche se
non è in questa lista.

### Configurazione

- `apps/backend/src/config/configuration.ts`: nuova chiave `ldap.adminUsernames`,
  letta da `process.env.LDAP_ADMIN_USERNAMES` (default `''`), parsata in
  array — split su `,`, `trim()`, `toLowerCase()`, filtro voci vuote.
- `.env.example`: nuova riga commentata con spiegazione, accanto alle var
  `LDAP_ADMIN_GROUP`/`LDAP_REQUIRED_GROUP` esistenti.
- Stesso principio bootstrap-only già in uso per `ldap.host`/`ldap.adminGroup`
  (mai in DB/UI — vedi sezione "Configurazione runtime" in CLAUDE.md).

### Logica

In `LdapService.connectAndAuthenticate()`, dopo il calcolo di `role` da
gruppo AD (riga `const role: OperatorRole = isAdmin ? 'admin' : 'user';`):

```ts
const adminUsernames = this.config.get('ldap.adminUsernames', { infer: true });
const isAdminOverride = adminUsernames.includes(opts.username.toLowerCase());
const role: OperatorRole = (isAdmin || isAdminOverride) ? 'admin' : 'user';
if (isAdminOverride && !isAdmin) {
  this.logger.log(`Override admin individuale applicato per ${opts.username} (LDAP_ADMIN_USERNAMES)`);
}
```

Stesso check applicato nel branch mock (`LDAP_HOST=mock`,
`LdapService.authenticate()`) per coerenza dev/test — un `operator` in dev
può essere promosso admin via la stessa env var, senza dover editare il
codice del mock.

Confronto username case-insensitive (AD `sAMAccountName` è tipicamente
case-insensitive; l'utente passa lo username as-typed al login).

### Non in scope

- Nessuna UI/tabella DB — puramente bootstrap, coerente con la richiesta.
- Nessun degrado (admin-by-group → user): fuori scope, aumenterebbe rischio
  di lockout accidentale per un operatore che gestisce solo `.env`.
- Nessun audit log dedicato oltre al log applicativo esistente (il log
  `logger.log` sopra è sufficiente per capire "perché questo utente è
  admin" in caso di dubbio).

## Test

`ldap.service.spec.ts`, nuovo caso:
- Utente membro solo di `requiredGroup` (non `adminGroup`), con
  `LDAP_ADMIN_USERNAMES` contenente il suo username (config mockata) →
  risultato atteso `role: 'admin'`.
- Caso esistente (utente admin-by-group, non in `adminUsernames`) →
  invariato, resta `admin`.
- Match case-insensitive: username in maiuscolo nella env var, login con
  minuscolo → comunque promosso.

## File toccati

- `apps/backend/src/config/configuration.ts`
- `apps/backend/src/auth/ldap/ldap.service.ts`
- `apps/backend/src/auth/ldap/ldap.service.spec.ts`
- `.env.example`
- `CLAUDE.md` (nota gotcha, se emerge qualcosa di non ovvio in implementazione)
