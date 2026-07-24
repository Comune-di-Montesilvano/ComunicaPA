# External ID tracciati + campagne a valore legale

## Contesto

Due feature indipendenti ma correlate a tracciabilità/integrità degli invii legali:

1. Il tracciato Maggioli (`pag_indice.csv`) contiene una colonna `'ocr notifica`
   (valori tipo `5890000000049995`) — un identificativo custom del gestionale
   PA, distinto dal `numero_avviso` pagoPA. Oggi il parser (`maggioli-parser.ts`)
   non la legge affatto: viene persa nel CSV arricchito prodotto da
   Arricchimento Tracciati. Serve propagarla come campo `external_id` dedicato,
   sia per i tracciati arricchiti (automatico) sia per CSV generici caricati
   nel wizard (mappabile a mano, come già avviene per `subject` — vedi
   `subject-mapping.util.ts`).
2. Le campagne SEND (PN) e POSTAL con Servizio Agol (Atto Giudiziario) sono
   invii a valore legale: oggi `cancel()`/`remove()` in `campaigns.service.ts`
   possono cancellare campagna/destinatari/tentativi anche per questi canali.
   Serve un flag "campagna a valore legale" che blocchi entrambe le operazioni,
   sempre forzato a `true` per SEND e POSTAL-Agol, attivabile manualmente per
   gli altri canali.

## A — Parsing OCR nel tracciato Maggioli

`MaggioliRecord` (`apps/backend/src/enrichment/maggioli-parser.ts`) guadagna
un campo `ocrNotifica: string`.

