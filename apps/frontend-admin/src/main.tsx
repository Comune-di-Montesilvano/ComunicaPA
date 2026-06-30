import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './assets/css/tokens.css'
import './assets/css/no-bootstrap-compat.css'
import './assets/css/backoffice-shell.css'
import './assets/css/app.css'
import { App } from './App'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
