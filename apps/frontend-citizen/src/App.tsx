import React, { useState, useEffect } from 'react';
import { Footer } from './components/Footer';

declare global {
  interface Window {
    __COMUNICAPA_CONFIG__?: { apiBase?: string };
  }
}

const API_BASE = window.__COMUNICAPA_CONFIG__?.apiBase ?? 'http://localhost:8080';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Converte il markdown minimale generato da processTemplate() (App IO: **bold**,
 * *italic*, [testo](url), liste "- item", paragrafi separati da riga vuota) in
 * HTML sicuro da passare a dangerouslySetInnerHTML. Escape del testo grezzo PRIMA
 * di applicare le trasformazioni, cosi eventuali "<script>" nei dati del CSV non
 * vengono mai interpretati come markup; solo URL http(s)/mailto sono ammesse nei
 * link, per non introdurre schemi javascript: cliccabili.
 */
function renderAppIoMarkdown(markdown: string): string {
  const escaped = escapeHtml(markdown);
  const withLinks = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  const withBold = withLinks.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const withItalic = withBold.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  const paragraphs = withItalic.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*-\s+/.test(l) && l.trim() !== '')) {
      const items = lines.map((l) => `<li>${l.replace(/^\s*-\s+/, '')}</li>`).join('');
      return `<ul>${items}</ul>`;
    }
    return `<p>${lines.join('<br />')}</p>`;
  });

  return paragraphs.join('');
}

function decodeJwtClaims(token: string): { cf: string; name: string; provider?: string } {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return { cf: '', name: '' };
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (base64.length % 4)) % 4;
    const padded = base64 + '='.repeat(pad);
    
    // Decodifica UTF-8 sicura per atob
    const binStr = atob(padded);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    const jsonStr = new TextDecoder().decode(bytes);
    const payload = JSON.parse(jsonStr) as Record<string, unknown>;
    
    const rawCf = String(
      payload['fiscal_number'] ??
        payload['https://attributes.eid.gov.it/fiscal_number'] ??
        payload['https://attributes.spid.gov.it/fiscalNumber'] ??
        payload['codice_fiscale'] ??
        payload['cf'] ??
        payload['codiceFiscale'] ??
        payload['fiscalNumber'] ??
        payload['fiscalCode'] ??
        '',
    ).toUpperCase();
    const cf = rawCf.replace(/^TIN[A-Z]{2}-/, '');
    
    const given = String(
      payload['given_name'] ??
        payload['first_name'] ??
        payload['givenName'] ??
        '',
    );
    const family = String(
      payload['family_name'] ??
        payload['last_name'] ??
        payload['sn'] ??
        payload['surname'] ??
        payload['familyName'] ??
        '',
    );
    const name =
      (given && family)
        ? `${given} ${family}`
        : (String(payload['name'] ?? '') || [given, family].filter(Boolean).join(' '));
    
    // Rileva provider (SPID, CIE, eIDAS, IT-Wallet, ecc.)
    const amr = payload['amr'];
    let provider = 'Identità Digitale';
    if (payload['provider_name']) {
      provider = String(payload['provider_name']);
    } else if (amr) {
      const amrVal = Array.isArray(amr) ? amr[0] : amr;
      if (typeof amrVal === 'string') {
        const amrLower = amrVal.toLowerCase();
        if (amrLower.includes('cie') || amrLower.includes('interno.gov.it')) {
          provider = 'CIE';
        } else if (amrLower.includes('spid')) {
          provider = 'SPID';
        } else if (amrLower.includes('eidas')) {
          provider = 'eIDAS';
        } else if (amrLower.includes('wallet') || amrLower.includes('itwallet')) {
          provider = 'IT-Wallet';
        } else {
          provider = amrVal.toUpperCase();
        }
      }
    }
    
    return { cf, name, provider };
  } catch (e) {
    console.error('decodeJwtClaims error:', e);
    return { cf: '', name: '', provider: 'Identità Digitale' };
  }
}

function getTextSnippet(content: string): string {
  if (!content) return '';
  // Rimuovi tag HTML semplici
  let plain = content.replace(/<[^>]*>/g, ' ');
  // Rimuovi link markdown [testo](url) -> testo
  plain = plain.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  // Rimuovi stili grassetto/corsivo markdown
  plain = plain.replace(/\*\*([^*]+)\*\*/g, '$1');
  plain = plain.replace(/\*([^*]+)\*/g, '$1');
  // Rimuovi liste e caratteri speciali
  plain = plain.replace(/^\s*-\s+/gm, '');
  // Normalizza gli spazi bianchi e a capo
  plain = plain.replace(/\s+/g, ' ').trim();
  
  if (plain.length > 85) {
    return plain.slice(0, 82) + '...';
  }
  return plain;
}

function findPhysicalAddress(extraData: Record<string, any> | undefined): string | null {
  if (!extraData) return null;
  const keys = Object.keys(extraData);
  const addressKey = keys.find(k => /^(indirizzo|address|via|piazza|strada|viale|corso)$/i.test(k));
  const cityKey = keys.find(k => /^(citta|comune|municipality|localita)$/i.test(k));
  const capKey = keys.find(k => /^(cap|zip|codice_postale|zip_code)$/i.test(k));
  const provKey = keys.find(k => /^(provincia|prov|sigla)$/i.test(k));
  const civicoKey = keys.find(k => /^(civico|numero_civico|n_civico|n)$/i.test(k));

  if (addressKey && extraData[addressKey]) {
    let addr = String(extraData[addressKey]);
    if (civicoKey && extraData[civicoKey]) {
      addr += `, ${extraData[civicoKey]}`;
    }
    const city = cityKey && extraData[cityKey] ? String(extraData[cityKey]) : '';
    const cap = capKey && extraData[capKey] ? String(extraData[capKey]) : '';
    const prov = provKey && extraData[provKey] ? String(extraData[provKey]) : '';

    let location = '';
    if (cap) location += cap + ' ';
    if (city) location += city;
    if (prov) location += ` (${prov.toUpperCase()})`;

    return location ? `${addr} - ${location}` : addr;
  }
  return null;
}

interface Notification {
  id: string;
  codiceFiscale: string;
  fullName: string | null;
  email: string | null;
  pec: string | null;
  status: 'pending' | 'queued' | 'sent' | 'failed' | 'skipped';
  createdAt: string;
  extraData?: Record<string, any>;
  channelType: string;
  subject: string;
  bodyHtml?: string;
  bodyMarkdown?: string;
  attachments: Array<{ index: number; label: string }>;
  iun?: string | null;
  sendStatus?: string | null;
  sendStatusHistory?: Array<{ status: string; activeFrom: string }> | null;
  sendDigitalDomicile?: { type: string; address: string | null; source: string } | null;
}

function statusBadge(status: Notification['status']): { cls: string; label: string } {
  if (status === 'sent') return { cls: 'status-notif-received', label: 'Ricevuta' };
  if (status === 'failed' || status === 'skipped') return { cls: 'status-notif-failed', label: 'Non recapitata' };
  return { cls: 'status-notif-pending', label: 'In corso' };
}

