# Tag protocollo automatico nell'oggetto PEC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando una campagna ha `channelConfig.protocolla === true`, l'oggetto della PEC realmente inviata (canale PEC o dirottamento INAD verso PEC) deve terminare con `[Protocollo N.ro <anno>-PROT-<numero>]`, e un eventuale placeholder manuale `%%protocollo%%` nel template oggetto va rimosso per evitare doppioni.

**Architecture:** Modifica isolata in `PecStrategy.send()` (`apps/backend/src/channels/pec/pec.strategy.ts`): prima di `processTemplate` si rimuove dal subject template ogni placeholder protocollo residuo; dopo `processTemplate` si appende il tag costruito da `recipient.protocolNumber` (formato `"numero/anno"`, già impostato da `notification.processor.ts` prima della chiamata a `strategy.send()`). Nessuna modifica ad altri canali o a `template.helper.ts`.

**Tech Stack:** NestJS 10 + TypeScript, Jest (`--maxWorkers=2` nel container).

## Global Constraints

- Spec di riferimento: `docs/superpowers/specs/2026-07-24-tag-protocollo-oggetto-pec-design.md`
- Modifica scoped a PEC in uscita (canale o dirottamento INAD) — non toccare `email.strategy.ts`, `postal.strategy.ts`, `send-dispatch.service.ts`, `protocollazione.processor.ts`, `template.helper.ts`
- Formato tag esatto: `` ` [Protocollo N.ro ${anno}-PROT-${numero}]` `` (spazio iniziale prima della parentesi quadra, così si accoda pulito a un oggetto non vuoto)
- Placeholder da rimuovere (case-insensitive, solo nel subject template, solo se `protocolla === true`): `%%numero_protocollo%%`, `%%numeroprotocollo%%`, `%%protocollo%%`, `%%protocol_number%%`
- Se `recipient.protocolNumber` assente nonostante `protocolla === true`: nessun tag, invio prosegue comunque (mai bloccare per un problema di formattazione oggetto)
- Test in `apps/backend/src/channels/pec/pec.strategy.spec.ts`, comando: `docker compose exec backend node_modules/.bin/jest pec.strategy --maxWorkers=2`

---

### Task 1: Strip placeholder protocollo ridondante dall'oggetto quando `protocolla === true`

**Files:**
- Modify: `apps/backend/src/channels/pec/pec.strategy.ts:55` (dichiarazione `subjectTemplate`)
- Test: `apps/backend/src/channels/pec/pec.strategy.spec.ts`

**Interfaces:**
- Consumes: `campaign.channelConfig?.['protocolla']` (boolean, letto da `channelConfig` esistente — nessun nuovo tipo)
- Produces: `subjectTemplate` (string) ripulito dal placeholder protocollo prima di essere passato a `processTemplate` — usato da Task 2

- [ ] **Step 1: Scrivi il test che verifica lo strip del placeholder**

Aggiungi in `apps/backend/src/channels/pec/pec.strategy.spec.ts`, dopo il test `'send() su campagna PEC usa mailConfigId (comportamento invariato)'`:

```typescript
  it('send() con protocolla=true rimuove il placeholder %%protocollo%% ridondante dall\'oggetto', async () => {
    const recipient = {
      pec: 'luca@pec.it', email: null, fullName: 'Luca', codiceFiscale: 'CF1',
      protocolNumber: '47509/2026',
    };
    const campaign = {
      name: 'T',
      channelConfig: { subject: 'Avviso rif. %%protocollo%% per {{fullName}}', body: 'B', protocolla: true },
    };

    await strategy.send(recipient as never, campaign as never);

    const sentSubject = mockSendMail.mock.calls[0][0].subject;
    expect(sentSubject).not.toContain('47509/2026');
    expect(sentSubject).toBe('Avviso rif.  per Luca [Protocollo N.ro 2026-PROT-47509]');
  });
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest pec.strategy --maxWorkers=2`
Expected: FAIL — l'oggetto contiene ancora `47509/2026` (nessuno strip, nessun tag) e non combacia con la stringa attesa.

- [ ] **Step 3: Implementa lo strip del placeholder**

In `apps/backend/src/channels/pec/pec.strategy.ts`, sostituisci la riga:

```typescript
    const subjectTemplate = (campaign.channelConfig?.['subject'] as string) || 'Notifica PEC ComunicaPA';
```

con:

```typescript
    const protocollaAttiva = campaign.channelConfig?.['protocolla'] === true;
    let subjectTemplate = (campaign.channelConfig?.['subject'] as string) || 'Notifica PEC ComunicaPA';
    if (protocollaAttiva) {
      // Placeholder manuale ridondante: il tag protocollo viene aggiunto
      // automaticamente in fondo all'oggetto più sotto (dopo processTemplate).
      subjectTemplate = subjectTemplate.replace(
        /%%(numero_protocollo|numeroprotocollo|protocollo|protocol_number)%%/gi,
        '',
      );
    }
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest pec.strategy --maxWorkers=2`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/pec/pec.strategy.ts apps/backend/src/channels/pec/pec.strategy.spec.ts
git commit -m "feat(backend): strip placeholder protocollo ridondante da oggetto PEC quando protocolla attiva"
```

---

### Task 2: Append tag `[Protocollo N.ro <anno>-PROT-<numero>]` all'oggetto PEC

**Files:**
- Modify: `apps/backend/src/channels/pec/pec.strategy.ts:60` (riga `const subject = processTemplate(...)`)
- Test: `apps/backend/src/channels/pec/pec.strategy.spec.ts`

**Interfaces:**
- Consumes: `protocollaAttiva` (boolean, da Task 1), `recipient.protocolNumber` (string `"numero/anno"` opzionale, già presente sull'oggetto `recipient` grazie a `notification.processor.ts` — non richiede modifiche al tipo `Recipient`, letto via cast come già avviene altrove nel file per altri campi dinamici)
- Produces: `subject` (string) finale passato a `transporter.sendMail()` — nessun consumer a valle in questo piano

- [ ] **Step 1: Scrivi il test per il tag con protocolNumber presente**

Aggiungi in `apps/backend/src/channels/pec/pec.strategy.spec.ts`:

```typescript
  it('send() con protocolla=true e protocolNumber appende il tag protocollo in fondo all\'oggetto', async () => {
    const recipient = {
      pec: 'luca@pec.it', email: null, fullName: 'Luca', codiceFiscale: 'CF1',
      protocolNumber: '47509/2026',
    };
    const campaign = {
      name: 'T',
      channelConfig: { subject: 'Avviso TARI', body: 'B', protocolla: true },
    };

    await strategy.send(recipient as never, campaign as never);

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Avviso TARI [Protocollo N.ro 2026-PROT-47509]' }),
    );
  });

  it('send() con protocolla=true ma senza protocolNumber non aggiunge alcun tag e non blocca l\'invio', async () => {
    const recipient = { pec: 'luca@pec.it', email: null, fullName: 'Luca', codiceFiscale: 'CF1' };
    const campaign = {
      name: 'T',
      channelConfig: { subject: 'Avviso TARI', body: 'B', protocolla: true },
    };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Avviso TARI' }));
    expect(result.messageId).toBe('pec-001');
  });

  it('send() con protocolla assente non aggiunge alcun tag (comportamento invariato)', async () => {
    const recipient = {
      pec: 'luca@pec.it', email: null, fullName: 'Luca', codiceFiscale: 'CF1',
      protocolNumber: '47509/2026',
    };
    const campaign = { name: 'T', channelConfig: { subject: 'Avviso TARI', body: 'B' } };

    await strategy.send(recipient as never, campaign as never);

    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Avviso TARI' }));
  });
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest pec.strategy --maxWorkers=2`
Expected: FAIL sui primi due nuovi test (nessun tag aggiunto, oggetto resta `'Avviso TARI'` invece di contenere il tag) — il terzo passa già (nessuna modifica attesa quando `protocolla` è assente).

- [ ] **Step 3: Implementa l'append del tag**

In `apps/backend/src/channels/pec/pec.strategy.ts`, sostituisci la riga:

```typescript
    const subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'html', 'PEC');
```

con:

```typescript
    let subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'html', 'PEC');
    if (protocollaAttiva) {
      const protocolNumber = (recipient as any).protocolNumber as string | undefined;
      if (protocolNumber) {
        const [numero, anno] = protocolNumber.split('/');
        subject = `${subject} [Protocollo N.ro ${anno}-PROT-${numero}]`;
      }
    }
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest pec.strategy --maxWorkers=2`
Expected: PASS su tutti i test del file (inclusi i preesistenti — nessuna regressione)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/pec/pec.strategy.ts apps/backend/src/channels/pec/pec.strategy.spec.ts
git commit -m "feat(backend): tag protocollo automatico in fondo all'oggetto PEC quando protocolla attiva"
```

---

### Task 3: Verifica suite completa (baseline pulita)

**Files:** nessuna modifica — solo verifica

**Interfaces:** nessuna (task di sola verifica)

- [ ] **Step 1: Esegui la suite backend completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso set di fallimenti della baseline nota (1 solo, `app.controller.spec.ts` / `isLdapMock`, artefatto di `LDAP_HOST=mock` in dev) — nessun nuovo fallimento oltre a quello.

- [ ] **Step 2: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Se tutto verde, nessun commit necessario (task di sola verifica)**

Se emergono fallimenti nuovi rispetto alla baseline, tornare al task che li ha introdotti e correggere prima di considerare il piano completo.
