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

const EMBEDDED_LOGOS = {
  APP_IO: `data:image/svg+xml;utf8,<svg width="57" height="55" viewBox="0 0 57 55" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M9.80308 7.16724C12.5938 7.16724 14.8562 9.44308 14.8562 12.2505C14.8562 15.0579 12.5938 17.3337 9.80308 17.3337C7.01234 17.3337 4.75 15.0579 4.75 12.2505C4.75 9.44308 7.01234 7.16724 9.80308 7.16724ZM52.25 31.5664C52.25 40.5501 45.0105 47.8328 36.8501 47.8328C27.1498 47.8328 19.9103 40.5501 19.9103 31.5664C19.9103 22.5828 27.1498 15.3001 36.8501 15.3001C45.0105 15.3001 52.25 22.5828 52.25 31.5664ZM13.8477 26.4827C13.8477 24.2367 12.0378 22.4161 9.80521 22.4161C7.57262 22.4161 5.76275 24.2367 5.76275 26.4827V43.7657C5.76275 46.0116 7.57262 47.8323 9.80521 47.8323C12.0378 47.8323 13.8477 46.0116 13.8477 43.7657V26.4827ZM40.0533 29.8593H42.206V27.7284H40.0688V25.1515H37.7303V33.7246C37.7303 35.0791 37.9161 36.0042 38.3033 36.4997C38.675 37.0118 39.3874 37.2596 40.4405 37.2596C40.8432 37.2596 41.4472 37.1605 42.2215 36.9788L42.1131 34.9965L40.7812 35.0296C40.5489 35.0296 40.3786 34.98 40.2702 34.8644C40.1617 34.7488 40.0998 34.6166 40.0843 34.4679C40.0688 34.3028 40.0533 34.055 40.0533 33.6751V29.8593ZM33.0028 27.7441V37.0441H35.3414V27.7441H33.0028ZM29.497 27.5138C29.9057 27.5138 30.2516 27.6522 30.5188 27.9292C30.7861 28.2062 30.9118 28.5447 30.9118 28.9601C30.9118 29.3756 30.7861 29.6987 30.5188 29.9757C30.2673 30.2219 29.9371 30.3604 29.5127 30.3604C29.1039 30.3604 28.7581 30.2219 28.4908 29.9449C28.2236 29.6679 28.0821 29.3294 28.0821 28.9294C28.0821 28.5293 28.2236 28.1908 28.4751 27.9138C28.7424 27.6368 29.0882 27.5138 29.497 27.5138Z" fill="%230B3EE3"/></svg>`,
  SEND: `data:image/svg+xml;utf8,<svg width="75" height="25" viewBox="0 0 75 25" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.50075 9.08271C9.44153 9.1593 10.4607 9.24226 11.4508 9.54981C13.94 10.3239 15.4339 12.2719 15.4339 15.025C15.4339 18.8653 12.5848 21.6748 8.24258 21.6748C4.0663 21.6748 0.968262 19.038 0.968262 15.1392H4.26298C4.26298 17.0886 5.97799 18.3781 8.30116 18.3781C10.7073 18.3781 12.1455 17.0323 12.1455 15.2253C12.1455 13.964 11.3992 13.1906 10.4305 12.8176C9.70934 12.5389 8.79293 12.4553 7.8291 12.3673C6.90802 12.2833 5.94364 12.1952 5.06503 11.9293C2.52077 11.1552 1.13774 9.11974 1.13774 6.54006C1.13774 2.84292 3.98679 0.120117 8.10797 0.120117C12.1455 0.120117 15.1326 2.67089 15.1326 6.36875H11.8142C11.7305 4.59138 10.2373 3.4161 8.08008 3.4161C5.86361 3.4161 4.45338 4.7063 4.45338 6.36875C4.45338 7.45802 5.06155 8.28924 6.11259 8.6904C6.7422 8.94219 7.60196 9.00954 8.50075 9.08271ZM57.6312 0.435267H64.1307C69.9941 0.435267 74.2261 4.99254 74.2261 10.926C74.2261 16.8595 69.9941 21.3597 64.1307 21.3597H62.6507V24.7128L57.8042 19.6828L62.6507 14.6571V18.0059H64.0756C68.058 18.0059 70.907 14.939 70.907 10.926C70.907 6.85593 68.058 3.78908 64.0756 3.78908H60.9496V11.0605L57.6312 14.5415V0.435267ZM18.8897 21.3597H34.2955V18.0059H22.1816V12.5307H29.0124V9.17757H22.1816V3.78835H34.2955V0.435267H18.8897V21.3597ZM41.2923 0.435267L50.668 15.3402V0.435267H53.9592V21.3597H50.668L41.2923 6.45477V21.3597H38.0003V0.435267H41.2923Z" fill="%23003366"/></svg>`,
  INAD: `data:image/svg+xml;utf8,<svg width="45" height="44" viewBox="0 0 45 44" xmlns="http://www.w3.org/2000/svg"><g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd"><g transform="translate(-123, -2173)"><g transform="translate(124.5, 2173.5)"><rect fill="%2317324D" x="14.66" y="30.96" width="2.22" height="12"/><rect fill="%2317324D" x="19.2" y="30.96" width="4.44" height="12"/><path d="M7.83,9.88 L32.95,9.88 C37.85,9.88 41.83,13.86 41.83,18.77 L41.83,32.1 L7.83,32.1 Z" stroke="%23FFFFFF" stroke-width="2.2" fill="%2317324D"/><path d="M9,9.88 C13.97,9.88 18,13.91 18,18.88 L18,32.1 L0,32.1 L0,18.88 C0,13.91 4.02,9.88 9,9.88 Z" stroke="%23FFFFFF" stroke-width="2.2" fill="%2317324D"/><path d="M5,19.52 L13,19.52" stroke="%23FFFFFF" stroke-width="2.2"/><rect fill="%2317324D" x="24.2" y="5.44" width="3" height="16.29"/><rect fill="%23FFFFFF" x="27.2" y="4.76" width="2.2" height="18"/><path d="M24.2,0.23 L29.2,0.23 C30.85,0.23 32.2,1.58 32.2,3.23 C32.2,4.89 30.85,6.23 29.2,6.23 L24.2,6.23 Z" fill="%2317324D"/></g></g></g></svg>`,
};