function getSendStatusMeta(status: string): { label: string; cls: string; desc: string } {
  switch (status) {
    case 'VALIDATING':
      return { label: 'In validazione', cls: 'status-validating', desc: 'La piattaforma SEND verifica la conformità dei documenti caricati.' };
    case 'ACCEPTED':
      return { label: 'Depositata', cls: 'status-accepted', desc: 'L\'ente ha depositato la notifica in piattaforma.' };
    case 'DELIVERING':
      return { label: 'Invio in corso', cls: 'status-delivering', desc: 'L\'invio della notifica tramite canali digitali o analogici è in corso.' };
    case 'DELIVERED':
      return { label: 'Consegnata', cls: 'status-delivered', desc: 'L\'invio della notifica è terminato in quanto almeno un recapito digitale è valido.' };
    case 'VIEWED':
      return { label: 'Avvenuto accesso', cls: 'status-viewed', desc: 'Il destinatario ha letto la notifica.' };
    case 'EFFECTIVE_DATE':
      return { label: 'Perfezionata per decorrenza termini', cls: 'status-effective-date', desc: 'Notifica legalmente perfezionata per decorrenza dei termini di legge.' };
    case 'UNREACHABLE':
      return { label: 'Irreperibile', cls: 'status-unreachable', desc: 'Tutti i tentativi di consegna digitali e analogici sono falliti.' };
    case 'CANCELLED':
      return { label: 'Annullata', cls: 'status-cancelled', desc: 'La notifica è stata annullata dall\'ente emittente.' };
    case 'RETURNED_TO_SENDER':
      return { label: 'Restituita al mittente', cls: 'status-returned-to-sender', desc: 'Gli atti sono stati restituiti al mittente per compiuta giacenza cartacea.' };
    case 'REFUSED':
      return { label: 'Rifiutata', cls: 'status-refused', desc: 'La notifica è stata rifiutata in fase di accettazione da parte della piattaforma.' };
    default:
      return { label: status, cls: 'status-unknown', desc: 'Stato non codificato.' };
  }
}

const CHANNEL_META: Record<string, { label: string; icon: string; cls: string; logo?: string }> = {
  PEC: { label: 'PEC', icon: 'fa-envelope-open-text', cls: 'channel-pec' },
  EMAIL: { label: 'Email', icon: 'fa-envelope', cls: 'channel-email' },
  APP_IO: { label: 'AppIO', icon: 'fa-mobile-screen', cls: 'channel-appio', logo: 'https://ioapp.it/assets/IO_84d780c485.svg' },
  SEND: { label: 'SEND', icon: 'fa-paper-plane', cls: 'channel-send' },
  POSTAL: { label: 'Postalizzazione', icon: 'fa-envelope-circle-check', cls: 'channel-postal' },
  CITIZEN_PORTAL: { label: 'Portale Cittadino', icon: 'fa-globe', cls: 'channel-portal' },
};

