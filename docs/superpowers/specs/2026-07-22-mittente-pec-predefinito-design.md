# Mittente PEC/EMAIL predefinito

Data: 2026-07-22

## Obiettivo

Permettere di marcare una configurazione server PEC (e, per coerenza, EMAIL)
come "predefinita" da Impostazioni, e usarla come preselezione automatica
nel wizard campagne (invio singolo e massivo) quando l'operatore sceglie
quel canale, senza dover scegliere manualmente il mittente ogni volta.

## Scope

`mail_server_configs` ha due `type` indipendenti: `PEC` ed `EMAIL`. Il
default è per-type: una config PEC default e una config EMAIL default,
indipendenti tra loro (impostare il default PEC non tocca quello EMAIL).

## Pattern di riferimento

Replica esatta del pattern già esistente per App IO
(`IoServiceConfig.isDefault`, `IoServicesService`, `io-services.controller.ts`,
badge "(Predefinito)" in `App.tsx`) — stesso comportamento, stessa forma.

## Backend

**Migration**: nuova colonna `is_default boolean NOT NULL DEFAULT false` su
`mail_server_configs`. Generata con DB temporaneo (procedura standard da
CLAUDE.md), niente `ALTER TYPE` (è booleano, non enum).

**Entity** `MailServerConfig`: campo `isDefault: boolean`.

**`MailConfigsService`**:
- `create`/`update`: se `isDefault: true` nel payload, unset automatico di
  `isDefault` su tutte le altre config con lo stesso `type` (query
  `update({type, isDefault:true}, {isDefault:false})` prima dell'insert/update).
- `setDefault(id)`: nuovo metodo, stesso schema di
  `IoServicesService.setDefault` — imposta `isDefault:true` sulla config
  richiesta, unset sulle altre dello stesso `type`.
- `remove(id)`: blocca (con messaggio esplicito) se la config è l'unica
  `active` e `isDefault` del suo `type` — stesso guard di `IoServicesService.remove`.
- `resolveForSend(type, mailConfigId?)`: priorità aggiornata —
  1. `mailConfigId` esplicito passato (se coerente col `type`) — invariato
  2. config con `isDefault:true && active:true` del `type` — **nuovo**
  3. prima config `active:true` del `type` per `createdAt ASC` — comportamento
     esistente, ora fallback
  4. fallback legacy su settings `smtp.*`/`pec.*` — invariato

**`MailConfigsController`**: nuova route
`PATCH admin/mail-configs/:id/default` (ruolo `admin`), stesso schema di
`io-services.controller.ts` riga 44.

## Frontend — Impostazioni (`App.tsx`, `renderMailConfigTab`)

Per ogni riga della lista config (EMAIL e PEC separatamente):
- badge `(Predefinito)` accanto al nome se `isDefault === true`
- bottone "Imposta come predefinito" per le righe non-default (nascosto
  sulla riga già default) — stesso stile/posizionamento del pattern App IO
  in `App.tsx` riga 6755.

## Frontend — Wizard

**Invio singolo rapido** (`handleCreateCampaign`): quando non ci sono
`configOverrides` espliciti, la selezione automatica passa da
`mailConfigs.find(c => c.type === 'PEC' && c.active)` a
`mailConfigs.find(c => c.type === canale && c.isDefault && c.active) ??
mailConfigs.find(c => c.type === canale && c.active)` — se nessun default
è impostato, comportamento identico a oggi (prima attiva).

**Wizard massivo**: al cambio canale verso EMAIL/PEC, SE `wizMailConfigId`
è vuoto/`undefined` (non ancora impostato in questa sessione di editing),
viene preselezionato con la config default attiva di quel `type`. Se
l'operatore lo modifica manualmente, la scelta non viene mai sovrascritta
automaticamente — si azzera solo dove già oggi si azzera lo stato wizard
(`resetWizard()`, nuova bozza, `prefillWizardFrom()` con valore diverso da
una campagna esistente).

## Fuori scope

- Nessun default "globale" cross-type: PEC e EMAIL restano selezioni
  indipendenti.
- Nessuna modifica a `wizPecReserveMailConfigId` (fallback INAD) — resta
  scelta manuale esplicita, non eredita il default.