const CHANNEL_META: Record<string, { label: string; icon: string; cls: string; logo?: string }> = {
  PEC: { label: 'PEC', icon: 'fa-envelope-open-text', cls: 'channel-pec' },
  EMAIL: { label: 'E-Mail', icon: 'fa-envelope', cls: 'channel-email' },
  APP_IO: { label: 'App IO', icon: 'fa-mobile-screen', cls: 'channel-appio', logo: EMBEDDED_LOGOS.APP_IO },
  SEND: { label: 'SEND', icon: 'fa-paper-plane', cls: 'channel-send', logo: EMBEDDED_LOGOS.SEND },
  POSTAL: { label: 'Postalizzazione', icon: 'fa-envelope-circle-check', cls: 'channel-postal' },
  INAD: { label: 'INAD', icon: 'fa-id-card', cls: 'channel-inad', logo: EMBEDDED_LOGOS.INAD },
  CITIZEN_PORTAL: { label: 'Portale Cittadino', icon: 'fa-globe', cls: 'channel-portal' },
};

function ChannelBadge({ channel }: { channel: string }): React.JSX.Element {
  const normKey = (channel || '').toUpperCase();
  const meta = CHANNEL_META[normKey] ?? { label: channel || '—', icon: 'fa-paper-plane', cls: 'channel-generic' };
  
  if (meta.logo) {
    return (
      <span className={`channel-badge ${meta.cls}`}>
        <span className="f-partner-chip" style={{ height: 18, minWidth: 18, borderRadius: 4, marginRight: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', padding: '2px 5px' }}>
          <img src={meta.logo} alt="" style={{ height: 14, width: 'auto', maxHeight: 14, display: 'block', objectFit: 'contain' }} />
        </span>
        {meta.label}
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
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 10;

  const resetFilters = () => {
    setSearchText('');
    setFilterStatus('all');
    setFilterChannel('all');
    setFilterDateFrom('');
    setFilterDateTo('');
    setCurrentPage(1);
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

  const totalPages = Math.max(1, Math.ceil(filteredNotifications.length / PAGE_SIZE));
  const pagedNotifications = filteredNotifications.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

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

  // Reset pagina quando cambiano i filtri
  useEffect(() => { setCurrentPage(1); }, [searchText, filterStatus, filterChannel, filterDateFrom, filterDateTo]);

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
      window.open(url, '_blank');

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
      const filename = fact.legalFactId.split('/').pop() ?? `attestazione_${notifId.slice(0, 8)}.pdf`;
      const isPdf = /\.pdf$/i.test(filename);
      if (isPdf) {
        window.open(objectUrl, '_blank');
      } else {
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(objectUrl);
      }
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
                    {pagedNotifications.map((n) => {
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
              {/* Paginazione */}
              {totalPages > 1 && (
                <div className="notif-pagination">
                  <button
                    className="pag-btn"
                    disabled={currentPage === 1}
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    aria-label="Pagina precedente"
                  >
                    <i className="fas fa-chevron-left" aria-hidden="true"></i>
                  </button>
                  <span className="pag-info">{currentPage} / {totalPages}</span>
                  <button
                    className="pag-btn"
                    disabled={currentPage === totalPages}
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    aria-label="Pagina successiva"
                  >
                    <i className="fas fa-chevron-right" aria-hidden="true"></i>
                  </button>
                </div>
              )}
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