function ChannelBadge({ channel }: { channel: string }): React.JSX.Element {
  const meta = CHANNEL_META[channel] ?? { label: channel || '—', icon: 'fa-paper-plane', cls: 'channel-generic' };
  
  if (channel === 'APP_IO') {
    return (
      <span className="channel-badge channel-appio">
        <span className="f-partner-chip" style={{ width: 16, height: 16, borderRadius: 4, marginRight: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', padding: 2 }}>
          <img src="https://ioapp.it/assets/IO_84d780c485.svg" alt="" width={12} height={12} style={{ display: 'block' }} />
        </span>
        App IO
      </span>
    );
  }

  if (channel === 'SEND') {
    return (
      <span className="channel-badge channel-send">
        <span className="f-partner-chip" style={{ width: 16, height: 16, borderRadius: 4, marginRight: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', padding: 2 }}>
          <img src="https://notifichedigitali.it/assets/logo_d7df1d4592.svg" alt="" width={12} height={12} style={{ display: 'block' }} />
        </span>
        SEND
      </span>
    );
  }

  return (
    <span className={`channel-badge ${meta.cls}`}>
      <i className={`fas ${meta.icon}`} aria-hidden="true" style={{ marginRight: 6 }}></i>
      {meta.label}
    </span>
  );
}

export function App(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(localStorage.getItem('comunicapa_citizen_token'));
  const [cf, setCf] = useState<string | null>(localStorage.getItem('comunicapa_citizen_cf'));
  const [name, setName] = useState<string | null>(localStorage.getItem('comunicapa_citizen_name'));
  const [provider, setProvider] = useState<string>(localStorage.getItem('comunicapa_citizen_provider') || 'Identità Digitale');
  const [entityName, setEntityName] = useState('Comune di Montesilvano');
  const [brandLogoUrl, setBrandLogoUrl] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Modalità auth decisa dal backend: 'oidc' (SPID/CIE reale) o 'mock' (simulatore dev)
  const [authMode, setAuthMode] = useState<'oidc' | 'mock' | null>(null);
  const [oidcLogoutUrl, setOidcLogoutUrl] = useState<string | null>(null);
  const [oidcExchanging, setOidcExchanging] = useState(
    window.location.pathname === '/oidc/callback',
  );

  // Lobby state
  const [selectedCf, setSelectedCf] = useState('MRKDDD80A01H501A');
  const [customCf, setCustomCf] = useState('');
  const [customName, setCustomName] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Portal state
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loadingNotifications, setLoadingNotifications] = useState(false);
  const [errorNotifications, setErrorNotifications] = useState<string | null>(null);
  const [selectedNotif, setSelectedNotif] = useState<Notification | null>(null);
  const [sendLegalFacts, setSendLegalFacts] = useState<Array<{ legalFactId: string; category: string }>>([]);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  // Filtri pannello ricerca (client-side, nessuna nuova chiamata di rete)
  const [searchText, setSearchText] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'sent' | 'pending' | 'failed'>('all');
  const [filterChannel, setFilterChannel] = useState('all');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  const resetFilters = () => {
    setSearchText('');
    setFilterStatus('all');
    setFilterChannel('all');
    setFilterDateFrom('');
    setFilterDateTo('');
  };

  const hasActiveFilters = !!(searchText || filterStatus !== 'all' || filterChannel !== 'all' || filterDateFrom || filterDateTo);

  const availableChannels = Array.from(
    new Set(notifications.map((n) => n.channelType).filter((c): c is string => !!c)),
  );

  const filteredNotifications = notifications.filter((n) => {
    if (searchText) {
      const haystack = `${n.subject || ''}`.toLowerCase();
      if (!haystack.includes(searchText.toLowerCase())) return false;
    }
    if (filterStatus !== 'all') {
      const bucket = n.status === 'sent' ? 'sent' : (n.status === 'failed' || n.status === 'skipped') ? 'failed' : 'pending';
      if (bucket !== filterStatus) return false;
    }
    if (filterChannel !== 'all' && n.channelType !== filterChannel) return false;
    if (filterDateFrom && new Date(n.createdAt) < new Date(filterDateFrom)) return false;
    if (filterDateTo) {
      const to = new Date(filterDateTo);
      to.setHours(23, 59, 59, 999);
      if (new Date(n.createdAt) > to) return false;
    }
    return true;
  });

  const [activeTab, setActiveTab] = useState<'notifications' | 'profile'>('notifications');
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // Chiudi i menu cliccando fuori
  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (userMenuOpen && !target.closest('.fo-user-menu')) {
        setUserMenuOpen(false);
      }
      if (showAdvancedFilters && !target.closest('.search-bar-wrap')) {
        setShowAdvancedFilters(false);
      }
    };
    document.addEventListener('click', handleDocumentClick);
    return () => document.removeEventListener('click', handleDocumentClick);
  }, [userMenuOpen, showAdvancedFilters]);

  // Simulated test citizens
  const testCitizens = [
    { cf: 'MRKDDD80A01H501A', name: 'Mirko Daddiego', email: 'mirko.daddiego@example.com' },
    { cf: 'RSSMRA80A01H501X', name: 'Mario Rossi', email: 'mario.rossi@example.com' },
    { cf: 'BNCMRI80A01H501Y', name: 'Maria Bianchi', email: 'maria.bianchi@example.com' },
  ];

  useEffect(() => {
    if (token) {
      fetchNotifications();
    }
  }, [token]);

  useEffect(() => {
    fetch(`${API_BASE}/branding`)
      .then((r) => r.json())
      .then((b: { name?: string; logoUrl?: string | null; faviconUrl?: string | null }) => {
        if (b.name) {
          setEntityName(b.name);
          document.title = `${b.name} — ComunicaPA`;
        }
        // logo/favicon possono essere path relativi al backend o URL esterni assoluti
        if (b.logoUrl) {
          setBrandLogoUrl(/^https?:\/\//i.test(b.logoUrl) ? b.logoUrl : `${API_BASE}${b.logoUrl}`);
        }
        if (b.faviconUrl) {
          const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']") ?? document.createElement('link');
          link.rel = 'icon';
          link.href = /^https?:\/\//i.test(b.faviconUrl) ? b.faviconUrl : `${API_BASE}${b.faviconUrl}`;
          document.head.appendChild(link);
        }
      })
      .catch(() => { /* branding default */ });

    fetch(`${API_BASE}/citizen/auth/config`)
      .then((r) => r.json())
      .then((c: { mode?: 'oidc' | 'mock'; logoutUrl?: string | null }) => {
        setAuthMode(c.mode === 'mock' ? 'mock' : 'oidc');
        setOidcLogoutUrl(c.logoutUrl ?? null);
      })
      .catch(() => setAuthMode('oidc'));

    fetch(`${API_BASE}/version`)
      .then((r) => r.json())
      .then((v: { version?: string }) => setAppVersion(v.version ?? null))
      .catch(() => { /* versione non disponibile */ });
  }, []);

  // Callback OIDC: il proxy riporta il browser su /oidc/callback?code&state
  useEffect(() => {
    if (window.location.pathname !== '/oidc/callback') return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const oidcError = params.get('error');
    window.history.replaceState({}, '', '/');

    if (oidcError || !code || !state) {
      setLoginError(oidcError ? `Accesso negato dal provider: ${oidcError}` : 'Risposta OIDC incompleta');
      setOidcExchanging(false);
      return;
    }

    fetch(`${API_BASE}/citizen/auth/oidc/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const err = (await r.json().catch(() => ({}))) as { message?: string };
          throw new Error(err.message ?? 'Scambio del codice OIDC fallito');
        }
        return r.json() as Promise<{
          access_token: string;
          claims?: { cf: string; name: string; provider: string };
        }>;
      })
      .then((d) => {
        const claims = d.claims || decodeJwtClaims(d.access_token);
        localStorage.setItem('comunicapa_citizen_token', d.access_token);
        localStorage.setItem('comunicapa_citizen_cf', claims.cf);
        localStorage.setItem('comunicapa_citizen_name', claims.name);
        localStorage.setItem('comunicapa_citizen_provider', claims.provider || 'Identità Digitale');
        setToken(d.access_token);
        setCf(claims.cf);
        setName(claims.name);
        setProvider(claims.provider || 'Identità Digitale');
      })
      .catch((e: Error) => setLoginError(e.message))
      .finally(() => setOidcExchanging(false));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const notifId = params.get('notificationId');
    if (notifId && notifications.length > 0) {
      const found = notifications.find(n => n.id === notifId);
      if (found) {
        setSelectedNotif(found);
        return;
      }
    }
    if (selectedNotif) {
      const updated = notifications.find(n => n.id === selectedNotif.id);
      if (updated && JSON.stringify(updated) !== JSON.stringify(selectedNotif)) {
        setSelectedNotif(updated);
      }
    }
  }, [notifications]);

  // Carica i documenti legali SEND quando si apre una notifica SEND con IUN
  useEffect(() => {
    if (!selectedNotif || selectedNotif.channelType !== 'SEND' || !selectedNotif.iun || !token) {
      setSendLegalFacts([]);
      return;
    }
    fetch(`${API_BASE}/citizen/notifications/${selectedNotif.id}/send-legal-facts`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : [])
      .then((data: Array<{ legalFactId: string; category: string }>) => setSendLegalFacts(data))
      .catch(() => setSendLegalFacts([]));
  }, [selectedNotif?.id, selectedNotif?.channelType]);

  const handleLogout = (clientSideOnly = false) => {
    const currentToken = token;
    localStorage.removeItem('comunicapa_citizen_token');
    localStorage.removeItem('comunicapa_citizen_cf');
    localStorage.removeItem('comunicapa_citizen_name');
    localStorage.removeItem('comunicapa_citizen_provider');
    setToken(null);
    setCf(null);
    setName(null);
    setProvider('Identità Digitale');
    setSelectedNotif(null);

    if (clientSideOnly) {
      window.location.href = '/';
      return;
    }

    // Termina anche la sessione SPID/CIE sul proxy, se configurato
    if (authMode === 'oidc' && oidcLogoutUrl) {
      const returnUrl = window.location.origin;
      let targetUrl = oidcLogoutUrl;
      try {
        const logoutUrlObj = new URL(oidcLogoutUrl);
        logoutUrlObj.searchParams.set('post_logout_redirect_uri', returnUrl);
        if (currentToken) {
          logoutUrlObj.searchParams.set('id_token_hint', currentToken);
        }
        targetUrl = logoutUrlObj.toString();
      } catch (e) {
        const separator = oidcLogoutUrl.includes('?') ? '&' : '?';
        targetUrl = `${oidcLogoutUrl}${separator}post_logout_redirect_uri=${encodeURIComponent(returnUrl)}`;
        if (currentToken) {
          targetUrl += `&id_token_hint=${encodeURIComponent(currentToken)}`;
        }
      }
      window.location.href = targetUrl;
    }
  };

  const fetchNotifications = async () => {
    setLoadingNotifications(true);
    setErrorNotifications(null);
    try {
      const res = await fetch(`${API_BASE}/citizen/notifications`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.status === 401) {
        handleLogout(true);
        return;
      }
      if (!res.ok) throw new Error('Impossibile caricare le comunicazioni');
      const data = await res.json();
      setNotifications(data);
    } catch (err: any) {
      setErrorNotifications(err.message);
    } finally {
      setLoadingNotifications(false);
    }
  };

  const handleSpidLogin = async (provider: string) => {
    setLoginLoading(true);
    setLoginError(null);
    
    // Determine which CF and Name to use
    let targetCf = selectedCf;
    let targetName = 'Cittadino Simulato';
    let targetEmail = 'cittadino@example.com';

    if (selectedCf === 'custom') {
      if (!customCf) {
        setLoginError('Inserisci un Codice Fiscale valido');
        setLoginLoading(false);
        return;
      }
      targetCf = customCf;
      targetName = customName || 'Cittadino Personalizzato';
    } else {
      const found = testCitizens.find(c => c.cf === selectedCf);
      if (found) {
        targetCf = found.cf;
        targetName = found.name;
        targetEmail = found.email;
      }
    }

    try {
      const res = await fetch(`${API_BASE}/citizen/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codiceFiscale: targetCf,
          name: targetName,
          email: targetEmail,
        }),
      });

      if (!res.ok) throw new Error('Autenticazione federata fallita');
      const data = await res.json();
      
      localStorage.setItem('comunicapa_citizen_token', data.access_token);
      localStorage.setItem('comunicapa_citizen_cf', targetCf.toUpperCase());
      localStorage.setItem('comunicapa_citizen_name', targetName);
      localStorage.setItem('comunicapa_citizen_provider', provider.toUpperCase());
      
      setToken(data.access_token);
      setCf(targetCf.toUpperCase());
      setName(targetName);
      setProvider(provider.toUpperCase());
      setSelectedNotif(null);
    } catch (err: any) {
      setLoginError(err.message || 'Errore durante la simulazione SPID/CIE');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleOidcLogin = () => {
    setLoginError(null);
    window.location.href = `${API_BASE}/citizen/auth/oidc/start`;
  };

  const handleDownloadAttachment = async (notifId: string, attachmentIndex: number) => {
    try {
      const res = await fetch(`${API_BASE}/citizen/notifications/${notifId}/attachment/${attachmentIndex}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.status === 401) {
        handleLogout(true);
        return;
      }
      if (!res.ok) throw new Error('Download fallito.');

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `avviso_comune_${notifId.slice(0, 8)}_${attachmentIndex + 1}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      // Refresh list to show updated download count
      fetchNotifications();
      // Update selected notification details in panel
      if (selectedNotif && selectedNotif.id === notifId) {
        const updatedNotifRes = await fetch(`${API_BASE}/citizen/notifications/${notifId}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (updatedNotifRes.status === 401) {
          handleLogout(true);
          return;
        }
        if (updatedNotifRes.ok) {
          const updatedData = await updatedNotifRes.json();
          setSelectedNotif(updatedData);
        }
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  /**
   * Scarica un documento legale (attestazione) dalla piattaforma SEND.
   * Cerca prima il legalFact per categoria fra quelli caricati; se assente scarica il primo disponibile.
   */
  const handleDownloadSendDocument = async (notifId: string, iun: string, category?: string) => {
    try {
      const facts = sendLegalFacts.length > 0 ? sendLegalFacts : [];
      const fact = category ? facts.find(f => f.category === category) ?? facts[0] : facts[0];
      if (!fact) {
        alert('Nessun documento legale disponibile dalla piattaforma SEND per questa notifica.');
        return;
      }
      const url = `${API_BASE}/citizen/notifications/${notifId}/send-document?iun=${encodeURIComponent(iun)}&legalFactId=${encodeURIComponent(fact.legalFactId)}`;
      const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.status === 401) { handleLogout(true); return; }
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: 'Download fallito.' }));
        throw new Error(body.message ?? 'Download fallito.');
      }
      const blob = await res.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = fact.legalFactId.split('/').pop() ?? `attestazione_${notifId.slice(0, 8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch (err: any) {
      alert(err.message);
    }
  };

  // 1. Render SPID/CIE login lobby
  if (!token) {
    return (
      <div style={{ background: 'var(--bg-1, #f0f4f8)', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        {/* Slim bar istituzionale */}
        <div className="slim-header">
          <div className="container">
            <div className="left">
              <span><span className="gov-dot"></span>Sito ufficiale della Pubblica Amministrazione</span>
            </div>
            <div className="right">
              <span>Accesso con <strong>Identità Digitale</strong></span>
            </div>
          </div>
        </div>

        {/* Header istituzionale */}
        <header className="inst-header">
          <div className="container">
            <a className="inst-brand" href="/" onClick={(e) => e.preventDefault()}>
              {brandLogoUrl ? (
                <img src={brandLogoUrl} alt={entityName} className="stemma" style={{ width: 48, height: 'auto', flexShrink: 0 }} />
              ) : (
                <i className="fas fa-landmark stemma" style={{ fontSize: '2.4rem', color: 'var(--bi-navy)' }} aria-hidden="true"></i>
              )}
              <div>
                <div className="eyebrow">Ente</div>
                <div className="title">{entityName}</div>
                <div className="sub">ComunicaPA — Notifiche e comunicazioni istituzionali</div>
              </div>
            </a>
          </div>
        </header>

        <section className="hero flex-grow-1">
          <div className="container">
            <div className="hero-inner has-sidebar">
              <div className="hero-main">
                <div className="hero-eyebrow">
                  <span className="pill">Sportello digitale</span>
                  <span>Le comunicazioni dell'ente, in un solo posto</span>
                </div>

                <h1>Le tue comunicazioni ufficiali,<br />sempre a portata di mano.</h1>

                <p className="lead">
                  Avvisi TARI, accertamenti, sanzioni e ogni altra comunicazione del {entityName}:
                  qui trovi lo storico completo di ciò che l'ente ti ha inviato e puoi scaricare
                  gli atti in ogni momento.
                </p>

                <div className="hero-actions">
                  <div className="hero-cta" style={{ cursor: 'default' }}>
                    <div className="icon-wrap">
                      <i className="far fa-bell" aria-hidden="true"></i>
                    </div>
                    <div>
                      <div className="title">Notifiche e avvisi</div>
                      <div className="desc">Tutte le comunicazioni inviate al tuo codice fiscale, su qualunque canale.</div>
                    </div>
                  </div>
                  <div className="hero-cta" style={{ cursor: 'default' }}>
                    <div className="icon-wrap">
                      <i className="far fa-file-pdf" aria-hidden="true"></i>
                    </div>
                    <div>
                      <div className="title">Atti e allegati</div>
                      <div className="desc">Scarica i documenti ufficiali in PDF, anche dopo la scadenza dell'avviso.</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="hero-sidebar">
                <div className="login-card">
                  <div className="login-card-head">
                    <div className="eyebrow">
                      <i className="fas fa-shield-halved" aria-hidden="true"></i>
                      Area riservata
                    </div>
                    <h2>Entra con la tua identità digitale</h2>
                    <p>Riservato ai destinatari delle comunicazioni del {entityName}.</p>
                  </div>
                  <div className="login-card-body">

              {loginError && (
                <div className="alert alert-danger p-2 text-center small" role="alert">
                  <i className="fas fa-exclamation-circle me-1"></i> {loginError}
                </div>
              )}

              {(oidcExchanging || authMode === null) && (
                <div className="text-center py-4">
                  <i className="fas fa-spinner fa-spin fa-2x text-primary mb-2"></i>
                  <div className="small text-muted">
                    {oidcExchanging ? 'Completamento accesso in corso…' : 'Caricamento…'}
                  </div>
                </div>
              )}

              {!oidcExchanging && authMode === 'oidc' && (
                <>
                  {/* La scelta SPID/CIE avviene sul proxy OIDC: qui un solo bottone */}
                  <button className="login-btn" onClick={handleOidcLogin}>
                    <i className="fas fa-user-shield" aria-hidden="true"></i>
                    Accedi con identità digitale
                  </button>
                </>
              )}

              {!oidcExchanging && authMode === 'mock' && (<>
              {/* Simulatore dev (solo LDAP_HOST=mock) */}
              <div className="p-3 bg-light rounded border mb-4">
                <h2 className="h6 fw-bold mb-3"><i className="fas fa-id-card text-primary me-2"></i>Seleziona un Profilo di Test</h2>
                
                <div className="mb-3">
                  {testCitizens.map((tc) => (
                    <div className="form-check mb-2" key={tc.cf}>
                      <input
                        className="form-check-input"
                        type="radio"
                        name="test_citizen"
                        id={`cf_${tc.cf}`}
                        value={tc.cf}
                        checked={selectedCf === tc.cf}
                        onChange={() => setSelectedCf(tc.cf)}
                      />
                      <label className="form-check-label" htmlFor={`cf_${tc.cf}`} style={{ cursor: 'pointer' }}>
                        <strong>{tc.name}</strong> <code className="ms-2">{tc.cf}</code>
                      </label>
                    </div>
                  ))}
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="radio"
                      name="test_citizen"
                      id="cf_custom"
                      value="custom"
                      checked={selectedCf === 'custom'}
                      onChange={() => setSelectedCf('custom')}
                    />
                    <label className="form-check-label" htmlFor={`cf_custom`} style={{ cursor: 'pointer' }}>
                      Inserisci Codice Fiscale personalizzato
                    </label>
                  </div>
                </div>

                {selectedCf === 'custom' && (
                  <div className="row g-2 mt-2">
                    <div className="col-sm-6">
                      <input
                        type="text"
                        className="form-control form-control-sm"
                        placeholder="Codice Fiscale (16 caratteri)"
                        value={customCf}
                        maxLength={16}
                        onChange={(e) => setCustomCf(e.target.value.toUpperCase())}
                      />
                    </div>
                    <div className="col-sm-6">
                      <input
                        type="text"
                        className="form-control form-control-sm"
                        placeholder="Nome e Cognome"
                        value={customName}
                        onChange={(e) => setCustomName(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Identity Providers Buttons (simulati) */}
              <div className="border-top pt-4">
                <h3 className="h6 text-muted fw-bold mb-3 text-center">SIMULA L'IDENTITÀ DIGITALE (SVILUPPO)</h3>
                <div className="row g-2 justify-content-center">
                  <div className="col-sm-6">
                    <button
                      className="btn btn-primary w-100 py-3 fw-bold d-flex align-items-center justify-content-center gap-2"
                      style={{ backgroundColor: '#0066cc', border: 'none', borderRadius: '4px' }}
                      onClick={() => handleSpidLogin('spid')}
                      disabled={loginLoading}
                    >
                      <span className="fw-black text-white" style={{ fontSize: '1.2rem', fontStyle: 'italic', letterSpacing: '-1px' }}>spid</span>
                      Entra con SPID
                    </button>
                  </div>
                  <div className="col-sm-6">
                    <button
                      className="btn btn-dark w-100 py-3 fw-bold d-flex align-items-center justify-content-center gap-2"
                      style={{ backgroundColor: '#1d232a', border: 'none', borderRadius: '4px' }}
                      onClick={() => handleSpidLogin('cie')}
                      disabled={loginLoading}
                    >
                      <i className="fas fa-id-badge text-warning" style={{ fontSize: '1.1rem' }}></i>
                      Entra con CIE
                    </button>
                  </div>
                </div>
              </div>
              </>)}
                  </div>
                  <div className="login-card-foot">
                    Il servizio è gratuito. Verrai reindirizzato al sistema di accesso
                    dell'ente per completare l'autenticazione in sicurezza.
                  </div>
                </div>
              </div>

              <div className="hero-trust-row">
                <div className="hero-trust">
                  <div>
                    <i className="fas fa-shield-halved" style={{ color: 'var(--ms-gold-300)' }} aria-hidden="true"></i>
                    Accesso sicuro con Identità Digitale
                  </div>
                  <div>
                    <i className="fas fa-stamp" style={{ color: 'var(--ms-gold-300)' }} aria-hidden="true"></i>
                    Documenti ufficiali dell'ente
                  </div>
                  <div>
                    <i className="fas fa-euro-sign" style={{ color: 'var(--ms-gold-300)' }} aria-hidden="true"></i>
                    Servizio gratuito
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <Footer entityName={entityName} logoUrl={brandLogoUrl} version={appVersion} />
      </div>
    );
  }

  // 2. Render Citizen Portal Dashboard
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      
      {/* Slim Header */}
      <div className="slim-header">
        <div className="container">
          <div className="left">
            <span className="gov-dot"></span>
            <span>{entityName}</span>
          </div>
          <div className="right">
            <span>Accesso certificato tramite <strong>Identità Digitale</strong></span>
          </div>
        </div>
      </div>

      {/* Institutional Brand Header */}
      <header className="inst-header">
        <div className="container">
          <a className="inst-brand" href="#" onClick={(e) => { e.preventDefault(); setSelectedNotif(null); }}>
            {brandLogoUrl ? (
              <img src={brandLogoUrl} alt={entityName} className="stemma" />
            ) : (
              <i className="fas fa-building stemma text-navy mb-0" style={{ fontSize: '2.4rem', color: 'var(--bi-navy)' }}></i>
            )}
            <div>
              <div className="eyebrow">Sportello Digitale</div>
              <div className="title">{entityName}</div>
              <div className="sub">ComunicaPA — Notifiche & Comunicazioni Istituzionali</div>
            </div>
          </a>

          {/* Badge utente (stile GovPay) */}
          <div className="inst-actions">
            <div className="fo-user-menu">
              <button
                type="button"
                className="fo-user-btn"
                aria-haspopup="true"
                aria-expanded={userMenuOpen}
                onClick={(e) => { e.stopPropagation(); setUserMenuOpen((o) => !o); }}
              >
                <span className="avatar">{(name || cf || '?').slice(0, 2).toUpperCase()}</span>
                <span className="d-none d-md-inline">{name || cf}</span>
                <i className="fas fa-chevron-down chev" aria-hidden="true"></i>
              </button>
              {userMenuOpen && (
                <div className="fo-user-dropdown">
                  <div className="cf-row">Codice fiscale<br /><code>{cf}</code></div>
                  <button type="button" onClick={() => { setActiveTab('profile'); setUserMenuOpen(false); }}>
                    <i className="far fa-user" aria-hidden="true"></i> Il mio profilo
                  </button>
                  <button type="button" className="danger" onClick={() => handleLogout()}>
                    <i className="fas fa-sign-out-alt" aria-hidden="true"></i> Esci
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Sticky Main Nav */}
      <nav className="main-nav">
        <div className="container align-items-center">
          <button
            className={`nav-item ${activeTab === 'notifications' ? 'active' : ''}`}
            onClick={() => { setActiveTab('notifications'); setSelectedNotif(null); }}
          >
            <i className="far fa-bell"></i> Le mie Notifiche
          </button>
          <button
            className={`nav-item ${activeTab === 'profile' ? 'active' : ''}`}
            onClick={() => setActiveTab('profile')}
          >
            <i className="far fa-user"></i> Il mio Profilo
          </button>
          <div className="spacer"></div>
        </div>
      </nav>

      {/* Content Main */}
      <main className="container py-4" style={{ backgroundColor: 'var(--bg-1)' }}>
        
        {activeTab === 'notifications' && (
          <div className={`webmail-layout ${selectedNotif ? 'has-detail' : ''}`}>

            {/* List Pane (Left Column) */}
            <div className="webmail-list-pane">
              
              {/* List Header: Search Bar & Refresh Button */}
              <div className="webmail-list-title-bar">
                <div className="search-bar-wrap" style={{ flex: 1 }}>
                  <div className="search-input-container">
                    <i className="fas fa-search search-icon" aria-hidden="true"></i>
                    <input
                      type="text"
                      className="input search-input"
                      placeholder="Cerca comunicazioni..."
                      value={searchText}
                      onChange={(e) => setSearchText(e.target.value)}
                    />
                    <button
                      type="button"
                      className={`btn-filter-toggle ${hasActiveFilters ? 'active' : ''}`}
                      onClick={() => setShowAdvancedFilters((o) => !o)}
                      title="Filtri avanzati"
                    >
                      <i className="fas fa-sliders-h" aria-hidden="true"></i>
                    </button>
                  </div>

                  {/* Advanced Filters Popover */}
                  {showAdvancedFilters && (
                    <div className="advanced-filters-popover card">
                      <div className="card-pad vstack" style={{ gap: 'var(--sp-3)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <strong style={{ fontSize: '13px', color: 'var(--bi-navy)' }}>Filtri Avanzati</strong>
                          {hasActiveFilters && (
                            <button type="button" className="btn-link-reset" onClick={resetFilters} style={{ background: 'none', border: 'none', color: 'var(--bi-primary)', fontSize: '12px', cursor: 'pointer', fontWeight: 600 }}>
                              Azzera filtri
                            </button>
                          )}
                        </div>

                        <div className="field">
                          <label htmlFor="search-status">Stato</label>
                          <select
                            id="search-status"
                            className="select select-sm"
                            value={filterStatus}
                            onChange={(e) => setFilterStatus(e.target.value as 'all' | 'sent' | 'pending' | 'failed')}
                          >
                            <option value="all">Tutti gli stati</option>
                            <option value="sent">Ricevuta / Scaricato</option>
                            <option value="pending">In corso</option>
                            <option value="failed">Non recapitata</option>
                          </select>
                        </div>

                        <div className="field">
                          <label htmlFor="search-channel">Canale</label>
                          <select
                            id="search-channel"
                            className="select select-sm"
                            value={filterChannel}
                            onChange={(e) => setFilterChannel(e.target.value)}
                          >
                            <option value="all">Tutti i canali</option>
                            {availableChannels.map((c) => (
                              <option key={c} value={c}>{CHANNEL_META[c]?.label ?? c}</option>
                            ))}
                          </select>
                        </div>

                        <div className="field">
                          <label htmlFor="search-date-from">Dal</label>
                          <input
                            id="search-date-from"
                            type="date"
                            className="input input-sm"
                            value={filterDateFrom}
                            onChange={(e) => setFilterDateFrom(e.target.value)}
                          />
                        </div>

                        <div className="field">
                          <label htmlFor="search-date-to">Al</label>
                          <input
                            id="search-date-to"
                            type="date"
                            className="input input-sm"
                            value={filterDateTo}
                            onChange={(e) => setFilterDateTo(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={fetchNotifications}
                  title="Aggiorna elenco"
                  style={{ padding: '8px', marginLeft: 8 }}
                >
                  <i className="fas fa-sync-alt" aria-hidden="true"></i>
                </button>
              </div>

              {/* List Scroll Container */}
              <div className="webmail-list-scroll">
                {errorNotifications && (
                  <div className="alert alert-danger" style={{ margin: 'var(--sp-3)' }}>
                    <i className="fas fa-exclamation-triangle alert-icon" aria-hidden="true"></i>
                    <span>{errorNotifications}</span>
                  </div>
                )}

                {loadingNotifications && notifications.length === 0 ? (
                  <div className="notif-empty">
                    <i className="fas fa-spinner fa-spin" aria-hidden="true" style={{ fontSize: '1.2rem', marginBottom: 'var(--sp-2)' }}></i>
                    <div>Caricamento...</div>
                  </div>
                ) : notifications.length === 0 ? (
                  <div className="notif-empty">
                    <i className="far fa-folder-open" aria-hidden="true" style={{ fontSize: '1.5rem', marginBottom: 'var(--sp-2)', color: 'var(--border-2)' }}></i>
                    <p style={{ margin: 0 }}>Nessuna comunicazione.</p>
                  </div>
                ) : filteredNotifications.length === 0 ? (
                  <div className="notif-empty">
                    <i className="fas fa-filter" aria-hidden="true" style={{ fontSize: '1.5rem', marginBottom: 'var(--sp-2)', color: 'var(--border-2)' }}></i>
                    <p style={{ margin: '0 0 var(--sp-2)' }}>Nessun risultato.</p>
                    <button type="button" className="btn btn-outline btn-xs" onClick={resetFilters}>Azzera filtri</button>
                  </div>
                ) : (
                  <div className="notif-list">
                    {filteredNotifications.map((n) => {
                      const isDownloaded = !!n.extraData?.['download_count'];
                      const badge = statusBadge(n.status);
                      const snippet = getTextSnippet(n.bodyHtml || n.bodyMarkdown || '');
                      return (
                        <button
                          key={n.id}
                          className={`notif-list-item ${selectedNotif?.id === n.id ? 'selected' : ''}`}
                          onClick={() => setSelectedNotif(n)}
                        >
                          <div className="notif-list-item-top">
                            <span className="notif-sender">Comune di Montesilvano</span>
                            <span className="notif-date">
                              {new Date(n.createdAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                            </span>
                          </div>
                          <h4 className="notif-list-item-title">{n.subject || '—'}</h4>
                          {snippet && <div className="notif-list-item-desc">{snippet}</div>}
                          <div className="notif-list-item-meta">
                            <ChannelBadge channel={n.channelType} />
                            <div style={{ display: 'flex', gap: 'var(--sp-1)' }}>
                              <span className={`status ${badge.cls}`} title={badge.label}>
                                <span className="dot"></span>{badge.label}
                              </span>
                              {isDownloaded && (
                                <span className="status status-notif-received" title="Scaricato">
                                  <span className="dot" style={{ backgroundColor: 'var(--ms-info)' }}></span>Scaricato
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Detail Pane (Right Column) */}
            <div className="webmail-detail-pane">
              {selectedNotif ? (() => {
                const physicalAddress = findPhysicalAddress(selectedNotif.extraData);
                const isAnalogOrLegal = selectedNotif.channelType === 'POSTAL' || selectedNotif.channelType === 'SEND';
                return (
                  <div className="webmail-detail-container" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    
                    {/* Detail Header: Subject & Back button */}
                    <div className="webmail-detail-header">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm notif-back-btn"
                        onClick={() => setSelectedNotif(null)}
                      >
                        <i className="fas fa-arrow-left" aria-hidden="true" style={{ marginRight: 6 }}></i> Indietro
                      </button>
                      <div className="spacer"></div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm notif-close-btn"
                        onClick={() => setSelectedNotif(null)}
                        title="Chiudi messaggio"
                      >
                        <i className="fas fa-times" aria-hidden="true"></i>
                      </button>
                    </div>

                    {/* Detail Body Scroll area */}
                    <div className="webmail-detail-scroll">
                      <h2 className="webmail-subject">{selectedNotif.subject || '—'}</h2>

                      {selectedNotif.channelType === 'SEND' ? (
                        /* Modern Split Layout for SEND matching official portal */
                        <div className="send-detail-grid">
                          {/* Left Column: Metadata & Documents */}
                          <div className="send-left-column">
                            {/* Scheda di Spedizione Card */}
                            <div className="send-card">
                              <div className="send-card-header">
                                <i className="fas fa-file-invoice" aria-hidden="true" style={{ marginRight: 8, color: 'var(--bi-navy)' }}></i>
                                <strong>Dati di Spedizione Ufficiali</strong>
                              </div>
                              <div className="send-card-body">
                                <div className="send-meta-row">
                                  <span className="lbl">Mittente</span>
                                  <span className="val">Comune di Montesilvano</span>
                                </div>
                                <div className="send-meta-row">
                                  <span className="lbl">Destinatario</span>
                                  <span className="val">{selectedNotif.fullName || name}</span>
                                </div>
                                <div className="send-meta-row">
                                  <span className="lbl">Data di invio</span>
                                  <span className="val">{new Date(selectedNotif.createdAt).toLocaleDateString('it-IT')}</span>
                                </div>
                                {selectedNotif.iun && (
                                  <div className="send-meta-row">
                                    <span className="lbl">Codice IUN</span>
                                    <span className="val iun-code">{selectedNotif.iun}</span>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Informational Recommendation Box */}
                            <div className="send-banner-small">
                              <i className="fas fa-info-circle" aria-hidden="true" style={{ marginRight: 8, color: '#0066cc', fontSize: '1.1rem', marginTop: 1 }}></i>
                              <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: '1.4', color: '#4a5568' }}>
                                Questa comunicazione è stata notificata formalmente tramite la piattaforma nazionale <strong>SEND</strong>. Si raccomanda di accedere alla piattaforma ufficiale <a href="https://notifichedigitali.it/" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', color: '#0066cc', fontWeight: 600 }}>SEND (https://notifichedigitali.it/)</a> per scaricare ufficialmente la notifica ed i relativi atti con pieno valore legale.
                              </p>
                            </div>

                            {/* Documenti Allegati Card */}
                            {selectedNotif.attachments && selectedNotif.attachments.length > 0 && (
                              <div className="send-card">
                                <div className="send-card-header">
                                  <i className="fas fa-paperclip" aria-hidden="true" style={{ marginRight: 8, color: 'var(--bi-navy)' }}></i>
                                  <strong>Documenti allegati</strong>
                                </div>
                                <div className="send-card-body">
                                  <p className="send-card-note">I documenti sono disponibili online per 120 giorni dal perfezionamento della notifica.</p>
                                  {selectedNotif.attachments.map((att) => (
                                    <div key={att.index} className="send-attachment-link">
                                      <i className="fas fa-file-pdf" style={{ color: '#e53e3e', marginRight: 8 }}></i>
                                      <a
                                        href="#"
                                        onClick={(e) => { e.preventDefault(); handleDownloadAttachment(selectedNotif.id, att.index); }}
                                        className="send-att-link-btn"
                                      >
                                        {att.label}
                                      </a>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Avviso di Avvenuta Ricezione Card */}
                            <div className="send-card">
                              <div className="send-card-header">
                                <i className="fas fa-stamp" aria-hidden="true" style={{ marginRight: 8, color: 'var(--bi-navy)' }}></i>
                                <strong>Avviso di avvenuta ricezione</strong>
                              </div>
                              <div className="send-card-body">
                                <p className="send-card-note">L'avviso di avvenuta ricezione è disponibile online per 10 anni dal perfezionamento della notifica.</p>
                                <div className="send-attachment-link">
                                  <i className="fas fa-file-signature" style={{ color: '#4a5568', marginRight: 8 }}></i>
                                  <a
                                    href="#"
                                    onClick={(e) => { e.preventDefault(); handleDownloadSendDocument(selectedNotif.id, selectedNotif.iun!, 'ANALOG_DELIVERY_WORKFLOW'); }}
                                    className="send-att-link-btn"
                                  >
                                    Avviso di avvenuta ricezione
                                  </a>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Right Column: Timeline (Stato della Notifica) */}
                          <div className="send-right-column">
                            <h4 className="send-timeline-title">STATO DELLA NOTIFICA</h4>
                            {selectedNotif.sendStatusHistory && selectedNotif.sendStatusHistory.length > 0 ? (
                              <div className="send-timeline">
                                {selectedNotif.sendStatusHistory
                                  .slice()
                                  .reverse()
                                  .map((hist, index) => {
                                    const dateObj = new Date(hist.activeFrom);
                                    const timeStr = dateObj.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                                    const monthStr = dateObj.toLocaleDateString('it-IT', { month: 'short' }).toUpperCase().replace('.', '');
                                    const dayStr = dateObj.toLocaleDateString('it-IT', { day: 'numeric' });
                                    const meta = getSendStatusMeta(hist.status);
                                    return (
                                      <div key={index} className="timeline-item">
                                        <div className="timeline-date">
                                          <span className="day">{dayStr}</span>
                                          <span className="month">{monthStr}</span>
                                        </div>
                                        <div className="timeline-node-container">
                                          <div className="timeline-line"></div>
                                          <div className={`timeline-node ${hist.status === selectedNotif.sendStatus ? 'active' : ''}`}></div>
                                        </div>
                                        <div className="timeline-content">
                                          <div className="timeline-time">{timeStr}</div>
                                          <div className="timeline-badge-row">
                                            <span className={`timeline-badge ${meta.cls}`}>
                                              {meta.label}
                                            </span>
                                          </div>
                                          <div className="timeline-desc">{meta.desc}</div>
                                          {hist.status === 'VIEWED' && sendLegalFacts.length > 0 && (
                                            <div className="timeline-attestation">
                                              <i className="fas fa-paperclip" style={{ fontSize: '0.8rem', marginRight: 6, color: '#0066cc' }}></i>
                                              <a href="#" onClick={(e) => { e.preventDefault(); handleDownloadSendDocument(selectedNotif.id, selectedNotif.iun!, 'NOTIFICATION_VIEWED'); }} className="att-link">
                                                Attestazione opponibile a terzi: avvenuto accesso
                                              </a>
                                            </div>
                                          )}
                                          {hist.status === 'DELIVERED' && sendLegalFacts.length > 0 && (
                                            <div className="timeline-attestation">
                                              <i className="fas fa-paperclip" style={{ fontSize: '0.8rem', marginRight: 6, color: '#0066cc' }}></i>
                                              <a href="#" onClick={(e) => { e.preventDefault(); handleDownloadSendDocument(selectedNotif.id, selectedNotif.iun!, 'DIGITAL_DELIVERY'); }} className="att-link">
                                                Attestazione opponibile a terzi: notifica digitale
                                              </a>
                                            </div>
                                          )}
                                          {hist.status === 'ACCEPTED' && sendLegalFacts.length > 0 && (
                                            <div className="timeline-attestation">
                                              <i className="fas fa-paperclip" style={{ fontSize: '0.8rem', marginRight: 6, color: '#0066cc' }}></i>
                                              <a href="#" onClick={(e) => { e.preventDefault(); handleDownloadSendDocument(selectedNotif.id, selectedNotif.iun!, 'SENDER_ACK'); }} className="att-link">
                                                Attestazione opponibile a terzi: notifica presa in carico
                                              </a>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                              </div>
                            ) : (
                              <div className="send-timeline-empty">
                                <i className="fas fa-clock" style={{ fontSize: '1.5rem', color: '#cbd5e0', marginBottom: 8 }}></i>
                                <p>Stato non ancora sincronizzato con la piattaforma SEND.</p>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        /* Standard Layout for POSTAL, EMAIL, PEC, APP_IO */
                        <>
                          {isAnalogOrLegal ? (
                            /* Formal Notification Sheet for POSTAL */
                            <div className="webmail-notification-sheet">
                              <div className="sheet-header">
                                <i className="fas fa-file-invoice" aria-hidden="true" style={{ color: 'var(--bi-navy)', marginRight: 8 }}></i>
                                <strong>Scheda di Spedizione Ufficiale</strong>
                              </div>
                              <div className="sheet-body">
                                <div className="sheet-row">
                                  <span className="lbl">Mittente:</span>
                                  <span className="val"><strong>{entityName}</strong></span>
                                </div>
                                <div className="sheet-row">
                                  <span className="lbl">Destinatario:</span>
                                  <span className="val">{selectedNotif.fullName || name} (Codice Fiscale: <code className="ms-mono">{selectedNotif.codiceFiscale || cf}</code>)</span>
                                </div>
                                {physicalAddress && (
                                  <div className="sheet-row">
                                    <span className="lbl">Indirizzo di recapito:</span>
                                    <span className="val">{physicalAddress}</span>
                                  </div>
                                )}
                                <div className="sheet-row">
                                  <span className="lbl">Data Spedizione:</span>
                                  <span className="val">{new Date(selectedNotif.createdAt).toLocaleString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                </div>
                                <div className="sheet-row">
                                  <span className="lbl">Canale di invio:</span>
                                  <span className="val"><ChannelBadge channel={selectedNotif.channelType} /></span>
                                </div>
                              </div>
                            </div>
                          ) : (
                            /* Email Headers Card for EMAIL / PEC / APP_IO */
                            <div className="webmail-envelope-meta">
                              <div className="envelope-avatar">
                                <i className={selectedNotif.channelType === 'APP_IO' ? 'fas fa-mobile-alt' : 'fas fa-envelope'} aria-hidden="true"></i>
                              </div>
                              <div className="envelope-fields">
                                <div className="field-row">
                                  <span className="label">Da:</span>
                                  <span className="val"><strong>{entityName}</strong></span>
                                </div>
                                <div className="field-row">
                                  <span className="label">A:</span>
                                  <span className="val">
                                    {selectedNotif.fullName || name}
                                    {(selectedNotif.email || selectedNotif.pec) && ` <${selectedNotif.email || selectedNotif.pec}>`}
                                    {` (Codice Fiscale: `}
                                    <code className="ms-mono">{selectedNotif.codiceFiscale || cf}</code>
                                    {`)`}
                                  </span>
                                </div>
                                <div className="field-row">
                                  <span className="label">Data:</span>
                                  <span className="val">{new Date(selectedNotif.createdAt).toLocaleString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                </div>
                                <div className="field-row">
                                  <span className="label">Canale:</span>
                                  <span className="val"><ChannelBadge channel={selectedNotif.channelType} /></span>
                                </div>
                              </div>
                            </div>
                          )}

                          {isAnalogOrLegal ? (
                            /* Informational notice for POSTAL / SEND */
                            <div className="webmail-info-banner">
                              <i className="fas fa-info-circle info-icon" aria-hidden="true" style={{ marginRight: 8 }}></i>
                              <div className="info-text">
                                {selectedNotif.channelType === 'SEND' ? (
                                  <p style={{ margin: 0 }}>
                                    Questa comunicazione è stata notificata formalmente tramite la piattaforma nazionale <strong>SEND (Piattaforma Notifiche Digitali)</strong> di pagoPA.
                                    Si raccomanda di accedere alla piattaforma ufficiale <a href="https://notifichedigitali.it/" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', color: 'inherit', fontWeight: 600 }}>SEND (https://notifichedigitali.it/)</a> per scaricare ufficialmente la notifica ed i relativi atti con pieno valore legale. I file ed allegati di cortesia sono comunque disponibili per il download anche tramite la sezione sottostante.
                                  </p>
                                ) : (
                                  <p style={{ margin: 0 }}>
                                    Questa comunicazione è stata spedita in formato cartaceo all'indirizzo fisico registrato del destinatario.
                                    La copia informatica conforme del documento e gli allegati associati sono scaricabili tramite la sezione sottostante.
                                  </p>
                                )}
                              </div>
                            </div>
                          ) : (
                            /* Message Body Content Card for EMAIL / PEC / APP_IO */
                            <div className="webmail-body-card">
                              {selectedNotif.bodyHtml ? (
                                <div
                                  className="webmail-body-content"
                                  dangerouslySetInnerHTML={{ __html: selectedNotif.bodyHtml }}
                                />
                              ) : (
                                <div
                                  className="webmail-body-content"
                                  dangerouslySetInnerHTML={{ __html: renderAppIoMarkdown(selectedNotif.bodyMarkdown || '') }}
                                />
                              )}
                            </div>
                          )}

                          {/* Metadata summary (State and downloads) */}
                          <div className="webmail-detail-status-bar">
                            <div className="status-item">
                              <span className="lbl">Stato Spedizione:</span>
                              <span className={`status ${statusBadge(selectedNotif.status).cls}`}>
                                <span className="dot"></span>{statusBadge(selectedNotif.status).label}
                              </span>
                            </div>
                            {!!selectedNotif.extraData?.['download_count'] && (
                              <div className="status-item">
                                <span className="lbl">Download:</span>
                                <span>
                                  Scaricato {selectedNotif.extraData['download_count']} volte (ultimo il{' '}
                                  {new Date(selectedNotif.extraData['downloaded_at']).toLocaleString('it-IT')})
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Attachments Section */}
                          {selectedNotif.attachments && selectedNotif.attachments.length > 0 && (
                            <div className="webmail-attachments-section">
                              <h4 className="attachments-title">
                                <i className="fas fa-paperclip" aria-hidden="true" style={{ marginRight: 6 }}></i>
                                Allegati ({selectedNotif.attachments.length})
                              </h4>
                              <div className="attachments-grid">
                                {selectedNotif.attachments.map((att) => (
                                  <div className="attachment-tile" key={att.index}>
                                    <div className="tile-icon">
                                      <i className="fas fa-file-pdf text-danger" aria-hidden="true"></i>
                                    </div>
                                    <div className="tile-info">
                                      <span className="tile-name" title={att.label}>{att.label}</span>
                                      <span className="tile-size">Allegato {att.index + 1}</span>
                                    </div>
                                    <button
                                      type="button"
                                      className="btn btn-primary btn-sm tile-btn"
                                      onClick={() => handleDownloadAttachment(selectedNotif.id, att.index)}
                                    >
                                      <i className="fas fa-download" aria-hidden="true"></i> Scarica
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      )}

                    </div>
                  </div>
                );
              })() : (
                /* Empty state / placeholder when no communication is selected */
                <div className="webmail-placeholder">
                  <div className="placeholder-content">
                    <div className="placeholder-icon-circle">
                      <i className="far fa-envelope-open" aria-hidden="true"></i>
                    </div>
                    <h3>Seleziona una comunicazione</h3>
                    <p>Scegli una voce dall'elenco a sinistra per visualizzarne i dettagli, leggere il contenuto e scaricare gli allegati ufficiali.</p>
                  </div>
                </div>
              )}
            </div>

          </div>
        )}

        {activeTab === 'profile' && (
          <div className="card card-pad" style={{ maxWidth: 600, margin: '0 auto' }}>
            <h3 className="ms-h3" style={{ marginBottom: 'var(--sp-5)' }}>
              <i className="far fa-user" style={{ color: 'var(--bi-primary)', marginRight: 8 }} aria-hidden="true"></i>
              Profilo Cittadino Certificato
            </h3>

            <div style={{ textAlign: 'center', marginBottom: 'var(--sp-5)' }}>
              <span className="user-initials-avatar">{name?.slice(0, 2).toUpperCase()}</span>
              <h4 className="ms-h3" style={{ marginTop: 'var(--sp-3)', marginBottom: 'var(--sp-2)' }}>{name}</h4>
              <span className="status status-notif-received">
                <span className="dot"></span>Identità Certificata via {provider}
              </span>
            </div>

            <div className="avviso-row">
              <span className="k">Codice Fiscale</span>
              <span className="v ms-mono">{cf}</span>
            </div>
            <div className="avviso-row">
              <span className="k">Metodo di accesso</span>
              <span className="v">{authMode === 'mock' ? 'Simulatore (sviluppo)' : `${provider} (OIDC)`}</span>
            </div>

            <p className="ms-small" style={{ textAlign: 'center', marginTop: 'var(--sp-5)' }}>
              Questa è un'area ad alto livello di sicurezza. Le sessioni scadono automaticamente dopo 8 ore.
            </p>
          </div>
        )}

      </main>

      <Footer entityName={entityName} logoUrl={brandLogoUrl} version={appVersion} />
    </div>
  );
}
