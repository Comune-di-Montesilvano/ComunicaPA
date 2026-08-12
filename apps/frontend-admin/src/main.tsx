import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './assets/css/tokens.css'
import './assets/css/no-bootstrap-compat.css'
import './assets/css/backoffice-shell.css'
import './assets/css/app.css'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'

// Attivo SOLO se sentryDsn è valorizzata in window.__COMUNICAPA_CONFIG__
// (config runtime generata da nginx/20-runtime-config.sh da SENTRY_DSN_ADMIN
// — mai VITE_*, l'immagine è generica e condivisa da tutte le istanze).
const sentryDsn = window.__COMUNICAPA_CONFIG__?.sentryDsn
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: window.__COMUNICAPA_CONFIG__?.sentryEnvironment || 'unknown',
    tracesSampleRate: 0,
  })
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
