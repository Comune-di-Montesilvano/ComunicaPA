## Cosa cambia

<!-- Descrizione breve del cambiamento e perché serve -->

## Come è stato testato

<!-- Comandi eseguiti, ambiente (locale/CI), esito -->

## Checklist

- [ ] `pnpm build` passa (stesso comando usato nelle immagini Docker)
- [ ] `pnpm lint` passa
- [ ] `pnpm test` passa (o CI verde su questa PR)
- [ ] Se ho toccato `apps/backend/package.json`, ho aggiornato `pnpm-lock.yaml`
- [ ] Se ho aggiunto una migration, è registrata in `database.module.ts` (vedi CLAUDE.md)
- [ ] Se ho cambiato comportamento canale/INAD/allegati, ho controllato la matrice in `docs/superpowers/specs/2026-07-17-matrice-comportamenti-campagne-design.md`
