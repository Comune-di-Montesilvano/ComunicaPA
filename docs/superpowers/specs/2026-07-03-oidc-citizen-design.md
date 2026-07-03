# OIDC cittadini + restyle frontend citizen — Design

Data: 2026-07-03 · Stato: approvato

## Obiettivo

Sostituire il mock login cittadini con il flusso OIDC reale (proxy SPID/CIE, es.
pa-sso-proxy) e rivedere la grafica del portale cittadini in stile GovPay
Interaction Layer (header istituzionale, footer, login page).

## Flusso OIDC — Authorization Code + PKCE, exchange nel backend

1. **Start** — SPA: bottone "Entra con SPID/CIE" → `GET /auth/citizen/oidc/start`.
   Il backend:
   - legge `oidc.issuer` e `oidc.clientId` (settings UI; 503 se mancanti);
   - discovery `<issuer>/.well-known/openid-configuration` (cache in-memory,
     fallback convenzionale `<issuer>/authorize`, `<issuer>/token`);
   - genera `state` + PKCE `code_verifier`/`code_challenge` (S256), salva
     `oidc:state:<state>` → verifier su Redis con TTL 300 s;
   - 302 verso l'authorize endpoint con `redirect_uri=<CITIZEN_ORIGIN>/oidc/callback`,
     `scope=openid profile email`.
2. **Callback** — il proxy riporta il browser su `<CITIZEN_ORIGIN>/oidc/callback?code&state`
   (route SPA). La SPA fa `POST /auth/citizen/oidc/callback {code, state}`:
   - il backend consuma lo state da Redis (GET+DEL; 401 se assente/scaduto);
   - scambia il code al token endpoint (`client_secret` se configurato + verifier);
   - restituisce `{ access_token: <id_token> }`.
3. **Sessione** — la SPA usa il token come Bearer sugli endpoint `/citizen/*`.
   `OidcCitizenStrategy` esistente valida già firma (JWKS), `iss`, `aud`: invariata.
4. **Logout** — la SPA scarta il token e, se `oidc.logoutUrl` è configurata,
   redirige lì il browser.

## Mock cittadini

`POST /auth/citizen/login` (simulatore CF) risponde 403 salvo `LDAP_HOST=mock`.
Nuovo endpoint pubblico `GET /auth/citizen/config` → `{ mode: 'oidc' | 'mock' }`:
la SPA mostra i bottoni SPID/CIE reali oppure il simulatore dev.

## Grafica citizen (riferimento GovPay-Interaction-Layer/frontoffice)

- Slim bar navy "Sito ufficiale della Pubblica Amministrazione"
- Header istituzionale bianco: logo da `/branding`, nome + sottotitolo ente;
  a destra bottone "Accedi" (SPID blu) o menu utente con logout
- Footer scuro istituzionale: identità ente, riga legale (© anno, versione)
- Login page: card centrale con bottoni SPID/CIE
- Solo `frontend-citizen`; l'admin non si tocca

## Error handling

- `start` senza issuer/clientId → 503 con messaggio chiaro (config mancante)
- callback con state sconosciuto/scaduto → 401
- token endpoint che fallisce → 502 con log dell'errore proxy
- SPA: errori mostrati nella login card, retry possibile

## Test

- `oidc-flow.service.spec`: discovery con fallback, start (state su Redis, URL
  authorize corretto), callback ok, state invalido, token endpoint KO
- `auth.controller`: gate 403 del mock con host reale
- Baseline: failure set identico (7 noti)