- `parsePagIndice()`: legge `row['ocr notifica']` (colonna reale, confermata
  su file di esempio `tinn/maggioli/pag_indice.csv` — minuscolo, dopo lo
  strip dell'apice iniziale già fatto da `stripApice`). Non sempre presente
  (dipende dal tipo di tracciato/configurazione Maggioli lato Comune): se
  vuota, resta stringa vuota.
- `parseRubricaPec()`: il formato "rubrica PEC" non ha mai questa colonna —
  `ocrNotifica` resta sempre `''`.

In `enrichment.processor.ts`, `baseRow()`:

```ts
external_id: rec.ocrNotifica || rec.numeroProvvedimento,
```

Fallback su `numero_provvedimento` quando l'OCR non è presente in quel
tracciato (comportamento confermato dall'utente).

`BASE_CSV_HEADERS` (`enriched-csv.util.ts`) guadagna la colonna
`'external_id'` (in coda, dopo `oggetto`, prima delle colonne dinamiche
`rataN_*`).

## B — Mapping generico + auto-detect per CSV non arricchiti

Nuovo util `apps/backend/src/channels/external-id-mapping.util.ts`,
speculare a `subject-mapping.util.ts`:

```ts
export function resolveExternalId(
  campaign: { channelConfig: Record<string, unknown> },
  recipient: { extraData: Record<string, unknown> },
): string | null {
  const csvMapping = campaign.channelConfig?.['csvMapping'] as Record<string, unknown> | undefined;
  const mappedColumn = csvMapping?.['externalId'] as string | undefined;
  const column = mappedColumn || 'external_id';
  const value = recipient.extraData?.[column] as string | undefined;
  return value && value.trim() ? value.trim() : null;
}
```

Precedenza: mappatura esplicita (`csvMapping.externalId`, impostata a mano
nel wizard) se presente, altrimenti fallback automatico sulla colonna
letterale `external_id` — questo è ciò che rende l'external ID "automatico"
per i tracciati arricchiti (che producono quella colonna) senza bisogno di
passare dalla mappatura manuale.

**Wizard (`App.tsx`)**: `wizMapping` guadagna la chiave `externalId`
(inizializzata a `''` come `subject`), con relativo `<select>` allo Step3
(stesso blocco JSX delle select `codice_fiscale`/`email`/`pec`/`subject`,
riga ~8135-8210), esclusa dalla lista "colonne extra" (riga ~8701-8706), e
scritta in `cfg.csvMapping` insieme alle altre chiavi (riga ~5075/5491) —
solo se valorizzata (mai un default forzato, a differenza di `codice_fiscale`
che è obbligatorio).

## C — Esposizione negli export

Il campo va mostrato in **tutti** i report per-destinatario della campagna,
quando risolvibile (`resolveExternalId` non-null per almeno un destinatario):

- `getDownloadReportRows()` → `DownloadReportRowDto[]`
- `getSendReportRows()` → `SendReportDto.rows[]`
- `getPostalReportRows()` → `PostalReportDto.rows[]`

**DTO** (`campaign-stats.dto.ts`):
- `DownloadReportRowDto` +`externalId: string | null`
- `SendReportRowDto`/`PostalReportRowDto` +`externalId: string | null`
- `DownloadReportRowDto[]` diventa `DownloadReportDto { hasExternalId: boolean; rows: DownloadReportRowDto[] }`
  (stesso wrapping già usato da `SendReportDto`/`PostalReportDto`) — cambio
  di firma di `getDownloadReportRows()` e del relativo controller/CSV builder.
- `SendReportDto`/`PostalReportDto` +`hasExternalId: boolean` (calcolato come
  `hasAppIoCoDelivery`: true se almeno una riga ha `externalId` non-null).

**CSV builder** (`download-report-csv.util.ts`, `send-report-csv.util.ts`,
`postal-report-csv.util.ts`): colonna `"External ID"` aggiunta in coda
all'header e ai valori riga, **solo se** `hasExternalId` è true — stesso
pattern condizionale già usato per `"Esito App IO"`.

**Service**: in ciascuno dei tre metodi, dopo aver caricato i `Recipient`
(serve `extraData` in `select`, oggi non sempre incluso — va aggiunto dove
manca), calcolare `externalId: resolveExternalId(campaign, r)` per riga e
`hasExternalId` come `rows.some(r => r.externalId !== null)`.

## D — Campagna a valore legale

**Entity** (`campaign.entity.ts`): nuova colonna

```ts
@Column({ type: 'boolean', name: 'is_legal_value', default: false })
isLegalValue!: boolean;
```

Migration dedicata (pattern standard, DB temporaneo per generarla).

**Helper** (`campaigns.service.ts` o util dedicato):

```ts
function isCampaignLegalValue(campaign: Campaign): boolean {
  if (campaign.isLegalValue) return true;
  if (campaign.channelType === 'SEND') return true;
  if (campaign.channelType === 'POSTAL') {
    const servizio = String(campaign.channelConfig?.['servizio'] ?? '');
    if (servizio.startsWith('Agol')) return true;
  }
  return false;
}
```

Calcolato a runtime (non sincronizzato in un campo persistito per i casi
auto) — evita di dover tenere `isLegalValue` allineato ogni volta che
`channelConfig.servizio` cambia durante il wizard.

**Enforcement**: in `cancel()` e `remove()` (`campaigns.service.ts`), subito
dopo il fetch della campagna e prima di qualunque mutazione:

```ts
if (isCampaignLegalValue(campaign)) {
  throw new BadRequestException('Campagna a valore legale: annullamento/eliminazione non consentiti');
}
```

**DTO**: `CreateCampaignDto`/`UpdateCampaignDto` +`@IsOptional() @IsBoolean() isLegalValue?: boolean`.
Il valore passato dal client viene scritto sulla colonna così com'è — la
forzatura per SEND/POSTAL-Agol resta solo nell'helper di enforcement, non
sovrascrive il valore persistito (evita il rischio "un nuovo canale futuro
legge `isLegalValue` diverso da quanto mostrato in UI").

**Wizard (`App.tsx`)**: checkbox "Campagna a valore legale" nello Step1
(proprietà campagna, vicino a nome/descrizione). Calcolato lato client con
la stessa logica dell'helper per mostrarla **disabilitata e spuntata**
quando il canale è SEND o (POSTAL e `wizServizio` inizia per `Agol`);
editabile liberamente per gli altri canali/servizi. Il valore va incluso sia
in `buildWizChannelConfigDraft`/salvataggio bozza sia in `handleWizLaunch`
(stesso principio "due punti costruiscono la config, vanno allineati" già
in nota in CLAUDE.md) — qui però è colonna diretta su `Campaign`, non dentro
`channelConfig`, quindi va passata come campo separato nelle chiamate
`create`/`update` della campagna, non dentro l'oggetto `channelConfig`.

**UI liste/dettaglio**: badge "Valore legale" su elenco campagne e dettaglio,
bottoni "Annulla"/"Elimina" disabilitati con tooltip esplicativo quando
`isCampaignLegalValue` è true (replicare l'helper anche lato frontend, dato
che channelType/servizio sono già noti al client).

## Fuori scope

- Nessuna migrazione dei dati storici: campagne SEND/POSTAL-Agol già esistenti
  restano protette solo dall'helper runtime (che non richiede backfill,
  essendo calcolato da `channelType`/`channelConfig` già presenti).
- `getNeverDownloadedRecipients` (report cross-campagna in stats globali) non
  tocca l'external ID — è un report aggregato multi-campagna fuori dal
  concetto "nella campagna", non nello scope indicato dall'utente.
- Nessun blocco su `retryRecipient()`/`retryRecipientsBulk()` — il valore
  legale blocca solo cancellazione/annullamento, non il retry (che anzi è
  l'unica via per portare a termine un invio legale fallito).
