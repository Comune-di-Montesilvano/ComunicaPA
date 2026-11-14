import { defineConfig, devices } from '@playwright/test';
import { ADMIN_URL, CITIZEN_URL } from './fixtures/env';

// Fase del run (vedi run.sh): `phase1` = tutto tranne @phase2, `phase2` = solo @phase2 dopo il
// restart del backend. Cartelle separate: Playwright svuota outputDir a ogni avvio e la fase 2
// cancellerebbe gli artefatti della fase 1.
const phase = process.env['E2E_PHASE'] ?? 'phase1';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  outputDir: `test-results/${phase}`,
  // I flussi creano dati propri (suffisso random) ma condividono lo stack: un worker solo
  // tiene bassa la RAM e rende leggibile l'ordine dei log.
  workers: 1,
  fullyParallel: false,
  // Un retry solo in CI (un guasto transitorio di rete/avvio non deve congelare `latest`):
  // Playwright segnala comunque il test come "flaky" nell'elenco. Trace resta
  // `retain-on-failure`: conservata per ogni tentativo fallito, mai per i riusciti.
  retries: process.env['CI'] ? 1 : 0,
  forbidOnly: !!process.env['CI'],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: `playwright-report/${phase}` }]],
  use: {
    // Trace/screenshot solo sui test falliti (niente dati di run riusciti negli artifact).
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Nel container i frontend sono http://<servizio>:8080, non localhost: senza questo
          // flag non sarebbero "secure context" (crypto.randomUUID ecc. assenti), a differenza
          // della produzione dietro HTTPS.
          args: [`--unsafely-treat-insecure-origin-as-secure=${ADMIN_URL},${CITIZEN_URL}`],
        },
      },
    },
  ],
});
