# ANPR — visualizzazione indirizzo estero (AIRE) in Verifica Anagrafica

## Problema

`AnprIndirizzo`/`AnprResidenza` (backend `anpr.types.ts` e frontend `App.tsx`)
modellano solo l'indirizzo domestico (`comune`/`cap`/`toponimo`/`numeroCivico`).
Per un soggetto AIRE (`generalita.soggettoAIRE === 'S'`), ANPR C002 restituisce
invece `residenza[0].localitaEstera` (consolato + `indirizzoEstero` con
`cap`/`localita.codiceStato`/`localita.descrizioneStato`/`toponimo.denominazione`/
`numeroCivico`) — `indirizzo` è assente.

Il pannello "Verifica Anagrafica" (`App.tsx` ~9973) controlla solo
`anpr.residenza?.[0]` (presente) per entrare nel ramo di rendering, poi legge
`residenza[0].indirizzo?.comune`/`.toponimo`/`.cap` — tutti `undefined` per
AIRE → card visibile ma con tutti i campi vuoti, invece del messaggio
"Nessun indirizzo di residenza registrato" (che scatta solo se `residenza[0]`
manca del tutto, non se manca solo `.indirizzo`).

Verificato dal vivo con un CF reale (AIRE, residenza Svizzera/Lugano — CF
non riportato per tutela dei dati personali) — vedi risposta ANPR completa
in conversazione.

## Scope

Solo visualizzazione nel pannello "Verifica Anagrafica" (`admin/domicilio/cerca`).
Fuori scope: invio singolo (prefill campi, deferito allo spec "invio estero"
POSTAL/SEND), invio reale postale/SEND su indirizzo estero (richiede verifica
separata con GlobalCom/PN su supporto e parametri — progetto futuro).

## Design

**1. Tipi ANPR — backend (`anpr.types.ts`) e frontend (`App.tsx` riga ~907)**

Aggiungere a `AnprResidenza` il campo opzionale `localitaEstera`, pass-through
1:1 dalla struttura ANPR osservata:

```ts
export interface AnprLocalitaEstera {
  consolato?: { codiceConsolato?: string; descrizioneConsolato?: string };
  indirizzoEstero?: {
    cap?: string;
    localita?: { codiceStato?: string; descrizioneLocalita?: string; descrizioneStato?: string };
    toponimo?: { denominazione?: string; numeroCivico?: string };
  };
}

export interface AnprResidenza {
  // ... campi esistenti invariati
  localitaEstera?: AnprLocalitaEstera;
}
```

Nessuna modifica ad `AnprService.getResidenza()`: il campo arriva già
nel JSON grezzo (`soggetto.residenza`), basta che il tipo lo dichiari — stesso
principio di `infoSoggettoEnte` (pass-through, non filtrato dal backend).

**2. Pannello "Verifica Anagrafica" (`App.tsx` card "Indirizzo Fisico (ANPR)")**

Il ramo che oggi assume solo `residenza[0].indirizzo` si dirama in tre casi,
in quest'ordine:

- `residenza[0].indirizzo` presente → rendering attuale invariato (indirizzo IT).
- `residenza[0].indirizzo` assente ma `residenza[0].localitaEstera` presente →
  nuovo rendering: riga in grassetto con via/civico esteri
  (`toponimo.denominazione` + `numeroCivico`), riga muted con
  `cap localita.descrizioneLocalita (descrizioneStato)`, e una terza riga
  muted col consolato (`Consolato: descrizioneConsolato`) se presente. Badge/
  bordo colore invariato (verde, dato trovato — non è un errore, solo un
  formato diverso).
- Nessuno dei due → messaggio esistente "Nessun indirizzo di residenza
  registrato".

Nessuna nuova chiamata API, nessuna modifica a `DomicilioService`/
`domicilio.controller.ts` (già pass-through).

## Test

Nessun test automatico esistente copre il rendering di questo pannello
(componente React inline in `App.tsx`, non estratto). Verifica manuale in
browser con il CF AIRE reale già usato in debug (non riportato per tutela
dei dati personali) dopo il fix, confrontando che la card mostri
l'indirizzo svizzero invece di campi vuoti. Type-check frontend-admin (`tsc -p tsconfig.app.json --noEmit`)
per i nuovi tipi.
