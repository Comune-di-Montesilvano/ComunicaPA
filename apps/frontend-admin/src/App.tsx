import React, { useState, useEffect, useRef } from 'react';
import MDEditor from '@uiw/react-md-editor';
import { TemplateEditor } from './components/TemplateEditor';
import { SEND_ENTITY_TYPES, SEND_TAXONOMY_CATALOG } from './data/sendTaxonomy';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';

declare global {
  interface Window {
    __COMUNICAPA_CONFIG__?: { apiBase?: string };
  }
}

const API_BASE = window.__COMUNICAPA_CONFIG__?.apiBase ?? 'http://localhost:8080';
const ADMIN_API_BASE = `${API_BASE}/admin`;

const CHANNEL_META: Record<string, { label: string; icon: string; badge: string }> = {
  PEC: { label: 'PEC', icon: 'fa-envelope-open-text', badge: 'bg-info' },
  EMAIL: { label: 'Email', icon: 'fa-envelope', badge: 'bg-success' },
  APP_IO: { label: 'AppIO', icon: 'fa-mobile-screen', badge: 'bg-primary' },
  SEND: { label: 'SEND', icon: 'fa-paper-plane', badge: 'bg-warning text-dark' },
  POSTAL: { label: 'Postalizzazione', icon: 'fa-envelope-circle-check', badge: 'bg-secondary' },
  CITIZEN_PORTAL: { label: 'Portale Cittadino', icon: 'fa-globe', badge: 'bg-dark' },
  UNKNOWN: { label: 'Sconosciuto', icon: 'fa-question', badge: 'bg-secondary' },
};

function channelLabel(channel: string): string {
  return CHANNEL_META[channel]?.label ?? channel;
}

function ChannelBadge({ channel, extra }: { channel: string; extra?: string | null }): React.JSX.Element {
  const meta = CHANNEL_META[channel] ?? { label: channel, icon: 'fa-paper-plane', badge: 'bg-light text-dark border' };
  return (
    <span className={`badge ${meta.badge}`}>
      <i className={`fas ${meta.icon} me-1`}></i>{meta.label}{extra ? ` (${extra})` : ''}
    </span>
  );
}

// Stati condivisi tra recipient/attempt/campaign: stessa parola, stesso
// significato, stesso colore ovunque compaia in UI (coerenza grafica).
const STATUS_META: Record<string, { label: string; badge: string }> = {
  draft: { label: 'Bozza', badge: 'bg-secondary' },
  pending: { label: 'In attesa', badge: 'bg-secondary' },
  queued: { label: 'In coda', badge: 'bg-info' },
  processing: { label: 'In elaborazione', badge: 'bg-info' },
  running: { label: 'In corso', badge: 'bg-warning text-dark' },
  sent: { label: 'Inviato', badge: 'bg-success' },
  success: { label: 'Riuscito', badge: 'bg-success' },
  completed: { label: 'Completata', badge: 'bg-success' },
  failed: { label: 'Fallito', badge: 'bg-danger' },
  skipped: { label: 'Saltato', badge: 'bg-secondary' },
  cancelled: { label: 'Annullato', badge: 'bg-dark' },
};

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const meta = STATUS_META[status] ?? { label: status, badge: 'bg-light text-dark border' };
  return <span className={`badge ${meta.badge}`}>{meta.label}</span>;
}

// Stati SEND (campo sendStatus, popolato da SendStatusSyncService da PN
// GET /delivery/v2.9/notifications/sent/{iun}) — spazio valori distinto da
// STATUS_META sopra (quello è per recipient/attempt/campaign interni).
// Fonte: NotificationStatusV26 nello spec ufficiale PN (pn-delivery,
// api-external-b2b-pa-bundle.yaml), 11 valori, verificato 2026-07-14.
const SEND_STATUS_META: Record<string, { label: string; badge: string; icon: string }> = {
  IN_VALIDATION: { label: 'In validazione', badge: 'bg-secondary', icon: 'fa-hourglass-half' },
  ACCEPTED: { label: 'Accettata da SEND', badge: 'bg-info', icon: 'fa-inbox' },
  REFUSED: { label: 'Rifiutata', badge: 'bg-danger', icon: 'fa-ban' },
  DELIVERING: { label: 'In consegna', badge: 'bg-warning text-dark', icon: 'fa-truck' },
  DELIVERED: { label: 'Consegnata', badge: 'bg-primary', icon: 'fa-envelope-circle-check' },
  VIEWED: { label: 'Letta dal destinatario', badge: 'bg-success', icon: 'fa-eye' },
  EFFECTIVE_DATE: { label: 'Perfezionata per decorrenza termini', badge: 'bg-success', icon: 'fa-calendar-check' },
  PAID: { label: 'Pagata (deprecato)', badge: 'bg-secondary', icon: 'fa-money-check-dollar' },
  UNREACHABLE: { label: 'Destinatario irreperibile', badge: 'bg-danger', icon: 'fa-user-slash' },
  CANCELLED: { label: 'Annullata', badge: 'bg-dark', icon: 'fa-xmark' },
  RETURNED_TO_SENDER: { label: 'Restituita al mittente', badge: 'bg-danger', icon: 'fa-rotate-left' },
};

function SendStatusBadge({ status }: { status: string | null | undefined }): React.JSX.Element {
  if (!status) return <span className="text-muted">—</span>;
  const meta = SEND_STATUS_META[status] ?? { label: status, badge: 'bg-light text-dark border', icon: 'fa-circle-question' };
  return (
    <span className={`badge ${meta.badge}`}>
      <i className={`fas ${meta.icon} me-1`}></i>{meta.label}
    </span>
  );
}

const SEND_LEGAL_FACT_CATEGORY_LABELS: Record<string, string> = {
  SENDER_ACK: 'Presa in carico',
  DIGITAL_DELIVERY: 'Consegna digitale (PEC)',
  ANALOG_DELIVERY: 'Consegna cartacea (cartolina AR)',
  RECIPIENT_ACCESS: 'Accesso del destinatario',
  PEC_RECEIPT: 'Ricevuta PEC',
  ANALOG_FAILURE_DELIVERY: 'Mancata consegna cartacea',
  NOTIFICATION_CANCELLED: 'Notifica annullata',
};

function downloadComboLabel(channels: string[]): string {
  if (channels.length === 0) return 'Non scaricato';
  return channels.map((c) => channelLabel(c)).join(' + ');
}

// Le label di default di recharts Pie disegnano linea + testo fuori dal
// raggio esterno: con più fette o nomi lunghi (combinazioni canali) finiscono
// tagliate dal ResponsiveContainer. Mostriamo la percentuale dentro la fetta;
// i nomi completi restano in Legend/tabella sotto.
function renderPiePercentLabel(props: any): React.ReactNode {
  const { cx, cy, midAngle, innerRadius, outerRadius, percent } = props;
  if (!percent) return null;
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.6;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="#fff" textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={600}>
      {`${Math.round(percent * 100)}%`}
    </text>
  );
}

// Tiptap's editor.getHTML() always returns a non-empty shell (e.g. '<p></p>')
// even when the user has deleted all content, so a plain truthiness check on
// the HTML string is not enough to detect an "empty" body.
function isWizBodyEmpty(html: string): boolean {
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
  return text.length === 0;
}

// Testo puro (senza tag HTML) del corpo, per validare il vincolo App IO su
// PagoPA: il campo content.markdown deve avere lunghezza >= 80 e < 10001
// caratteri, altrimenti l'invio fallisce con HTTP 400 ("Invalid message
// structure"). Il conteggio sui tag HTML grezzi darebbe un falso positivo
// (es. "<p>ttr</p>" sembra >= 10 caratteri ma il testo visibile è "ttr").
function wizPlainTextLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim().length;
}

const APP_IO_MARKDOWN_MIN = 80;
const APP_IO_MARKDOWN_MAX = 10000;

// Upload a chunk: un reverse proxy esterno davanti al backend in produzione
// ha un limite di dimensione del body (osservato: 1MB) che spezzava in
// un'unica richiesta l'upload di CSV/ZIP di migliaia di destinatari/
// allegati. Chunk da 800KB per restare sotto quel limite con margine.
const UPLOAD_CHUNK_SIZE = 800 * 1024;

/** Upload di un singolo chunk via XHR (fetch non espone eventi di progresso in upload). */
function uploadChunkXhr(url: string, token: string, chunk: Blob, onProgress: (loadedBytes: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(chunk.size);
        resolve();
      } else {
        reject(new Error(`Upload chunk fallito (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Errore di rete durante upload chunk'));
    const fd = new FormData();
    fd.append('chunk', chunk, 'chunk.part');
    xhr.send(fd);
  });
}

/**
 * Carica `file` a chunk verso `<baseUrl>/init`, `/chunk/:uploadId/:index`,
 * `/complete/:uploadId`. `onProgress` riceve i byte effettivamente caricati
 * per QUESTO file (il chiamante somma l'offset se sta caricando più file
 * con una barra di progresso aggregata).
 */
async function uploadFileInChunks(
  baseUrl: string,
  token: string,
  file: Blob,
  filename: string,
  onProgress: (loadedBytes: number) => void,
  onCompleteStart?: () => void,
): Promise<any> {
  const totalChunks = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_SIZE));

  const initRes = await fetch(`${baseUrl}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ filename, totalChunks }),
  });
  if (!initRes.ok) {
    const errBody = await initRes.json().catch(() => null);
    throw new Error(errBody?.message || `Errore inizializzazione upload (HTTP ${initRes.status}).`);
  }
  const { uploadId } = await initRes.json() as { uploadId: string };

  let uploadedBefore = 0;
  for (let i = 0; i < totalChunks; i++) {
    const start = i * UPLOAD_CHUNK_SIZE;
    const end = Math.min(start + UPLOAD_CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    const base = uploadedBefore;
    await uploadChunkXhr(`${baseUrl}/chunk/${uploadId}/${i}`, token, chunk, (loadedInChunk) => onProgress(base + loadedInChunk));
    uploadedBefore += chunk.size;
  }

  if (onCompleteStart) {
    onCompleteStart();
  }

  const completeRes = await fetch(`${baseUrl}/complete/${uploadId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!completeRes.ok) {
    const errBody = await completeRes.json().catch(() => null);
    throw new Error(errBody?.message || `Errore completamento upload (HTTP ${completeRes.status}).`);
  }
  return completeRes.json();
}

// Codice Fiscale (16 alfanumerici) o Partita IVA (11 cifre) — stesso vincolo
// già applicato riga per riga nella validazione CSV del wizard massivo.
function isValidCfOrPiva(value: string): boolean {
  const v = value.trim();
  return /^[A-Z0-9]{16}$/i.test(v) || /^\d{11}$/.test(v);
}

// Escapes HTML-special characters in untrusted values (e.g. CSV cell content)
// before they are interpolated into a string that will be rendered via
// dangerouslySetInnerHTML. Must NOT be applied to the operator's own
// rich-text template markup, only to the substituted values.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface TemplateItem {
  id: string;
  type: 'MAIL' | 'APP_IO';
  name: string;
  subject: string;
  bodyHtml: string;
  bodyMarkdown: string;
  pairedTemplateId: string | null;
}

interface Campaign {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  channelType: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL';
  channelConfig: Record<string, any>;
  createdBy: string;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
  recipients?: Recipient[];
}

interface Recipient {
  id: string;
  codiceFiscale: string;
  fullName: string | null;
  email: string | null;
  pec: string | null;
  status: 'pending' | 'queued' | 'sent' | 'failed' | 'skipped';
  createdAt: string;
  extraData?: Record<string, any>;
  attempts?: Array<{
    id: string;
    channelType: string;
    status: string;
    responsePayload?: any;
    errorMessage?: string | null;
    attemptNumber: number;
    iun?: string | null;
    sendStatus?: string | null;
    sendStatusUpdatedAt?: string | null;
    protocolNumber?: number | null;
    protocolYear?: number | null;
    protocolledAt?: string | null;
  }>;
}

interface IoService {
  id: string;
  nome: string;
  idService: string;
  descrizione: string;
  apiKeyPrimaria: string; // valore mascherato (••••••••) quando impostato, mai in chiaro
  apiKeySecondaria: string;
  codiceCatalogo: string;
  isDefault: boolean;
  testedAt: string | null;
}

type MailConfigItem = {
  id: string;
  type: 'EMAIL' | 'PEC';
  name: string;
  host: string;
  port: number;
  secure: boolean;
  authEnabled: boolean;
  username: string;
  password: string;
  fromAddress: string;
  batchSize: number;
  batchIntervalSeconds: number;
  testedAt: string | null;
  active: boolean;
};

const EMPTY_MAIL_CONFIG: Omit<MailConfigItem, 'id' | 'testedAt' | 'active'> = {
  type: 'EMAIL', name: '', host: '', port: 587, secure: false,
  authEnabled: true, username: '', password: '', fromAddress: '',
  batchSize: 100, batchIntervalSeconds: 60,
};

const PIE_COLORS = ['var(--bi-primary)', 'var(--ms-purple-600)', 'var(--ms-gold-500)', 'var(--ms-green-600)', 'var(--ms-blue-600)'];

export function App(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(localStorage.getItem('comunicapa_token'));
  const [username, setUsername] = useState<string | null>(localStorage.getItem('comunicapa_username'));
  const [role, setRole] = useState<string | null>(localStorage.getItem('comunicapa_role'));
  const [view, setView] = useState<'dashboard' | 'invio-singolo' | 'invio-massivo' | 'invio-massivo-wizard' | 'statistiche' | 'notifiche-ricerca' | 'verifica-appio' | 'template-dashboard' | 'impostazioni' | 'campaign-detail' | 'audit-logs'>('dashboard');
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [editingTemplate, setEditingTemplate] = useState<Partial<TemplateItem> & { type: 'MAIL' | 'APP_IO' } | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [isLdapMock, setIsLdapMock] = useState<boolean>(false);
  const [brandLogoUrl, setBrandLogoUrl] = useState<string | null>(null);
  const [brandName, setBrandName] = useState<string>('ComunicaPA');
  const [brandSubtitle, setBrandSubtitle] = useState<string>('Amministrazione & Gestione Invii');

  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditPageSize] = useState(25);
  const [auditSearch, setAuditSearch] = useState('');
  const [auditLoading, setAuditLoading] = useState(false);

  const [searchCf, setSearchCf] = useState('');
  const [searchCampaignId, setSearchCampaignId] = useState('');
  const [searchChannel, setSearchChannel] = useState('');
  const [searchStatus, setSearchStatus] = useState('');
  const [searchDateFrom, setSearchDateFrom] = useState('');
  const [searchDateTo, setSearchDateTo] = useState('');
  const [searchPage, setSearchPage] = useState(1);
  const SEARCH_PAGE_SIZE = 50;
  const [searchResults, setSearchResults] = useState<Array<{ recipientId: string; campaignId: string; campaignName: string; codiceFiscale: string; fullName: string | null; channelType: string; status: string; createdAt: string }>>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [notifDetail, setNotifDetail] = useState<{
    recipient: { id: string; codiceFiscale: string; fullName: string | null; email: string | null; pec: string | null; status: string };
    campaign: { id: string; name: string; channelType: string };
    attempts: Array<{ attemptNumber: number; status: string; channelType: string; errorMessage: string | null; sentAt: string | null; createdAt: string; appIo: { attempted: false } | { attempted: true; success: boolean; error: string | null }; iun?: string | null; sendStatus?: string | null; sendStatusUpdatedAt?: string | null; protocolNumber?: number | null; protocolYear?: number | null; protocolledAt?: string | null }>;
    preview: { subject: string; bodyHtml?: string; bodyMarkdown?: string };
    downloads: Array<{ channel: string; attachmentIndex: number; downloadedAt: string }>;
  } | null>(null);
  const [notifDetailLoading, setNotifDetailLoading] = useState(false);
  const [sendLegalFacts, setSendLegalFacts] = useState<{ legalFactId: string; category: string }[] | null>(null);
  const [sendLegalFactsLoading, setSendLegalFactsLoading] = useState(false);
  const [sendLegalFactRetry, setSendLegalFactRetry] = useState<Record<string, { retryAfterSeconds?: number; error?: string }>>({});

  const [verificaCf, setVerificaCf] = useState('');
  const [verificaLoading, setVerificaLoading] = useState(false);
  const [verificaResult, setVerificaResult] = useState<{ success: boolean; active: boolean; message: string } | null>(null);

  const runNotificationSearch = async (page = searchPage) => {
    setSearchLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchCf) params.set('codiceFiscale', searchCf);
      if (searchCampaignId) params.set('campaignId', searchCampaignId);
      if (searchChannel) params.set('channelType', searchChannel);
      if (searchStatus) params.set('status', searchStatus);
      if (searchDateFrom) params.set('dateFrom', searchDateFrom);
      if (searchDateTo) params.set('dateTo', searchDateTo);
      params.set('page', String(page));
      params.set('pageSize', String(SEARCH_PAGE_SIZE));
      const res = await fetch(`${ADMIN_API_BASE}/notifications-search?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setSearchResults(data.rows || []);
      setSearchTotal(data.total || 0);
      setSearchPage(page);
    } finally {
      setSearchLoading(false);
    }
  };

  const openNotificationDetail = async (recipientId: string) => {
    setNotifDetail(null);
    setSendLegalFacts(null);
    setSendLegalFactRetry({});
    setNotifDetailLoading(true);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/notifications-search/${recipientId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        alert('Impossibile caricare il dettaglio della notifica.');
        return;
      }
      setNotifDetail(await res.json());
    } finally {
      setNotifDetailLoading(false);
    }
  };

  const loadSendLegalFacts = async () => {
    if (!notifDetail) return;
    setSendLegalFactsLoading(true);
    try {
      const res = await apiFetch(`/notifications-search/${notifDetail.recipient.id}/send-legal-facts`);
      if (!res.ok) {
        alert('Impossibile caricare i documenti SEND.');
        return;
      }
      const data = await res.json();
      setSendLegalFacts(data.items || []);
    } catch (err) {
      if (!(err instanceof ApiAuthError)) alert('Impossibile caricare i documenti SEND.');
    } finally {
      setSendLegalFactsLoading(false);
    }
  };

  const downloadSendLegalFact = async (legalFactId: string) => {
    if (!notifDetail) return;
    try {
      const res = await apiFetch(`/notifications-search/${notifDetail.recipient.id}/send-legal-facts/${encodeURIComponent(legalFactId)}/download`);
      if (!res.ok) {
        alert('Errore durante il download del documento.');
        return;
      }
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        setSendLegalFactRetry((prev) => ({ ...prev, [legalFactId]: { retryAfterSeconds: data.retryAfterSeconds, error: data.error } }));
        return;
      }
      setSendLegalFactRetry((prev) => {
        const next = { ...prev };
        delete next[legalFactId];
        return next;
      });
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : `documento-${legalFactId}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      if (!(err instanceof ApiAuthError)) alert('Errore durante il download del documento.');
    }
  };

  useEffect(() => {
    if (view === 'notifiche-ricerca' && token) {
      runNotificationSearch(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, token]);

  useEffect(() => {
    if (view === 'statistiche' && token) {
      fetchGlobalStats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, token]);

  useEffect(() => {
    fetch(`${API_BASE}/version`)
      .then((r) => r.json())
      .then((d: { version?: string; isLdapMock?: boolean }) => {
        setAppVersion(d.version ?? 'dev');
        setIsLdapMock(d.isLdapMock ?? false);
      })
      .catch(() => setAppVersion('dev'));

    fetch(`${API_BASE}/branding`)
      .then((r) => r.json())
      .then((b: { name?: string; subtitle?: string; logoUrl?: string | null; faviconUrl?: string | null }) => {
        if (b.name) {
          document.title = `${b.name} — ComunicaPA Admin`;
          setBrandName(b.name);
        }
        if (b.subtitle) {
          setBrandSubtitle(b.subtitle);
        }
        // logo/favicon possono essere path relativi al backend o URL esterni assoluti
        if (b.logoUrl) {
          setBrandLogoUrl(/^https?:\/\//i.test(b.logoUrl) ? b.logoUrl : `${API_BASE}${b.logoUrl}`);
        }
        if (b.faviconUrl) {
          const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']") ?? document.createElement('link');
          link.rel = 'icon';
          // faviconUrl può essere un path relativo al backend o un URL esterno assoluto
          link.href = /^https?:\/\//i.test(b.faviconUrl) ? b.faviconUrl : `${API_BASE}${b.faviconUrl}`;
          document.head.appendChild(link);
        }
      })
      .catch(() => { /* branding default */ });
  }, []);

  // Login form state
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  // Campaign list and loading
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  // Single send form state (in Invio Singolo)
  const [singleCf, setSingleCf] = useState('');
  const [singleName, setSingleName] = useState('');
  const [singleEmail, setSingleEmail] = useState('');
  const [singlePec, setSinglePec] = useState('');
  const [singleSubject, setSingleSubject] = useState('');
  const [singleBody, setSingleBody] = useState('');
  const [singleChannel, setSingleChannel] = useState<'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL'>('EMAIL');
  const [singleAppIoServiceId, setSingleAppIoServiceId] = useState('');
  const [singleSending, setSingleSending] = useState(false);
  const [singleSuccess, setSingleSuccess] = useState<string | null>(null);

  // Wizard States
  const [wizStep, setWizStep] = useState(1);
  const [wizName, setWizName] = useState('');
  const [wizDesc, setWizDesc] = useState('');
  const [wizChannel, setWizChannel] = useState<'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL'>('EMAIL');
  const [wizAppIoServiceId, setWizAppIoServiceId] = useState('');
  const [wizCsvFile, setWizCsvFile] = useState<File | null>(null);
  const [wizCsvHeaders, setWizCsvHeaders] = useState<string[]>([]);
  const [wizCsvRows, setWizCsvRows] = useState<Record<string, string>[]>([]);
  const [wizCsvHasHeaders, setWizCsvHasHeaders] = useState(true);
  const [wizPdfFiles, setWizPdfFiles] = useState<File[]>([]);
  const [wizMapping, setWizMapping] = useState({
    codice_fiscale: '',
    full_name: '',
    full_name_2: '',
    email: '',
    pec: '',
    subject: '',
  });
  const [wizAttachments, setWizAttachments] = useState<Array<{ key: string; label: string }>>([]);
  // Mappatura colonna→campo e colonne allegato salvate su una campagna sorgente
  // (duplica/riprendi bozza), da riapplicare al prossimo CSV caricato SOLO se le
  // stesse colonne sono presenti nell'intestazione (stesso formato CSV riusato,
  // caso d'uso tipico). Se il CSV è diverso, restano inapplicate senza errori.
  const [wizPendingMapping, setWizPendingMapping] = useState<typeof wizMapping | null>(null);
  const [wizPendingAttachments, setWizPendingAttachments] = useState<Array<{ key: string; label: string }> | null>(null);
  const [wizValidationErrors, setWizValidationErrors] = useState<Array<{ row: number; field: string; val: string; err: string }>>([]);
  const [wizValidationWarnings, setWizValidationWarnings] = useState<Array<{ row: number; field: string; val: string; warn: string }>>([]);
  const [wizValidRows, setWizValidRows] = useState<Record<string, string>[]>([]);
  const [wizSubject, setWizSubject] = useState('');
  const [wizProtocolla, setWizProtocolla] = useState(false);
  const [wizTaxonomyCode, setWizTaxonomyCode] = useState('');
  const [wizPhysicalCommunicationType, setWizPhysicalCommunicationType] = useState<'AR_REGISTERED_LETTER' | 'REGISTERED_LETTER_890'>('AR_REGISTERED_LETTER');
  const [wizPostalServiceType, setWizPostalServiceType] = useState<'Raccomandata' | 'Lettera'>('Raccomandata');
  const [wizPostalReturnReceipt, setWizPostalReturnReceipt] = useState(true);
  const [wizPostalAddressColumn, setWizPostalAddressColumn] = useState('');
  const [wizPostalMunicipalityColumn, setWizPostalMunicipalityColumn] = useState('');
  const [wizPostalZipColumn, setWizPostalZipColumn] = useState('');
  const [wizPostalProvinceColumn, setWizPostalProvinceColumn] = useState('');
  const [wizPostalUserDataColumn, setWizPostalUserDataColumn] = useState('');
  const [wizBody, setWizBody] = useState('');
  const subjectInputRef = useRef<HTMLInputElement>(null);
  const [wizLastFocusedField, setWizLastFocusedField] = useState<'subject' | 'body'>('body');

  const insertTokenIntoSubject = (token: string) => {
    const input = subjectInputRef.current;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const value = input.value;
    const newValue = value.substring(0, start) + ` ${token} ` + value.substring(end);
    setWizSubject(newValue);
    setTimeout(() => {
      input.focus();
      const newCursorPos = start + token.length + 2; // +2 for surrounding spaces
      input.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const [wizPreviewIndex, setWizPreviewIndex] = useState(0);
  const [wizPreviewResult, setWizPreviewResult] = useState<{ subject: string; bodyHtml?: string; bodyMarkdown?: string } | null>(null);
  const [wizPreviewLoading, setWizPreviewLoading] = useState(false);
  const [wizPreviewChannelTab, setWizPreviewChannelTab] = useState<'MAIN' | 'APP_IO'>('MAIN');
  const [wizSending, setWizSending] = useState(false);
  const [wizUploadProgress, setWizUploadProgress] = useState<{ label: string; loaded: number; total: number } | null>(null);
  const [wizMailConfigId, setWizMailConfigId] = useState('');
  const [wizAppIoMode, setWizAppIoMode] = useState<'none' | 'parallel' | 'exclusive'>('parallel');
  const [wizAppIoDifferentiate, setWizAppIoDifferentiate] = useState(false);
  const [wizAppIoSubjectOverride, setWizAppIoSubjectOverride] = useState('');
  const [wizAppIoBodyOverride, setWizAppIoBodyOverride] = useState('');
  const [wizBlockedChannels, setWizBlockedChannels] = useState<string[]>([]);
  const [wizCampaignId, setWizCampaignId] = useState<string | null>(null);
  const [wizDraftSaving, setWizDraftSaving] = useState(false);

  const [wizPaymentEnabled, setWizPaymentEnabled] = useState(false);
  const [wizPaymentAmountCol, setWizPaymentAmountCol] = useState('');
  const [wizPaymentAmountType, setWizPaymentAmountType] = useState<'cents' | 'euro'>('euro');
  const [wizPaymentNoticeCol, setWizPaymentNoticeCol] = useState('');
  const [wizPaymentDueDateCol, setWizPaymentDueDateCol] = useState('');
  const [wizPaymentPayeeType, setWizPaymentPayeeType] = useState<'static' | 'column'>('static');
  const [wizPaymentPayeeStatic, setWizPaymentPayeeStatic] = useState('');
  const [wizPaymentPayeeCol, setWizPaymentPayeeCol] = useState('');

  const getWizRowFullName = (row: Record<string, string>) => {
    if (!row) return '';
    const fn1 = row[wizMapping.full_name] || '';
    const fn2 = wizMapping.full_name_2 ? (row[wizMapping.full_name_2] || '') : '';
    return [fn1, fn2].filter(Boolean).join(' ');
  };

  // Con CSV senza header le colonne sono "Colonna N": senza un'anteprima del
  // valore reale l'operatore non ha modo di sapere quale colonna scegliere.
  const wizColumnOptionLabel = (h: string): string => {
    const sample = wizCsvRows[0]?.[h];
    if (!sample) return h;
    const truncated = sample.length > 30 ? `${sample.slice(0, 30)}…` : sample;
    return `${h} — ${truncated}`;
  };

  // Anteprima Step 4: chiama l'endpoint reale di rendering (stesso motore
  // usato per l'invio) invece di ricostruire il template a mano nel JSX.
  useEffect(() => {
    if (wizStep !== 4 || !wizValidRows[wizPreviewIndex]) {
      return;
    }
    const row = wizValidRows[wizPreviewIndex];
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setWizPreviewLoading(true);
      fetch(`${ADMIN_API_BASE}/campaigns/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        signal: controller.signal,
        body: JSON.stringify({
          channelType: wizPreviewChannelTab === 'APP_IO' ? 'APP_IO' : wizChannel,
          subject: wizPreviewChannelTab === 'APP_IO'
            ? (wizAppIoDifferentiate ? wizAppIoSubjectOverride : wizSubject)
            : ((wizMapping.subject && row[wizMapping.subject]?.trim()) || wizSubject),
          body: wizPreviewChannelTab === 'APP_IO'
            ? (wizAppIoDifferentiate ? wizAppIoBodyOverride : wizBody)
            : wizBody,
          attachments: wizAttachments,
          recipient: {
            codiceFiscale: row[wizMapping.codice_fiscale] || '',
            fullName: getWizRowFullName(row),
            email: row[wizMapping.email] || undefined,
            pec: row[wizMapping.pec] || undefined,
            extraData: row,
            protocolNumber: wizProtocolla ? '[N. Protocollo]' : undefined,
          },
        }),
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('preview failed'))))
        .then((data) => setWizPreviewResult(data))
        .catch((err) => {
          if (err.name !== 'AbortError') setWizPreviewResult(null);
        })
        .finally(() => setWizPreviewLoading(false));
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [wizStep, wizPreviewIndex, wizSubject, wizBody, wizChannel, wizAttachments, wizValidRows, wizMapping, token, wizPreviewChannelTab, wizAppIoDifferentiate, wizAppIoSubjectOverride, wizAppIoBodyOverride, wizProtocolla]);

  // App IO impone al campo content.markdown una lunghezza >= 80 e < 10001
  // caratteri (altrimenti PagoPA rifiuta con HTTP 400 "Invalid message
  // structure"). Vale sia per il canale App IO diretto sia per il testo
  // (eventualmente differenziato) usato in co-consegna con EMAIL/PEC.
  const wizAppIoInvolved = wizChannel === 'APP_IO' || wizAppIoMode !== 'none';
  const wizAppIoBodyText = wizChannel === 'APP_IO'
    ? wizBody
    : (wizAppIoDifferentiate ? wizAppIoBodyOverride : wizBody);
  const wizAppIoBodyLen = wizAppIoInvolved ? wizPlainTextLength(wizAppIoBodyText) : 0;
  const wizAppIoBodyLenInvalid = wizAppIoInvolved
    && (wizAppIoBodyLen < APP_IO_MARKDOWN_MIN || wizAppIoBodyLen > APP_IO_MARKDOWN_MAX);

  // Settings State (loaded from backend GET /settings; see useEffect below)
  const [settEntityName, setSettEntityName] = useState('Comune di Montesilvano');
  const [settSubtitle, setSettSubtitle] = useState('ComunicaPA Hub');
  // brand.logo / brand.favicon: filename locale (da upload) oppure URL esterno https://
  const [settLogoValue, setSettLogoValue] = useState('');
  const [settFaviconValue, setSettFaviconValue] = useState('');

  // Configurazioni mail/PEC multiple (tabella mail_server_configs)
  const [mailConfigs, setMailConfigs] = useState<MailConfigItem[]>([]);
  const [editingMailConfig, setEditingMailConfig] = useState<(Partial<MailConfigItem> & { type: 'EMAIL' | 'PEC' }) | null>(null);
  const [mailConfigTestTo, setMailConfigTestTo] = useState('');
  const [mailConfigBusyId, setMailConfigBusyId] = useState<string | null>(null);
  const [mailConfigMsg, setMailConfigMsg] = useState<{ text: string; error: boolean } | null>(null);

  // App IO Settings — persistiti lato server (IoServiceConfig), non più in localStorage
  const [ioServices, setIoServices] = useState<IoService[]>([]);

  // App IO New Service form
  const [newSvcNome, setNewSvcNome] = useState('');
  const [newSvcIdService, setNewSvcIdService] = useState('');
  const [newSvcDesc, setNewSvcDesc] = useState('');
  const [newSvcApiKeyPrimaria, setNewSvcApiKeyPrimaria] = useState('');
  const [newSvcApiKeySecondaria, setNewSvcApiKeySecondaria] = useState('');
  const [newSvcCodiceCatalogo, setNewSvcCodiceCatalogo] = useState('');
  const [newSvcIsDefault, setNewSvcIsDefault] = useState(false);
  const [showNewSvcForm, setShowNewSvcForm] = useState(false);

  // App IO Test Service
  const [ioTestCf, setIoTestCf] = useState('');
  const [ioTestBusyId, setIoTestBusyId] = useState<string | null>(null);
  const [ioTestMsg, setIoTestMsg] = useState<{ id: string; text: string; error: boolean } | null>(null);
  const [editingIoService, setEditingIoService] = useState<IoService | null>(null);

  const [settSendEnvironment, setSettSendEnvironment] = useState<'collaudo' | 'produzione'>('collaudo');
  const [settSendTestBaseUrl, setSettSendTestBaseUrl] = useState('https://api.uat.notifichedigitali.it');
  const [settSendTestApiKey, setSettSendTestApiKey] = useState('');
  const [settSendTestPurposeId, setSettSendTestPurposeId] = useState('');
  const [settSendTestGroup, setSettSendTestGroup] = useState('');
  const [settSendSenderTaxId, setSettSendSenderTaxId] = useState('');
  const [settSendTaxonomies, setSettSendTaxonomies] = useState<Array<{ code: string; label: string }>>([]);
  const [settSendEntityType, setSettSendEntityType] = useState('');
  const [wizAddTaxonomyCode, setWizAddTaxonomyCode] = useState('');
  const [settSendProdBaseUrl, setSettSendProdBaseUrl] = useState('https://api.notifichedigitali.it');
  const [settSendProdApiKey, setSettSendProdApiKey] = useState('');
  const [settSendProdPurposeId, setSettSendProdPurposeId] = useState('');
  const [settSendProdGroup, setSettSendProdGroup] = useState('');
  const [settSendTesting, setSettSendTesting] = useState<'test' | 'prod' | null>(null);
  const [settSendTestResult, setSettSendTestResult] = useState<{ env: 'test' | 'prod'; ok: boolean; message: string } | null>(null);
  const [settSendGroups, setSettSendGroups] = useState<Record<'test' | 'prod', Array<{ id: string; name: string; description: string }>>>({ test: [], prod: [] });
  const [settSendGroupsLoading, setSettSendGroupsLoading] = useState<'test' | 'prod' | null>(null);
  const [settSendGroupsError, setSettSendGroupsError] = useState<Record<'test' | 'prod', string | null>>({ test: null, prod: null });

  // Postalizzazione (GlobalCom SOAP) — credenziali reali, persistite via app_settings (postal.*)
  const [settPostalBaseUrl, setSettPostalBaseUrl] = useState('');
  const [settPostalUser, setSettPostalUser] = useState('');
  const [settPostalPassword, setSettPostalPassword] = useState('');
  const [settPostalGroup, setSettPostalGroup] = useState('');
  const [settPostalCentroDiCosto, setSettPostalCentroDiCosto] = useState('');
  const [settPostalMittenteDenominazione1, setSettPostalMittenteDenominazione1] = useState('');
  const [settPostalMittenteIndirizzo1, setSettPostalMittenteIndirizzo1] = useState('');
  const [settPostalMittenteCap, setSettPostalMittenteCap] = useState('');
  const [settPostalMittenteCitta, setSettPostalMittenteCitta] = useState('');
  const [settPostalMittenteProvincia, setSettPostalMittenteProvincia] = useState('');

  const [settPdndTestTokenUrl, setSettPdndTestTokenUrl] = useState('https://auth.uat.interop.pagopa.it/token.oauth2');
  const [settPdndTestAudience, setSettPdndTestAudience] = useState('auth.uat.interop.pagopa.it/client-assertion');
  const [settPdndTestClientId, setSettPdndTestClientId] = useState('');
  const [settPdndTestKid, setSettPdndTestKid] = useState('');
  const [settPdndTestPrivateKey, setSettPdndTestPrivateKey] = useState('');
  const [settPdndProdTokenUrl, setSettPdndProdTokenUrl] = useState('https://auth.interop.pagopa.it/token.oauth2');
  const [settPdndProdAudience, setSettPdndProdAudience] = useState('auth.interop.pagopa.it/client-assertion');
  const [settPdndProdClientId, setSettPdndProdClientId] = useState('');
  const [settPdndProdKid, setSettPdndProdKid] = useState('');
  const [settPdndProdPrivateKey, setSettPdndProdPrivateKey] = useState('');
  const [settPdndGeneratingKey, setSettPdndGeneratingKey] = useState<'test' | 'prod' | null>(null);
  const [settPdndGeneratedPubKey, setSettPdndGeneratedPubKey] = useState<{ env: 'test' | 'prod'; pem: string } | null>(null);
  const [settPdndTesting, setSettPdndTesting] = useState<'test' | 'prod' | null>(null);
  const [settPdndTestResult, setSettPdndTestResult] = useState<{ env: 'test' | 'prod'; ok: boolean; message: string } | null>(null);

  const [settInadTestPurposeId, setSettInadTestPurposeId] = useState('');
  const [settInadProdPurposeId, setSettInadProdPurposeId] = useState('');
  const [settInadTesting, setSettInadTesting] = useState<'test' | 'prod' | null>(null);
  const [settInadTestResult, setSettInadTestResult] = useState<{ env: 'test' | 'prod'; ok: boolean; message: string } | null>(null);
  const [settInipecTestPurposeId, setSettInipecTestPurposeId] = useState('');
  const [settInipecProdPurposeId, setSettInipecProdPurposeId] = useState('');
  const [settInipecTesting, setSettInipecTesting] = useState<'test' | 'prod' | null>(null);
  const [settInipecTestResult, setSettInipecTestResult] = useState<{ env: 'test' | 'prod'; ok: boolean; message: string } | null>(null);
  const [settRetentionDays, setSettRetentionDays] = useState('90');

  const [settOidcIssuer, setSettOidcIssuer] = useState('');
  const [settOidcAudience, setSettOidcAudience] = useState('');
  const [settOidcJwksUri, setSettOidcJwksUri] = useState('');
  const [settOidcClientId, setSettOidcClientId] = useState('');
  const [settOidcClientSecret, setSettOidcClientSecret] = useState('');
  const [settOidcLogoutUrl, setSettOidcLogoutUrl] = useState('');
  const [settCitizenPublicUrl, setSettCitizenPublicUrl] = useState('');

  const [settProtoProvider, setSettProtoProvider] = useState('tinn');
  const [settProtoUrl, setSettProtoUrl] = useState('');
  const [settProtoCodiceEnte, setSettProtoCodiceEnte] = useState('');
  const [settProtoUser, setSettProtoUser] = useState('');
  const [settProtoPass, setSettProtoPass] = useState('');
  const [settProtoCodiceTitolario, setSettProtoCodiceTitolario] = useState('6022');
  const [settProtoCodiceAmministrazione, setSettProtoCodiceAmministrazione] = useState('1');
  const [settProtoUnitaOrganizzativa, setSettProtoUnitaOrganizzativa] = useState('1');
  const [settProtoMittenteDenominazione, setSettProtoMittenteDenominazione] = useState('');

  const [settPostalProvider, setSettPostalProvider] = useState(localStorage.getItem('sett_postal_provider') || 'Postel');
  const [settPostalKey, setSettPostalKey] = useState(localStorage.getItem('sett_postal_key') || '');
  const [settPostalUrl, setSettPostalUrl] = useState(localStorage.getItem('sett_postal_url') || 'https://gateway.postel.it/postalization');

  const [activeSettingsTab, setActiveSettingsTab] = useState<'personalizzazione' | 'smtp' | 'pec' | 'app-io' | 'pdnd' | 'send' | 'inad' | 'inipec' | 'protocollo' | 'postalizzazione' | 'oidc' | 'motori'>('personalizzazione');
  const [engines, setEngines] = useState<any[]>([]);
  const [sendStageCounts, setSendStageCounts] = useState<{ protocollato: number; inviato: number; fallito: number } | null>(null);
  const [loadingEngines, setLoadingEngines] = useState(false);
  const [enginesError, setEnginesError] = useState<string | null>(null);
  const [engineJobsChannel, setEngineJobsChannel] = useState<string | null>(null);
  const [engineJobs, setEngineJobs] = useState<Array<{ jobId: string; campaignId: string; recipientId: string; failedReason?: string; attemptsMade: number }>>([]);
  const [expandedJobLogs, setExpandedJobLogs] = useState<{ jobId: string; logs: string[] } | null>(null);
  const [loadingJobLogs, setLoadingJobLogs] = useState(false);
  // Sidebar mobile (≤991px): il CSS la nasconde con translateX finché body non ha .bo-sidebar-open
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    document.body.classList.toggle('bo-sidebar-open', sidebarOpen);
    return () => document.body.classList.remove('bo-sidebar-open');
  }, [sidebarOpen]);
  const [settingsSavedMessage, setSettingsSavedMessage] = useState<{ text: string; error: boolean } | null>(null);

  // Campaign detail state
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loadingCampaignDetail, setLoadingCampaignDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [failureGroups, setFailureGroups] = useState<Array<{ errorMessage: string; count: number; recipientIds: string[] }>>([]);
  const [retryingGroup, setRetryingGroup] = useState<string | null>(null);
  const [recipientsPage, setRecipientsPage] = useState<{ page: number; pageSize: number; total: number; items: Array<{ id: string; fullName: string | null; codiceFiscale: string; email: string | null; pec: string | null; status: string; downloadCount: number; iun?: string | null; sendStatus?: string | null; sendStatusUpdatedAt?: string | null; protocolNumber?: number | null; protocolYear?: number | null }> } | null>(null);
  const [recipientsSearch, setRecipientsSearch] = useState('');
  const [recipientsPageNum, setRecipientsPageNum] = useState(1);
  const [channelBreakdown, setChannelBreakdown] = useState<{ primaryOnly: number; both: number; appIoOnly: number; appIoDespitePrimaryFail: number; neither: number } | null>(null);
  const [campaignSendStageCounts, setCampaignSendStageCounts] = useState<{ queued: number; protocollato: number; inviato: number; fallito: number } | null>(null);
  const [downloadCombinations, setDownloadCombinations] = useState<Array<{ channels: string[]; count: number; sentSuccessfully: boolean }> | null>(null);
  const [statsDateFrom, setStatsDateFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [statsDateTo, setStatsDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [globalStats, setGlobalStats] = useState<{
    totals: { totalRecipients: number; totalSent: number; totalFailed: number; totalDownloaded: number; downloadPercentage: number };
    monthlyTrend: Array<{ month: string; sent: number; downloaded: number }>;
    channelTotals: Array<{ channel: string; sent: number }>;
    downloadChannelTotals: Array<{ channel: string; count: number }>;
    campaignLeaderboard: Array<{ campaignId: string; campaignName: string; totalRecipients: number; downloadPercentage: number }>;
    neverDownloadedCount: number;
  } | null>(null);
  const [globalStatsLoading, setGlobalStatsLoading] = useState(false);


  // Pre-select default App IO service id for forms
  useEffect(() => {
    const def = ioServices.find(s => s.isDefault);
    if (def) {
      setSingleAppIoServiceId(def.id);
    } else if (ioServices.length > 0) {
      setSingleAppIoServiceId(ioServices[0].id);
    }
  }, [ioServices]);

  // Auto-refresh campaign detail if running/queued
  useEffect(() => {
    let timer: any;
    if (view === 'campaign-detail' && selectedCampaignId && campaign) {
      if (campaign.status === 'queued' || campaign.status === 'running') {
        timer = setInterval(() => {
          fetchCampaignDetail(selectedCampaignId);
        }, 3000);
      }
    }
    return () => clearInterval(timer);
  }, [view, selectedCampaignId, campaign]);

  // Ricarica la pagina destinatari su cambio pagina/ricerca (debounce sulla ricerca)
  useEffect(() => {
    if (!selectedCampaignId || view !== 'campaign-detail') return;
    const handle = setTimeout(() => {
      fetchRecipientsPage(selectedCampaignId, recipientsPageNum, recipientsSearch);
    }, 300);
    return () => clearTimeout(handle);
  }, [selectedCampaignId, view, recipientsPageNum, recipientsSearch]);

  useEffect(() => {
    if (token) {
      fetchCampaigns();
      fetchMailConfigs();
      fetchIoServices();
    }
  }, [token]);

  useEffect(() => { if (token) fetchTemplates(); }, [token]);

  useEffect(() => {
    let handle: any;
    if (view === 'audit-logs' && token) {
      handle = setTimeout(() => {
        fetchAuditLogs(auditPage, auditSearch);
      }, 300);
    }
    return () => {
      if (handle) clearTimeout(handle);
    };
  }, [view, token, auditPage, auditSearch]);

  // Carica le impostazioni persistite dal backend al login
  useEffect(() => {
    if (!token) return;
    fetch(`${ADMIN_API_BASE}/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (r.status === 401) {
          // Token scaduto/invalido: torna al login invece di mostrare campi vuoti
          handleLogout();
          return Promise.reject(new Error('401'));
        }
        return r.ok ? r.json() : Promise.reject(new Error(String(r.status)));
      })
      .then((d: { settings: Record<string, string | number | boolean> }) => {
        const s = d.settings;
        setSettEntityName(String(s['brand.name'] ?? ''));
        setSettSubtitle(String(s['brand.subtitle'] ?? ''));
        setSettLogoValue(String(s['brand.logo'] ?? ''));
        setSettFaviconValue(String(s['brand.favicon'] ?? ''));
        // SMTP and PEC are loaded dynamically via fetchMailConfigs(); App IO via fetchIoServices()
        setSettSendEnvironment((String(s['send.environment'] ?? 'collaudo')) as 'collaudo' | 'produzione');
        setSettSendTestBaseUrl(String(s['send.test.baseUrl'] ?? ''));
        setSettSendTestApiKey(String(s['send.test.apiKey'] ?? ''));
        setSettSendTestPurposeId(String(s['send.test.purposeId'] ?? ''));
        setSettSendTestGroup(String(s['send.test.group'] ?? ''));
        setSettSendSenderTaxId(String(s['send.senderTaxId'] ?? ''));
        setSettSendEntityType(String(s['send.entityType'] ?? ''));
        try {
          setSettSendTaxonomies(JSON.parse(String(s['send.enabledTaxonomyCodes'] ?? '[]')));
        } catch {
          setSettSendTaxonomies([]);
        }
        setSettSendProdBaseUrl(String(s['send.prod.baseUrl'] ?? ''));
        setSettSendProdApiKey(String(s['send.prod.apiKey'] ?? ''));
        setSettSendProdPurposeId(String(s['send.prod.purposeId'] ?? ''));
        setSettSendProdGroup(String(s['send.prod.group'] ?? ''));
        setSettPostalBaseUrl(String(s['postal.baseUrl'] ?? ''));
        setSettPostalUser(String(s['postal.user'] ?? ''));
        setSettPostalPassword(String(s['postal.password'] ?? ''));
        setSettPostalGroup(String(s['postal.group'] ?? ''));
        setSettPostalCentroDiCosto(String(s['postal.centroDiCosto'] ?? ''));
        setSettPostalMittenteDenominazione1(String(s['postal.mittente.denominazione1'] ?? ''));
        setSettPostalMittenteIndirizzo1(String(s['postal.mittente.indirizzo1'] ?? ''));
        setSettPostalMittenteCap(String(s['postal.mittente.cap'] ?? ''));
        setSettPostalMittenteCitta(String(s['postal.mittente.citta'] ?? ''));
        setSettPostalMittenteProvincia(String(s['postal.mittente.provincia'] ?? ''));
        setSettPdndTestTokenUrl(String(s['pdnd.test.tokenUrl'] ?? ''));
        setSettPdndTestAudience(String(s['pdnd.test.audience'] ?? ''));
        setSettPdndTestClientId(String(s['pdnd.test.clientId'] ?? ''));
        setSettPdndTestKid(String(s['pdnd.test.kid'] ?? ''));
        setSettPdndTestPrivateKey(String(s['pdnd.test.privateKey'] ?? ''));
        setSettPdndProdTokenUrl(String(s['pdnd.prod.tokenUrl'] ?? ''));
        setSettPdndProdAudience(String(s['pdnd.prod.audience'] ?? ''));
        setSettPdndProdClientId(String(s['pdnd.prod.clientId'] ?? ''));
        setSettPdndProdKid(String(s['pdnd.prod.kid'] ?? ''));
        setSettPdndProdPrivateKey(String(s['pdnd.prod.privateKey'] ?? ''));
        setSettInadTestPurposeId(String(s['inad.test.purposeId'] ?? ''));
        setSettInadProdPurposeId(String(s['inad.prod.purposeId'] ?? ''));
        setSettInipecTestPurposeId(String(s['inipec.test.purposeId'] ?? ''));
        setSettInipecProdPurposeId(String(s['inipec.prod.purposeId'] ?? ''));
        setSettProtoProvider(String(s['protocollo.provider'] ?? 'tinn'));
        setSettProtoUrl(String(s['protocollo.baseUrl'] ?? ''));
        setSettProtoCodiceEnte(String(s['protocollo.codiceEnte'] ?? ''));
        setSettProtoUser(String(s['protocollo.username'] ?? ''));
        setSettProtoPass(String(s['protocollo.password'] ?? ''));
        setSettProtoCodiceTitolario(String(s['protocollo.codiceTitolario'] ?? '6022'));
        setSettProtoCodiceAmministrazione(String(s['protocollo.codiceAmministrazione'] ?? '1'));
        setSettProtoUnitaOrganizzativa(String(s['protocollo.unitaOrganizzativa'] ?? '1'));
        setSettProtoMittenteDenominazione(String(s['protocollo.mittenteDenominazione'] ?? ''));
        setSettRetentionDays(String(s['retention.maxDays'] ?? '90'));
        setSettOidcIssuer(String(s['oidc.issuer'] ?? ''));
        setSettOidcAudience(String(s['oidc.audience'] ?? ''));
        setSettOidcJwksUri(String(s['oidc.jwksUri'] ?? ''));
        setSettOidcClientId(String(s['oidc.clientId'] ?? ''));
        setSettOidcClientSecret(String(s['oidc.clientSecret'] ?? ''));
        setSettOidcLogoutUrl(String(s['oidc.logoutUrl'] ?? ''));
        setSettCitizenPublicUrl(String(s['system.citizenPublicUrl'] ?? ''));
      })
      .catch(() => { /* backend non raggiungibile: la pagina resta editabile */ });
  }, [token]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError(null);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername, password: loginPassword }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || 'Credenziali non valide o servizio LDAP non disponibile.');
      }

      const data = await res.json();
      localStorage.setItem('comunicapa_token', data.access_token);
      localStorage.setItem('comunicapa_username', data.username);
      localStorage.setItem('comunicapa_role', data.role);
      
      setToken(data.access_token);
      setUsername(data.username);
      setRole(data.role);
      setView('dashboard');
    } catch (err: any) {
      setLoginError(err.message || 'Errore durante il login');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('comunicapa_token');
    localStorage.removeItem('comunicapa_username');
    localStorage.removeItem('comunicapa_role');
    setToken(null);
    setUsername(null);
    setRole(null);
    setView('dashboard');
  };

  class ApiAuthError extends Error {
    constructor() {
      super('Sessione scaduta. Effettua nuovamente il login.');
      this.name = 'ApiAuthError';
    }
  }

  const apiFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(`${ADMIN_API_BASE}${path}`, { ...init, headers });
    if (res.status === 401) {
      handleLogout();
      throw new ApiAuthError();
    }
    return res;
  };

  const downloadTextFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'application/x-pem-file' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPdndPublicKey = async (env: 'test' | 'prod') => {
    try {
      const res = await apiFetch(`/settings/pdnd/${env}/public-key`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Errore durante il recupero della chiave pubblica.');
      }
      const data = await res.json();
      downloadTextFile(`pdnd-${env}-public.pem`, data.publicKey);
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      alert(err.message);
    }
  };

  const handleExportPdndPrivateKey = async (env: 'test' | 'prod') => {
    if (!confirm('La chiave privata verrà scaricata in chiaro sul tuo dispositivo. Continuare?')) return;
    try {
      const res = await apiFetch(`/settings/pdnd/${env}/private-key`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Errore durante il recupero della chiave privata.');
      }
      const data = await res.json();
      downloadTextFile(`pdnd-${env}-private.pem`, data.privateKey);
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      alert(err.message);
    }
  };

  const handleImportPdndPrivateKeyFile = (env: 'test' | 'prod', file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '').trim();
      if (env === 'test') setSettPdndTestPrivateKey(content);
      else setSettPdndProdPrivateKey(content);
      setSettPdndGeneratedPubKey(null);
    };
    reader.readAsText(file);
  };

  const handleGeneratePdndKeypair = async (env: 'test' | 'prod') => {
    if (!confirm(`Generare una nuova coppia di chiavi RSA per l'ambiente ${env === 'prod' ? 'produzione' : 'collaudo'}? La chiave privata attuale verrà sostituita.`)) return;
    setSettPdndGeneratingKey(env);
    setSettPdndGeneratedPubKey(null);
    try {
      const res = await apiFetch(`/settings/pdnd/${env}/generate-keypair`, { method: 'POST' });
      if (!res.ok) throw new Error('Errore durante la generazione della coppia di chiavi.');
      const data = await res.json();
      setSettPdndGeneratedPubKey({ env, pem: data.publicKey });
      if (env === 'test') setSettPdndTestPrivateKey('••••••••');
      else setSettPdndProdPrivateKey('••••••••');
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      alert(err.message);
    } finally {
      setSettPdndGeneratingKey(null);
    }
  };

  const runVerificaAppIo = async () => {
    if (!verificaCf.trim()) return;
    setVerificaLoading(true);
    setVerificaResult(null);
    try {
      const res = await apiFetch('/io-services/verify-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codiceFiscale: verificaCf }),
      });
      const data = await res.json();
      setVerificaResult(data);
    } catch (err: any) {
      setVerificaResult({ success: false, active: false, message: err.message || 'Errore di connessione' });
    } finally {
      setVerificaLoading(false);
    }
  };

  const fetchCampaigns = async () => {
    setLoadingCampaigns(true);
    setDashboardError(null);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/campaigns`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.status === 401) {
        // Token scaduto/invalido: torna al login invece di fallire in silenzio
        handleLogout();
        return;
      }
      if (!res.ok) throw new Error('Impossibile caricare le campagne.');
      const data = await res.json();
      setCampaigns(data);
    } catch (err: any) {
      setDashboardError(err.message);
    } finally {
      setLoadingCampaigns(false);
    }
  };

  const fetchAuditLogs = async (page = 1, search = '') => {
    setAuditLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('page', String(page));
      params.append('pageSize', String(auditPageSize));
      if (search) {
        params.append('search', search);
      }
      const res = await apiFetch(`/audit-logs?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setAuditLogs(data.data || []);
        setAuditTotal(data.total || 0);
        setAuditPage(data.page || 1);
      }
    } catch (err) {
      console.error('Errore durante il recupero dei log di audit:', err);
    } finally {
      setAuditLoading(false);
    }
  };

  const fetchCampaignDetail = async (id: string) => {
    setLoadingCampaignDetail(true);
    setDetailError(null);
    try {
      const res = await apiFetch(`/campaigns/${id}`);
      if (!res.ok) throw new Error('Impossibile caricare il dettaglio della campagna.');
      const data = await res.json();
      setCampaign(data);
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      setDetailError(err.message);
    } finally {
      setLoadingCampaignDetail(false);
    }
  };

  const fetchFailureGroups = async (campaignId: string) => {
    try {
      const res = await apiFetch(`/campaigns/${campaignId}/failures/by-reason`);
      if (!res.ok) return;
      setFailureGroups(await res.json());
    } catch {
      // Non bloccante.
    }
  };

  const MAX_BULK_RETRY_SIZE = 500;

  const handleRetryGroup = async (group: { errorMessage: string; recipientIds: string[] }) => {
    if (!selectedCampaignId) return;
    if (group.recipientIds.length > MAX_BULK_RETRY_SIZE) {
      alert(`Impossibile rimettere in coda più di ${MAX_BULK_RETRY_SIZE} destinatari in una sola richiesta (richiesti: ${group.recipientIds.length}). Riduci la selezione o contatta l'amministratore per un'operazione batch.`);
      return;
    }
    if (!confirm(`Rimettere in coda ${group.recipientIds.length} destinatari con errore "${group.errorMessage}"?`)) return;
    setRetryingGroup(group.errorMessage);
    try {
      const res = await apiFetch(`/campaigns/${selectedCampaignId}/recipients/retry-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientIds: group.recipientIds }),
      });
      if (!res.ok) throw new Error('Errore durante la rimessa in coda dei destinatari.');
      const result = await res.json();
      alert(`${result.requeued} destinatari rimessi in coda${result.failed.length > 0 ? `, ${result.failed.length} non ritentabili` : ''}`);
      await fetchFailureGroups(selectedCampaignId);
      await fetchCampaignDetail(selectedCampaignId);
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      alert(err.message);
    } finally {
      setRetryingGroup(null);
    }
  };

  const handleCreateCampaign = async (nameVal: string, descVal: string, channelVal: string, configOverrides?: Record<string, any>) => {
    try {
      let channelConfig: Record<string, any> = configOverrides || {};
      
      if (!configOverrides) {
        if (channelVal === 'EMAIL') {
          const activeSmtp = mailConfigs.find(c => c.type === 'EMAIL' && c.active);
          channelConfig = { from: activeSmtp?.fromAddress || '', mailConfigId: activeSmtp?.id };
        } else if (channelVal === 'PEC') {
          const activePec = mailConfigs.find(c => c.type === 'PEC' && c.active);
          channelConfig = { from: activePec?.fromAddress || '', mailConfigId: activePec?.id };
        } else if (channelVal === 'SEND') {
          channelConfig = {};
        }
      }

      const res = await fetch(`${ADMIN_API_BASE}/campaigns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: nameVal,
          description: descVal,
          channelType: channelVal,
          channelConfig,
        }),
      });

      if (!res.ok) throw new Error('Errore durante la creazione della campagna');
      const created = await res.json();
      return created as Campaign;
    } catch (err: any) {
      throw new Error(err.message || 'Errore di connessione API.');
    }
  };

  // Single Send handler
  const handleSingleSendSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!singleCf) {
      alert('Il Codice Fiscale è obbligatorio.');
      return;
    }
    if (!isValidCfOrPiva(singleCf)) {
      alert('Codice Fiscale (16 caratteri) o Partita IVA (11 cifre) non valido.');
      return;
    }
    if (singleChannel === 'APP_IO') {
      const len = wizPlainTextLength(singleBody);
      if (len < APP_IO_MARKDOWN_MIN || len > APP_IO_MARKDOWN_MAX) {
        alert(`Il contenuto per App IO deve essere lungo tra ${APP_IO_MARKDOWN_MIN} e ${APP_IO_MARKDOWN_MAX} caratteri (attuale: ${len}). PagoPA rifiuta messaggi più corti o più lunghi.`);
        return;
      }
    }
    setSingleSending(true);
    setSingleSuccess(null);

    try {
      // Create campaign config
      let customConfig: Record<string, any> | undefined = undefined;
      if (singleChannel === 'APP_IO') {
        customConfig = { ioServiceId: singleAppIoServiceId };
      } else if (singleChannel === 'EMAIL' || singleChannel === 'PEC') {
        customConfig = {
          subject: singleSubject,
          body: singleBody,
        };
        // Bundle default App IO service configuration for co-delivery if available
        const defaultSvc = ioServices.find(s => s.isDefault) || ioServices[0];
        if (defaultSvc) {
          customConfig.appIo = { ioServiceId: defaultSvc.id };
        }
      }

      const nameVal = `Invio Singolo - ${singleCf.toUpperCase()} - ${new Date().toLocaleTimeString('it-IT')}`;
      const campaignObj = await handleCreateCampaign(nameVal, singleBody || singleSubject, singleChannel, customConfig);

      // Create CSV content for 1 recipient
      const csvContent = `codice_fiscale,full_name,email,pec\n"${singleCf.toUpperCase()}","${singleName.replace(/"/g, '""')}","${singleEmail.replace(/"/g, '""')}","${singlePec.replace(/"/g, '""')}"`;
      
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const formData = new FormData();
      formData.append('file', blob, 'single_recipient.csv');

      const uploadRes = await fetch(`${ADMIN_API_BASE}/campaigns/${campaignObj.id}/recipients/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });

      if (!uploadRes.ok) {
        throw new Error('Impossibile associare il destinatario.');
      }

      const launchRes = await fetch(`${ADMIN_API_BASE}/campaigns/${campaignObj.id}/launch`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!launchRes.ok) {
        throw new Error('Errore nel lancio della notifica.');
      }

      setSingleSuccess(campaignObj.id);
      setSingleCf('');
      setSingleName('');
      setSingleEmail('');
      setSinglePec('');
      setSingleSubject('');
      setSingleBody('');
      fetchCampaigns();
    } catch (err: any) {
      alert(err.message || 'Errore durante l\'invio singolo.');
    } finally {
      setSingleSending(false);
    }
  };

  // App IO Service Management handlers — persistiti lato server (IoServiceConfig)
  const handleAddIoService = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSvcNome || !newSvcIdService || !newSvcApiKeyPrimaria) {
      alert('I campi contrassegnati con asterisco sono obbligatori.');
      return;
    }
    try {
      const res = await apiFetch('/io-services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome: newSvcNome,
          idService: newSvcIdService.toUpperCase().trim(),
          descrizione: newSvcDesc,
          apiKeyPrimaria: newSvcApiKeyPrimaria,
          apiKeySecondaria: newSvcApiKeySecondaria,
          codiceCatalogo: newSvcCodiceCatalogo,
          isDefault: newSvcIsDefault || ioServices.length === 0,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Errore durante la creazione del servizio App IO.');
      }
      await fetchIoServices();

      // Reset Form
      setNewSvcNome('');
      setNewSvcIdService('');
      setNewSvcDesc('');
      setNewSvcApiKeyPrimaria('');
      setNewSvcApiKeySecondaria('');
      setNewSvcCodiceCatalogo('');
      setNewSvcIsDefault(false);
      setShowNewSvcForm(false);
      alert('Servizio creato con successo!');
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      alert(err.message || 'Errore durante la creazione del servizio App IO.');
    }
  };

  const handleUpdateIoService = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingIoService) return;
    if (!editingIoService.nome || !editingIoService.idService || !editingIoService.apiKeyPrimaria) {
      alert('I campi contrassegnati con asterisco sono obbligatori.');
      return;
    }
    try {
      const res = await apiFetch(`/io-services/${editingIoService.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome: editingIoService.nome,
          idService: editingIoService.idService.toUpperCase().trim(),
          descrizione: editingIoService.descrizione,
          apiKeyPrimaria: editingIoService.apiKeyPrimaria,
          apiKeySecondaria: editingIoService.apiKeySecondaria,
          codiceCatalogo: editingIoService.codiceCatalogo,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Errore durante la modifica del servizio App IO.');
      }
      await fetchIoServices();
      setEditingIoService(null);
      alert('Servizio modificato con successo!');
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      alert(err.message || 'Errore durante la modifica del servizio App IO.');
    }
  };

  const handleSetDefaultIoService = async (id: string) => {
    await fetch(`${ADMIN_API_BASE}/io-services/${id}/default`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
    });
    await fetchIoServices();
  };

  const handleDeleteIoService = async (id: string) => {
    const svcToDelete = ioServices.find(s => s.id === id);
    if (!svcToDelete) return;
    if (!confirm(`Sei sicuro di voler eliminare il servizio "${svcToDelete.nome}"?`)) {
      return;
    }
    const res = await fetch(`${ADMIN_API_BASE}/io-services/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 204) {
      const body = await res.json().catch(() => null);
      alert(body?.message || 'Impossibile eliminare il servizio.');
      return;
    }
    await fetchIoServices();
  };

  const handleTestIoService = async (id: string) => {
    if (!ioTestCf) {
      alert('Inserisci un codice fiscale di test.');
      return;
    }
    setIoTestBusyId(id);
    setIoTestMsg(null);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/io-services/${id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ codiceFiscale: ioTestCf.toUpperCase().trim() }),
      });
      let errMsg = 'Test fallito';
      let successMsg = 'Messaggio di test inviato con successo.';
      let isError = false;
      try {
        const data = await res.json();
        if (data.success === false) {
          errMsg = data.message || errMsg;
          isError = true;
        } else {
          successMsg = data.message || successMsg;
        }
      } catch {
        errMsg = `Errore di rete/server (HTTP ${res.status})`;
        isError = true;
      }
      if (!res.ok || isError) throw new Error(isError ? errMsg : errMsg);
      setIoTestMsg({ id, text: successMsg, error: false });
    } catch (err: any) {
      setIoTestMsg({ id, text: err.message, error: true });
    } finally {
      setIoTestBusyId(null);
    }
  };

  // Settings Save handler
  const buildSettingsPayload = () => ({
    'brand.name': settEntityName,
    'brand.subtitle': settSubtitle,
    'brand.logo': settLogoValue,
    'brand.favicon': settFaviconValue,
    // SMTP and PEC are saved via their own endpoints; App IO via /io-services
    'send.environment': settSendEnvironment,
    'send.test.baseUrl': settSendTestBaseUrl,
    'send.test.apiKey': settSendTestApiKey,
    'send.test.purposeId': settSendTestPurposeId,
    'send.test.group': settSendTestGroup,
    'send.senderTaxId': settSendSenderTaxId,
    'send.entityType': settSendEntityType,
    'send.enabledTaxonomyCodes': JSON.stringify(settSendTaxonomies),
    'send.prod.baseUrl': settSendProdBaseUrl,
    'send.prod.apiKey': settSendProdApiKey,
    'send.prod.purposeId': settSendProdPurposeId,
    'send.prod.group': settSendProdGroup,
    'postal.baseUrl': settPostalBaseUrl,
    'postal.user': settPostalUser,
    'postal.password': settPostalPassword,
    'postal.group': settPostalGroup,
    'postal.centroDiCosto': settPostalCentroDiCosto,
    'postal.mittente.denominazione1': settPostalMittenteDenominazione1,
    'postal.mittente.indirizzo1': settPostalMittenteIndirizzo1,
    'postal.mittente.cap': settPostalMittenteCap,
    'postal.mittente.citta': settPostalMittenteCitta,
    'postal.mittente.provincia': settPostalMittenteProvincia,
    'pdnd.test.tokenUrl': settPdndTestTokenUrl,
    'pdnd.test.audience': settPdndTestAudience,
    'pdnd.test.clientId': settPdndTestClientId,
    'pdnd.test.kid': settPdndTestKid,
    'pdnd.test.privateKey': settPdndTestPrivateKey,
    'pdnd.prod.tokenUrl': settPdndProdTokenUrl,
    'pdnd.prod.audience': settPdndProdAudience,
    'pdnd.prod.clientId': settPdndProdClientId,
    'pdnd.prod.kid': settPdndProdKid,
    'pdnd.prod.privateKey': settPdndProdPrivateKey,
    'inad.test.purposeId': settInadTestPurposeId,
    'inad.prod.purposeId': settInadProdPurposeId,
    'inipec.test.purposeId': settInipecTestPurposeId,
    'inipec.prod.purposeId': settInipecProdPurposeId,
    'protocollo.provider': settProtoProvider,
    'protocollo.baseUrl': settProtoUrl,
    'protocollo.codiceEnte': settProtoCodiceEnte,
    'protocollo.username': settProtoUser,
    'protocollo.password': settProtoPass,
    'protocollo.codiceTitolario': settProtoCodiceTitolario,
    'protocollo.codiceAmministrazione': settProtoCodiceAmministrazione,
    'protocollo.unitaOrganizzativa': settProtoUnitaOrganizzativa,
    'protocollo.mittenteDenominazione': settProtoMittenteDenominazione,
    'retention.maxDays': Number(settRetentionDays) || 90,
    'oidc.issuer': settOidcIssuer,
    'oidc.audience': settOidcAudience,
    'oidc.jwksUri': settOidcJwksUri,
    'oidc.clientId': settOidcClientId,
    'oidc.clientSecret': settOidcClientSecret,
    'oidc.logoutUrl': settOidcLogoutUrl,
  });

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    // Canali non ancora migrati al backend: restano su localStorage
    // (App IO ora persistito lato server via /io-services, niente più localStorage)
    localStorage.setItem('sett_postal_provider', settPostalProvider);
    localStorage.setItem('sett_postal_key', settPostalKey);
    localStorage.setItem('sett_postal_url', settPostalUrl);

    try {
      const res = await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: buildSettingsPayload() }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        setSettingsSavedMessage({ text: `Errore salvataggio: ${err.message ?? res.status}`, error: true });
      } else {
        setSettingsSavedMessage({ text: 'Impostazioni salvate con successo!', error: false });
      }
    } catch (err) {
      if (err instanceof ApiAuthError) return;
      setSettingsSavedMessage({ text: 'Errore di rete durante il salvataggio.', error: true });
    }
    setTimeout(() => setSettingsSavedMessage(null), 3000);
  };

  const runPdndTest = async (
    endpoint: string,
    env: 'test' | 'prod',
    setTesting: (v: 'test' | 'prod' | null) => void,
    setResult: (v: { env: 'test' | 'prod'; ok: boolean; message: string } | null) => void,
  ) => {
    setTesting(env);
    setResult(null);
    try {
      // Salva prima le impostazioni correnti: il test legge le credenziali dal DB.
      const saveRes = await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: buildSettingsPayload() }),
      });
      if (!saveRes.ok) {
        const err = (await saveRes.json()) as { message?: string };
        setResult({ env, ok: false, message: `Errore salvataggio: ${err.message ?? saveRes.status}` });
        return;
      }

      const res = await apiFetch(endpoint, { method: 'POST' });
      const data = await res.json() as { success: boolean; message: string };
      setResult({ env, ok: data.success, message: data.message });
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      setResult({ env, ok: false, message: err.message || 'Errore di rete durante il test.' });
    } finally {
      setTesting(null);
    }
  };

  const handleValidatePdndClient = (env: 'test' | 'prod') =>
    runPdndTest(`/settings/pdnd/${env}/validate-client`, env, setSettPdndTesting, setSettPdndTestResult);

  const handleTestSendConnection = (env: 'test' | 'prod') =>
    runPdndTest(`/settings/send/${env}/test-connection`, env, setSettSendTesting, setSettSendTestResult);

  const handleLoadSendGroups = async (env: 'test' | 'prod') => {
    setSettSendGroupsLoading(env);
    setSettSendGroupsError(prev => ({ ...prev, [env]: null }));
    try {
      // Salva prima le impostazioni correnti: l'endpoint legge baseUrl/apiKey dal DB.
      const saveRes = await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: buildSettingsPayload() }),
      });
      if (!saveRes.ok) {
        const err = (await saveRes.json()) as { message?: string };
        setSettSendGroupsError(prev => ({ ...prev, [env]: `Errore salvataggio: ${err.message ?? saveRes.status}` }));
        return;
      }
      const res = await apiFetch(`/settings/send/${env}/groups`);
      const data = await res.json() as { groups: Array<{ id: string; name: string; description: string }>; error?: string };
      setSettSendGroups(prev => ({ ...prev, [env]: data.groups }));
      if (data.error) setSettSendGroupsError(prev => ({ ...prev, [env]: data.error! }));
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      setSettSendGroupsError(prev => ({ ...prev, [env]: err.message || 'Errore di rete durante il caricamento dei gruppi.' }));
    } finally {
      setSettSendGroupsLoading(null);
    }
  };

  const handleTestInadConnection = (env: 'test' | 'prod') =>
    runPdndTest(`/settings/inad/${env}/test-connection`, env, setSettInadTesting, setSettInadTestResult);

  const handleTestInipecConnection = (env: 'test' | 'prod') =>
    runPdndTest(`/settings/inipec/${env}/test-connection`, env, setSettInipecTesting, setSettInipecTestResult);

  const fetchEngines = async () => {
    if (!token) return;
    setLoadingEngines(true);
    setEnginesError(null);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/engines`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEngines(data.engines || []);
      const stageRes = await fetch(`${ADMIN_API_BASE}/engines/send/stage-counts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (stageRes.ok) setSendStageCounts(await stageRes.json());
    } catch (err: any) {
      setEnginesError(`Errore nel caricamento dei motori: ${err.message}`);
    } finally {
      setLoadingEngines(false);
    }
  };

  const handleEngineAction = async (channel: string, action: 'pause' | 'resume') => {
    if (!token) return;
    setLoadingEngines(true);
    setEnginesError(null);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/engines/${channel.toLowerCase()}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || `Errore ${action}`);
      }
      await fetchEngines();
    } catch (err: any) {
      setEnginesError(`Errore: ${err.message}`);
      setLoadingEngines(false);
    }
  };

  const handleViewEngineJobs = async (channel: string) => {
    setEngineJobsChannel(channel);
    setExpandedJobLogs(null);
    const res = await fetch(`${ADMIN_API_BASE}/engines/${channel.toLowerCase()}/jobs?status=failed&limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    setEngineJobs(data.jobs || []);
  };

  const handleViewJobLogs = async (channel: string, jobId: string) => {
    if (expandedJobLogs?.jobId === jobId) {
      setExpandedJobLogs(null);
      return;
    }
    setLoadingJobLogs(true);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/engines/${channel.toLowerCase()}/jobs/${jobId}/logs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setExpandedJobLogs({ jobId, logs: data.logs || [] });
    } finally {
      setLoadingJobLogs(false);
    }
  };

  const handleUploadBranding = async (kind: 'logo' | 'favicon', file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${ADMIN_API_BASE}/settings/branding/${kind}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (res.ok) {
      // Allinea il campo URL/filename al file appena caricato, così un
      // successivo "Salva impostazioni" non sovrascrive l'upload
      const { filename } = (await res.json()) as { filename: string };
      if (kind === 'logo') setSettLogoValue(filename);
      else setSettFaviconValue(filename);
    }
    setSettingsSavedMessage(res.ok
      ? { text: `${kind === 'logo' ? 'Logo' : 'Favicon'} caricato.`, error: false }
      : { text: 'Errore upload.', error: true });
    setTimeout(() => setSettingsSavedMessage(null), 3000);
  };

  const fetchMailConfigs = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${ADMIN_API_BASE}/mail-configs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setMailConfigs(data.configs || []);
      }
    } catch (err) {
      console.error("Errore caricamento mail-configs:", err);
    }
  };

  const fetchTemplates = async () => {
    const res = await fetch(`${ADMIN_API_BASE}/templates`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    setTemplates(data.templates || []);
  };

  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTemplate) return;
    const method = editingTemplate.id ? 'PUT' : 'POST';
    const url = editingTemplate.id ? `${ADMIN_API_BASE}/templates/${editingTemplate.id}` : `${ADMIN_API_BASE}/templates`;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(editingTemplate),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      alert(body?.message || 'Errore durante il salvataggio del template');
      return;
    }
    setEditingTemplate(null);
    fetchTemplates();
  };

  const handleDeleteTemplate = async (id: string) => {
    if (!confirm('Eliminare questo template?')) return;
    await fetch(`${ADMIN_API_BASE}/templates/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    fetchTemplates();
  };

  const fetchIoServices = async () => {
    if (!token) return;
    try {
      const res = await apiFetch('/io-services');
      if (res.ok) {
        const data = await res.json();
        setIoServices(data.configs || []);
      }
    } catch (err) {
      if (err instanceof ApiAuthError) return;
      console.error("Errore caricamento io-services:", err);
    }
  };

  const handleSaveMailConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMailConfig || !token) return;
    setMailConfigBusyId(editingMailConfig.id || 'new');
    setMailConfigMsg(null);

    const isEdit = !!editingMailConfig.id;

    // UpdateMailConfigDto (backend) vieta esplicitamente la proprietà "type"
    // (non modificabile dopo la creazione) e il ValidationPipe globale ha
    // forbidNonWhitelisted:true: includerla in una PUT causa 400 Bad Request
    // "property type should not exist". Va inviata solo in creazione (POST).
    const payload = {
      ...(isEdit ? {} : { type: editingMailConfig.type }),
      name: editingMailConfig.name,
      host: editingMailConfig.host,
      port: Number(editingMailConfig.port),
      secure: editingMailConfig.secure,
      authEnabled: editingMailConfig.authEnabled,
      username: editingMailConfig.username,
      password: editingMailConfig.password,
      fromAddress: editingMailConfig.fromAddress,
      batchSize: Number(editingMailConfig.batchSize),
      batchIntervalSeconds: Number(editingMailConfig.batchIntervalSeconds),
    };

    try {
      const url = isEdit ? `${ADMIN_API_BASE}/mail-configs/${editingMailConfig.id}` : `${ADMIN_API_BASE}/mail-configs`;
      const method = isEdit ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Errore durante il salvataggio');
      }

      setMailConfigMsg({ text: 'Configurazione salvata con successo!', error: false });
      setEditingMailConfig(null);
      fetchMailConfigs();
    } catch (err: any) {
      setMailConfigMsg({ text: err.message || 'Errore di rete', error: true });
    } finally {
      setMailConfigBusyId(null);
    }
  };

  const handleDeleteMailConfig = async (id: string, name: string) => {
    if (!token) return;
    if (!confirm(`Sei sicuro di voler eliminare la configurazione "${name}"?`)) return;

    setMailConfigBusyId(id);
    setMailConfigMsg(null);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/mail-configs/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Errore durante l\'eliminazione');
      }

      setMailConfigMsg({ text: 'Configurazione eliminata.', error: false });
      fetchMailConfigs();
    } catch (err: any) {
      setMailConfigMsg({ text: err.message || 'Errore di rete', error: true });
    } finally {
      setMailConfigBusyId(null);
    }
  };

  const handleToggleMailConfigActive = async (id: string, currentActive: boolean) => {
    if (!token) return;
    setMailConfigBusyId(id);
    setMailConfigMsg(null);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/mail-configs/${id}/active`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ active: !currentActive }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Errore attivazione');
      }

      setMailConfigMsg({ text: !currentActive ? 'Configurazione attivata.' : 'Configurazione disattivata.', error: false });
      fetchMailConfigs();
    } catch (err: any) {
      setMailConfigMsg({ text: err.message || 'Errore di rete', error: true });
    } finally {
      setMailConfigBusyId(null);
    }
  };

  const handleTestMailConfig = async (e: React.FormEvent, id: string) => {
    e.preventDefault();
    if (!token || !mailConfigTestTo) return;
    setMailConfigBusyId(id);
    setMailConfigMsg(null);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/mail-configs/${id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to: mailConfigTestTo }),
      });

      let errMsg = 'Errore invio email test';
      let isError = false;
      try {
        const data = await res.json();
        if (data.success === false) {
          errMsg = data.message || errMsg;
          isError = true;
        }
      } catch {
        errMsg = `Errore di rete/server (HTTP ${res.status})`;
        isError = true;
      }

      if (!res.ok || isError) {
        throw new Error(errMsg);
      }

      setMailConfigMsg({ text: 'Messaggio di test inviato con successo!', error: false });
      fetchMailConfigs();
    } catch (err: any) {
      setMailConfigMsg({ text: err.message || 'Errore di rete', error: true });
    } finally {
      setMailConfigBusyId(null);
    }
  };

  const renderMailConfigTab = (type: 'EMAIL' | 'PEC') => {
    const list = mailConfigs.filter((c) => c.type === type);
    const label = type === 'EMAIL' ? 'SMTP' : 'PEC';
    const editing = editingMailConfig && editingMailConfig.type === type ? editingMailConfig : null;

    return (
      <div className="d-flex flex-column gap-4">
        {mailConfigMsg && (
          <div className={`alert ${mailConfigMsg.error ? 'alert-danger' : 'alert-success'} d-flex align-items-center gap-2 mb-0`}>
            <i className={`fas ${mailConfigMsg.error ? 'fa-triangle-exclamation' : 'fa-check-circle'}`}></i>
            <div>{mailConfigMsg.text}</div>
          </div>
        )}

        {!editing && (
          <div>
            <div className="d-flex justify-content-between align-items-center mb-3">
              <h5 className="mb-0 text-dark fw-bold small text-uppercase tracking-wider">
                Server {label} Configurati ({list.length})
              </h5>
              <button
                type="button"
                className="btn btn-sm btn-primary px-3 d-flex align-items-center gap-1"
                onClick={() => setEditingMailConfig({ ...EMPTY_MAIL_CONFIG, type })}
              >
                <i className="fas fa-plus"></i> Nuovo Server {label}
              </button>
            </div>

            {list.length === 0 ? (
              <div className="text-center py-4 border rounded bg-white text-muted">
                <i className="fas fa-server fa-2x mb-2 text-secondary"></i>
                <p className="mb-0">Nessun server {label} configurato.</p>
              </div>
            ) : (
              <div className="d-flex flex-column gap-3">
                {list.map((c) => (
                  <div key={c.id} className={`card border shadow-sm ${c.active ? 'border-success' : 'border-light'}`}>
                    <div className="card-body p-3">
                      <div className="d-flex justify-content-between align-items-start flex-wrap gap-3">
                        {/* Left: Info */}
                        <div className="d-flex align-items-start gap-3 flex-grow-1" style={{ minWidth: 0 }}>
                          <div className={`rounded-circle d-flex align-items-center justify-content-center text-white flex-shrink-0 ${c.active ? 'bg-success' : 'bg-secondary'}`} style={{ width: 40, height: 40 }}>
                            <i className={`fas ${type === 'EMAIL' ? 'fa-envelope' : 'fa-envelope-open-text'}`}></i>
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div className="fw-bold text-dark d-flex align-items-center gap-2">
                              {c.name}
                              {c.secure && <span className="badge bg-info" style={{ fontSize: '0.65rem' }}>SSL/TLS</span>}
                              <span className={`badge ${c.active ? 'bg-success' : 'bg-secondary'}`} style={{ fontSize: '0.65rem' }}>
                                {c.active ? 'Attivo' : 'Inattivo'}
                              </span>
                            </div>
                            <div className="text-muted small mt-1">
                              <i className="fas fa-server me-1"></i>
                              <code>{c.host}:{c.port}</code>
                              <span className="mx-2">&middot;</span>
                              <i className="fas fa-at me-1"></i>
                              {c.fromAddress}
                            </div>
                            <div className="text-muted small mt-1">
                              <i className="fas fa-tachometer-alt me-1"></i>
                              {c.batchSize} invii / {c.batchIntervalSeconds}s
                              {c.testedAt && (
                                <span className="ms-3 text-success">
                                  <i className="fas fa-check-circle me-1"></i>
                                  Testato il {new Date(c.testedAt).toLocaleDateString('it-IT')}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Right: Actions */}
                        <div className="d-flex flex-column gap-2 flex-shrink-0">
                          <button
                            type="button"
                            className={`btn btn-sm ${c.active ? 'btn-outline-success' : 'btn-outline-secondary'} d-flex align-items-center gap-1`}
                            onClick={() => handleToggleMailConfigActive(c.id, c.active)}
                            disabled={mailConfigBusyId === c.id}
                          >
                            <i className={`fas fa-toggle-${c.active ? 'on' : 'off'}`}></i>
                            {c.active ? 'Disattiva' : 'Attiva'}
                          </button>
                          <div className="d-flex gap-1">
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-primary px-2"
                              onClick={() => setEditingMailConfig(c)}
                              title="Modifica"
                            >
                              <i className="fas fa-edit me-1"></i>Modifica
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-danger px-2"
                              onClick={() => handleDeleteMailConfig(c.id, c.name)}
                              disabled={mailConfigBusyId === c.id}
                              title="Elimina"
                            >
                              <i className="fas fa-trash"></i>
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Test row */}
                      <div className="mt-3 pt-2 border-top">
                        <form onSubmit={(e) => handleTestMailConfig(e, c.id)} className="d-flex align-items-center gap-2">
                          <span className="text-muted small fw-semibold">Test invio:</span>
                          <input
                            type="email"
                            className="form-control form-control-sm"
                            placeholder="destinatario@test.it"
                            required
                            value={mailConfigTestTo}
                            onChange={(e) => setMailConfigTestTo(e.target.value)}
                            style={{ maxWidth: 220 }}
                          />
                          <button
                            type="submit"
                            className="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                            disabled={mailConfigBusyId === c.id || !mailConfigTestTo}
                          >
                            <i className="fas fa-paper-plane"></i> Invia Test
                          </button>
                        </form>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}



        {editing && (
          <form onSubmit={handleSaveMailConfig} className="border rounded bg-white p-4 shadow-sm">
            <h5 className="text-dark fw-bold mb-4">
              {editing.id ? `Modifica Server ${label}` : `Nuovo Server ${label}`}
            </h5>

            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label small fw-bold">Nome Configurazione</label>
                <input
                  type="text"
                  className="form-control form-control-sm"
                  required
                  placeholder="Es. SMTP Istituzionale"
                  value={editing.name || ''}
                  onChange={(e) => setEditingMailConfig({ ...editing, name: e.target.value })}
                />
              </div>

              <div className="col-md-6">
                <label className="form-label small fw-bold">Mittente (From Address)</label>
                <input
                  type="email"
                  className="form-control form-control-sm"
                  required
                  placeholder="noreply@ente.it"
                  value={editing.fromAddress || ''}
                  onChange={(e) => setEditingMailConfig({ ...editing, fromAddress: e.target.value })}
                />
              </div>

              <div className="col-md-8">
                <label className="form-label small fw-bold">Host Server</label>
                <input
                  type="text"
                  className="form-control form-control-sm"
                  required
                  placeholder="smtp.ente.it"
                  value={editing.host || ''}
                  onChange={(e) => setEditingMailConfig({ ...editing, host: e.target.value })}
                />
              </div>

              <div className="col-md-4">
                <label className="form-label small fw-bold">Porta</label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  required
                  value={editing.port || 587}
                  onChange={(e) => setEditingMailConfig({ ...editing, port: Number(e.target.value) })}
                />
              </div>

              <div className="col-md-6">
                <label className="form-label small fw-semibold text-muted">Username Autenticazione</label>
                <input
                  type="text"
                  className="form-control form-control-sm"
                  placeholder="Username (se richiesto)"
                  value={editing.username || ''}
                  onChange={(e) => setEditingMailConfig({ ...editing, username: e.target.value })}
                />
              </div>

              <div className="col-md-6">
                <label className="form-label small fw-semibold text-muted">Password Autenticazione</label>
                <input
                  type="password"
                  className="form-control form-control-sm"
                  placeholder={editing.id ? '••••••••' : 'Password (se richiesta)'}
                  value={editing.password || ''}
                  onChange={(e) => setEditingMailConfig({ ...editing, password: e.target.value })}
                />
              </div>

              <div className="col-md-6">
                <div className="form-check mt-2">
                  <input
                    type="checkbox"
                    className="form-check-input"
                    id="chkSecure"
                    checked={editing.secure || false}
                    onChange={(e) => setEditingMailConfig({ ...editing, secure: e.target.checked })}
                  />
                  <label className="form-check-label small" htmlFor="chkSecure">
                    Connessione sicura (SSL/TLS implicito)
                  </label>
                </div>
              </div>

              <div className="col-md-6">
                <div className="form-check mt-2">
                  <input
                    type="checkbox"
                    className="form-check-input"
                    id="chkAuth"
                    checked={editing.authEnabled ?? true}
                    onChange={(e) => setEditingMailConfig({ ...editing, authEnabled: e.target.checked })}
                  />
                  <label className="form-check-label small" htmlFor="chkAuth">
                    Abilita Autenticazione
                  </label>
                </div>
              </div>

              <div className="col-12 border-top pt-3 mt-4">
                <h6 className="text-secondary fw-semibold small text-uppercase mb-3">Limiti di Invio (Throttling)</h6>
                <div className="row g-3">
                  <div className="col-md-6">
                    <label className="form-label small">Dimensione Batch (Max Messaggi)</label>
                    <input
                      type="number"
                      className="form-control form-control-sm"
                      required
                      min={1}
                      value={editing.batchSize || 100}
                      onChange={(e) => setEditingMailConfig({ ...editing, batchSize: Number(e.target.value) })}
                    />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label small">Finestra Temporale (Secondi)</label>
                    <input
                      type="number"
                      className="form-control form-control-sm"
                      required
                      min={1}
                      value={editing.batchIntervalSeconds || 60}
                      onChange={(e) => setEditingMailConfig({ ...editing, batchIntervalSeconds: Number(e.target.value) })}
                    />
                  </div>
                </div>
              </div>

              <div className="col-12 d-flex justify-content-end gap-2 mt-4">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary px-3"
                  onClick={() => setEditingMailConfig(null)}
                  disabled={mailConfigBusyId !== null}
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  className="btn btn-sm btn-primary px-4"
                  disabled={mailConfigBusyId !== null}
                >
                  {mailConfigBusyId !== null ? (
                    <><i className="fas fa-spinner fa-spin me-1"></i>Salvataggio...</>
                  ) : (
                    'Salva'
                  )}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    );
  };


  const handleExportDownloadReport = async () => {
    if (!campaign) return;
    try {
      const res = await apiFetch(`/campaigns/${campaign.id}/export-download-report.csv`);
      if (!res.ok) {
        alert('Errore durante il download del report');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `report_download_campagna_${campaign.id.slice(0, 8)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      alert('Errore durante il download del report');
    }
  };

  const parseCsvFile = (file: File, hasHeaders: boolean) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
      if (lines.length === 0) return;

      const parseCsvLine = (line: string) => {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if ((char === ',' || char === ';') && !inQuotes) {
            result.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        result.push(current.trim());
        return result.map(col => col.replace(/^"(.*)"$/, '$1'));
      };

      let headers: string[] = [];
      let parsedRows: Record<string, string>[] = [];

      if (hasHeaders) {
        headers = parseCsvLine(lines[0]);
        parsedRows = lines.slice(1).map(line => {
          const cols = parseCsvLine(line);
          const obj: Record<string, string> = {};
          headers.forEach((h, idx) => {
            obj[h] = cols[idx] || '';
          });
          if (cols.length !== headers.length) {
            obj.__colMismatch = `Numero di colonne non corrisponde all'intestazione (attese ${headers.length}, trovate ${cols.length}): probabile virgola non quotata in un campo (es. nominativo/ragione sociale) — verificare il file sorgente`;
          }
          return obj;
        });
      } else {
        const firstLineCols = parseCsvLine(lines[0]);
        headers = firstLineCols.map((_, idx) => `Colonna ${idx + 1}`);
        parsedRows = lines.map(line => {
          const cols = parseCsvLine(line);
          const obj: Record<string, string> = {};
          headers.forEach((h, idx) => {
            obj[h] = cols[idx] || '';
          });
          return obj;
        });
      }

      setWizCsvHeaders(headers);
      setWizCsvRows(parsedRows);

      // Guess mapping
      const newMapping = {
        codice_fiscale: '',
        full_name: '',
        full_name_2: '',
        email: '',
        pec: '',
        subject: '',
      };
      headers.forEach(h => {
        const hLower = h.toLowerCase().replace(/[\s_-]/g, '');
        if (hLower === 'cf' || hLower === 'codicefiscale') newMapping.codice_fiscale = h;
        else if (hLower === 'cognome' || hLower === 'nominativo' || hLower === 'fullname' || hLower === 'nomecompleto' || hLower === 'nome') {
          if (!newMapping.full_name) {
            newMapping.full_name = h;
          } else {
            newMapping.full_name_2 = h;
          }
        }
        else if (hLower === 'email' || hLower === 'mail') newMapping.email = h;
        else if (hLower === 'pec') newMapping.pec = h;
      });

      // Se stiamo duplicando/riprendendo una campagna e il CSV ricaricato ha le
      // stesse colonne, riapplica la mappatura salvata invece dell'euristica
      // generica (che potrebbe indovinare male o non indovinare affatto colonne
      // con nomi non standard). Se anche una sola colonna referenziata non è
      // presente nel nuovo CSV, non forziamo nulla: resta l'euristica/vuoto.
      if (wizPendingMapping) {
        const pendingCols = [
          wizPendingMapping.codice_fiscale,
          wizPendingMapping.full_name,
          wizPendingMapping.full_name_2,
          wizPendingMapping.email,
          wizPendingMapping.pec,
        ].filter(Boolean);
        if (pendingCols.every(col => headers.includes(col))) {
          Object.assign(newMapping, wizPendingMapping);
        }
        setWizPendingMapping(null);
      }
      setWizMapping(newMapping);

      if (wizPendingAttachments && wizPendingAttachments.every(a => headers.includes(a.key))) {
        setWizAttachments(wizPendingAttachments);
      } else {
        setWizAttachments([]);
      }
      setWizPendingAttachments(null);
    };
    reader.readAsText(file);
  };

  const handleWizCsvChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setWizCsvFile(file);
    parseCsvFile(file, wizCsvHasHeaders);
  };

  const handleWizMappingChange = (field: string, value: string) => {
    setWizMapping(prev => ({ ...prev, [field]: value }));
  };

  const handleWizValidation = () => {
    const errors: Array<{ row: number; field: string; val: string; err: string }> = [];
    const warnings: Array<{ row: number; field: string; val: string; warn: string }> = [];
    const valid: Record<string, string>[] = [];

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const cfRegex = /^[A-Z0-9]{16}$/i;
    const pivaRegex = /^\d{11}$/;
    // Pattern reale del Codice Fiscale (non un generico alfanumerico a 16
    // caratteri): App IO/PagoPA rifiuta con HTTP 400 qualunque valore che non
    // rispetti questo formato, incluse le Partite IVA — che il controllo
    // generico sotto accetta come alternativa valida per gli altri canali.
    const cfAppIoRegex = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/i;

    const cfField = wizMapping.codice_fiscale;
    const emailField = wizMapping.email;
    const pecField = wizMapping.pec;

    const isEmailMandatory = wizChannel === 'EMAIL';
    const isPecMandatory = wizChannel === 'PEC';
    // Anche quando App IO è co-consegna secondaria (non canale primario) il CF
    // deve rispettare il formato stretto: PagoPA rifiuta l'invio con HTTP 400
    // se il CF non è valido, e senza questo controllo l'errore emerge solo al
    // momento della spedizione invece che in fase di validazione import.
    const isCfMandatory = wizChannel === 'APP_IO' || wizChannel === 'SEND' || wizAppIoInvolved;

    wizCsvRows.forEach((row, idx) => {
      let isRowValid = true;
      const rowNum = idx + 1;

      // Riga con numero di colonne diverso dall'intestazione (es. virgola non
      // quotata nel nominativo che shifta tutti i campi successivi): segnala
      // subito la causa reale invece di errori fuorvianti sui campi shiftati.
      if (row.__colMismatch) {
        errors.push({ row: rowNum, field: 'Struttura riga', val: '', err: row.__colMismatch });
        isRowValid = false;
      }

      // Validate email
      if (isEmailMandatory && !emailField) {
        errors.push({ row: rowNum, field: 'Mappatura', val: '', err: 'La colonna Email deve essere mappata per il canale EMAIL' });
        isRowValid = false;
      } else if (emailField && row[emailField]) {
        const valClean = row[emailField].trim();
        if (valClean && !emailRegex.test(valClean)) {
          errors.push({ row: rowNum, field: 'Email', val: row[emailField], err: 'Formato e-mail non valido' });
          isRowValid = false;
        }
      } else if (isEmailMandatory && !row[emailField]) {
        errors.push({ row: rowNum, field: 'Email', val: '', err: 'Indirizzo e-mail mancante' });
        isRowValid = false;
      }

      // Validate PEC
      if (isPecMandatory && !pecField) {
        errors.push({ row: rowNum, field: 'Mappatura', val: '', err: 'La colonna PEC deve essere mappata per il canale PEC' });
        isRowValid = false;
      } else if (pecField && row[pecField]) {
        const valClean = row[pecField].trim();
        if (valClean && !emailRegex.test(valClean)) {
          errors.push({ row: rowNum, field: 'PEC', val: row[pecField], err: 'Formato PEC non valido' });
          isRowValid = false;
        }
      } else if (isPecMandatory && !row[pecField]) {
        errors.push({ row: rowNum, field: 'PEC', val: '', err: 'Indirizzo PEC mancante' });
        isRowValid = false;
      }

      // Validate Codice Fiscale / Partita IVA
      if (isCfMandatory && !cfField) {
        errors.push({ row: rowNum, field: 'Mappatura', val: '', err: 'La colonna Codice Fiscale / P.IVA deve essere mappata' });
        isRowValid = false;
      } else if (cfField && row[cfField]) {
        const valClean = row[cfField].trim().replace(/\s/g, '');
        const isCf = cfRegex.test(valClean);
        const isPiva = pivaRegex.test(valClean);
        if (wizAppIoInvolved && !cfAppIoRegex.test(valClean)) {
          // App IO accetta solo CF di persona fisica: una P.IVA (o qualunque
          // valore fuori pattern) qui va scartata subito, altrimenti l'errore
          // emerge solo alla spedizione reale (HTTP 400 da PagoPA) dopo aver
          // già consumato un tentativo.
          errors.push({ row: rowNum, field: 'Codice Fiscale (App IO)', val: row[cfField], err: 'Codice Fiscale non valido per App IO: richiesto un CF di persona fisica, non una Partita IVA o un valore fuori formato' });
          isRowValid = false;
        } else if (!isCf && !isPiva) {
          if (isCfMandatory) {
            // Only block when CF/P.IVA is strictly required (App IO, SEND)
            errors.push({ row: rowNum, field: 'Codice Fiscale / P.IVA', val: row[cfField], err: 'Codice Fiscale (16 caratteri) o P.IVA (11 cifre) non valida' });
            isRowValid = false;
          } else {
            // Warn only — include the row anyway
            warnings.push({ row: rowNum, field: 'Codice Fiscale / P.IVA', val: row[cfField], warn: 'Formato non standard (atteso CF a 16 caratteri o P.IVA a 11 cifre) — il record verrà incluso' });
          }
        }
      } else if (isCfMandatory && !row[cfField]) {
        errors.push({ row: rowNum, field: 'Codice Fiscale', val: '', err: 'Codice Fiscale o P.IVA mancante' });
        isRowValid = false;
      }

      if (isRowValid) {
        valid.push(row);
      }
    });

    setWizValidationErrors(errors);
    setWizValidationWarnings(warnings);
    setWizValidRows(valid);
    setWizPreviewIndex(0);

    if (errors.length === 0) {
      setWizStep(4);
    }
  };

  const downloadErrorsCsv = () => {
    if (wizValidationErrors.length === 0) return;
    const errorRows = wizCsvRows.filter((_, idx) => {
      return wizValidationErrors.some(err => err.row === idx + 1);
    });
    const headers = [...wizCsvHeaders, 'Motivo Errore'];
    const lines = [headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(',')];
    errorRows.forEach((row) => {
      const realIndex = wizCsvRows.indexOf(row);
      const rowNum = realIndex + 1;
      const rowErrors = wizValidationErrors
        .filter(err => err.row === rowNum)
        .map(err => `${err.field}: ${err.err}`)
        .join('; ');
      const lineValues = wizCsvHeaders.map(h => row[h] || '');
      lineValues.push(rowErrors);
      const line = lineValues.map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
      lines.push(line);
    });
    const csvContent = lines.join('\n');
    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    const baseName = (wizCsvFile?.name || 'campagna').replace(/\.csv$/i, '');
    link.setAttribute('download', `errori_validazione_${baseName}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const resetWizard = () => {
    setWizCampaignId(null);
    setWizStep(1);
    setWizName('');
    setWizDesc('');
    setWizSubject('');
    setWizProtocolla(false);
    setWizTaxonomyCode('');
    setWizPhysicalCommunicationType('AR_REGISTERED_LETTER');
    setWizBody('');
    setWizCsvFile(null);
    setWizCsvHeaders([]);
    setWizCsvRows([]);
    setWizPdfFiles([]);
    setWizCsvHasHeaders(true);
    setWizMapping({
      codice_fiscale: '',
      full_name: '',
      full_name_2: '',
      email: '',
      pec: '',
      subject: '',
    });
    setWizAttachments([]);
    setWizValidationErrors([]);
    setWizValidationWarnings([]);
    setWizValidRows([]);
    setWizMailConfigId('');
    setWizAppIoMode('parallel');
    setWizAppIoDifferentiate(false);
    setWizAppIoSubjectOverride('');
    setWizAppIoBodyOverride('');
    setWizBlockedChannels([]);

    // Clear payment states
    setWizPaymentEnabled(false);
    setWizPaymentAmountCol('');
    setWizPaymentAmountType('euro');
    setWizPaymentNoticeCol('');
    setWizPaymentDueDateCol('');
    setWizPaymentPayeeType('static');
    setWizPaymentPayeeStatic('');
    setWizPaymentPayeeCol('');
  };

  const prefillWizardFrom = (source: {
    name: string;
    description: string | null;
    channelType: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL';
    channelConfig: Record<string, any>;
  }, opts: { isDuplicate: boolean; campaignId?: string }) => {
    setWizCampaignId(null);
    setWizName(opts.isDuplicate ? `${source.name} (Copia)` : source.name);
    setWizDesc(source.description || '');
    setWizChannel(source.channelType);
    setWizSubject(source.channelConfig?.subject || '');
    setWizProtocolla(Boolean(source.channelConfig?.protocolla));
    setWizTaxonomyCode(source.channelConfig?.taxonomyCode || '');
    setWizPhysicalCommunicationType(source.channelConfig?.physicalCommunicationType || 'AR_REGISTERED_LETTER');
    setWizPostalServiceType(source.channelConfig?.postalServiceType || 'Raccomandata');
    setWizPostalReturnReceipt(source.channelConfig?.postalReturnReceipt !== undefined ? Boolean(source.channelConfig.postalReturnReceipt) : true);
    setWizPostalAddressColumn(source.channelConfig?.physicalAddressConfig?.addressColumn || '');
    setWizPostalMunicipalityColumn(source.channelConfig?.physicalAddressConfig?.municipalityColumn || '');
    setWizPostalZipColumn(source.channelConfig?.physicalAddressConfig?.zipColumn || '');
    setWizPostalProvinceColumn(source.channelConfig?.physicalAddressConfig?.provinceColumn || '');
    setWizPostalUserDataColumn(source.channelConfig?.userDataColumn || '');
    setWizBody(source.channelConfig?.body || '');
    setWizMailConfigId(source.channelConfig?.mailConfigId || '');

    const paymentConfig = source.channelConfig?.paymentConfig;
    setWizPaymentEnabled(!!paymentConfig?.enabled);
    setWizPaymentAmountCol(paymentConfig?.amountColumn || '');
    setWizPaymentAmountType(paymentConfig?.amountType || 'euro');
    setWizPaymentNoticeCol(paymentConfig?.noticeNumberColumn || '');
    setWizPaymentDueDateCol(paymentConfig?.dueDateColumn || '');
    setWizPaymentPayeeType(paymentConfig?.payeeFiscalCodeType || 'static');
    setWizPaymentPayeeStatic(paymentConfig?.payeeFiscalCodeStatic || '');
    setWizPaymentPayeeCol(paymentConfig?.payeeFiscalCodeColumn || '');
    const secondaryAppIo = (source.channelConfig?.secondaryChannels || []).find(
      (sc: any) => sc?.channel === 'APP_IO'
    );
    setWizAppIoServiceId(
      secondaryAppIo?.ioServiceId ||
      source.channelConfig?.appIo?.ioServiceId ||
      source.channelConfig?.serviceId ||
      source.channelConfig?.ioServiceId ||
      ''
    );
    setWizAppIoMode(
      secondaryAppIo?.mode ||
      source.channelConfig?.appIo?.mode ||
      (source.channelConfig?.appIo ? 'parallel' : 'none')
    );
    setWizAppIoDifferentiate(!!secondaryAppIo?.subjectOverride || !!secondaryAppIo?.bodyOverride);
    setWizAppIoSubjectOverride(secondaryAppIo?.subjectOverride || '');
    setWizAppIoBodyOverride(secondaryAppIo?.bodyOverride || '');
    setWizBlockedChannels(source.channelConfig?.blockedChannels || []);
    
    // Il CSV viene recuperato se stiamo riprendendo una bozza e c'è un file salvato
    if (!opts.isDuplicate && opts.campaignId && source.channelConfig?.wizCsvFilename) {
      fetch(`${ADMIN_API_BASE}/campaigns/${opts.campaignId}/recipients/draft-csv`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      .then(async res => {
        if (res.ok) {
          const blob = await res.blob();
          const file = new File([blob], source.channelConfig.wizCsvFilename, { type: 'text/csv' });
          setWizCsvFile(file);
          parseCsvFile(file, !!source.channelConfig.wizCsvHasHeaders);
        }
      })
      .catch(() => { /* ignore */ });
    } else {
      setWizCsvFile(null);
      setWizCsvHeaders([]);
      setWizCsvRows([]);
      setWizValidRows([]);
    }

    setWizPendingMapping(source.channelConfig?.csvMapping || null);
    setWizPendingAttachments(source.channelConfig?.attachments || null);
    setWizStep(opts.isDuplicate ? 1 : (source.channelConfig?.wizStep || 1));
    setView('invio-massivo-wizard');
  };

  const handleDuplicateCampaign = async (campaignId: string) => {
    const res = await fetch(`${ADMIN_API_BASE}/campaigns/${campaignId}/duplicate-source`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      alert('Impossibile leggere i dati della campagna da duplicare.');
      return;
    }
    const source = await res.json();
    prefillWizardFrom(source, { isDuplicate: true });
  };

  const handleResumeDraft = async (campaignId: string) => {
    const res = await fetch(`${ADMIN_API_BASE}/campaigns/${campaignId}/duplicate-source`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      alert('Impossibile leggere i dati della bozza.');
      return;
    }
    const source = await res.json();
    prefillWizardFrom(source, { isDuplicate: false, campaignId });
    setWizCampaignId(campaignId);
  };

  const handleDeleteCampaign = async (id: string, name: string) => {
    if (!confirm(`Eliminare definitivamente la campagna "${name}"? Verranno cancellati destinatari, tentativi di invio e allegati. Azione irreversibile.`)) {
      return;
    }
    const res = await apiFetch(`/campaigns/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      alert('Impossibile eliminare la campagna.');
      return;
    }
    fetchCampaigns();
    if (selectedCampaignId === id) {
      setView('invio-massivo');
    }
  };

  const buildWizChannelConfigDraft = (): Record<string, any> => {
    const cfg: Record<string, any> = {
      subject: wizSubject,
      body: wizBody,
      mailConfigId: wizMailConfigId,
      protocolla: wizProtocolla,
      wizStep,
    };
    if (wizCsvFile) {
      cfg.wizCsvFilename = wizCsvFile.name;
      cfg.wizCsvHasHeaders = wizCsvHasHeaders;
    }
    if (wizChannel === 'SEND') {
      cfg.taxonomyCode = wizTaxonomyCode;
      cfg.physicalCommunicationType = wizPhysicalCommunicationType;
    }
    if (wizChannel === 'POSTAL') {
      cfg.postalServiceType = wizPostalServiceType;
      cfg.postalReturnReceipt = wizPostalReturnReceipt;
      cfg.physicalAddressConfig = {
        enabled: true,
        addressColumn: wizPostalAddressColumn,
        municipalityColumn: wizPostalMunicipalityColumn,
        zipColumn: wizPostalZipColumn,
        provinceColumn: wizPostalProvinceColumn,
      };
      if (wizPostalUserDataColumn) {
        cfg.userDataColumn = wizPostalUserDataColumn;
      }
    }
    if (wizAttachments.length > 0) cfg.attachments = wizAttachments;
    if (wizMapping.codice_fiscale) cfg.csvMapping = wizMapping;
    if (wizChannel === 'APP_IO') {
      cfg.ioServiceId = wizAppIoServiceId;
    }
    if (wizAppIoMode !== 'none' && wizAppIoServiceId) {
      cfg.secondaryChannels = [{
        channel: 'APP_IO',
        mode: wizAppIoMode,
        ioServiceId: wizAppIoServiceId,
        ...(wizAppIoDifferentiate ? { subjectOverride: wizAppIoSubjectOverride, bodyOverride: wizAppIoBodyOverride } : {}),
      }];
    }
    if (wizBlockedChannels.length > 0) cfg.blockedChannels = wizBlockedChannels;

    if (wizPaymentEnabled) {
      cfg.paymentConfig = {
        enabled: true,
        amountColumn: wizPaymentAmountCol,
        amountType: wizPaymentAmountType,
        noticeNumberColumn: wizPaymentNoticeCol,
        dueDateColumn: wizPaymentDueDateCol || null,
        payeeFiscalCodeType: wizPaymentPayeeType,
        payeeFiscalCodeStatic: wizPaymentPayeeType === 'static' ? wizPaymentPayeeStatic : null,
        payeeFiscalCodeColumn: wizPaymentPayeeType === 'column' ? wizPaymentPayeeCol : null,
      };
    }
    return cfg;
  };

  const handleSaveWizardDraft = async () => {
    if (!wizName) {
      alert('Inserisci almeno il nome della campagna prima di salvare la bozza.');
      return;
    }
    setWizDraftSaving(true);
    let activeCampaignId = wizCampaignId;
    try {
      if (!wizCampaignId) {
        const res = await apiFetch('/campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc,
            channelType: wizChannel,
            channelConfig: buildWizChannelConfigDraft(),
          }),
        });
        if (!res.ok) throw new Error('Errore durante il salvataggio della bozza');
        const created = await res.json();
        activeCampaignId = created.id;
        setWizCampaignId(created.id);
      } else {
        const res = await apiFetch(`/campaigns/${wizCampaignId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc,
            channelConfig: buildWizChannelConfigDraft(),
          }),
        });
        if (!res.ok) throw new Error('Errore durante il salvataggio della bozza');
      }

      if (wizCsvFile) {
        const formData = new FormData();
        formData.append('file', wizCsvFile);
        const csvUploadRes = await fetch(`${ADMIN_API_BASE}/campaigns/${activeCampaignId}/recipients/draft-csv`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });
        if (!csvUploadRes.ok) throw new Error('Errore durante il caricamento del file CSV in bozza');
      }

      fetchCampaigns();
      alert('Bozza salvata.');
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      alert(err.message);
    } finally {
      setWizDraftSaving(false);
    }
  };

  const handleWizLaunch = async () => {
    if (wizValidRows.length === 0) {
      alert('Non ci sono destinatari validi da inviare.');
      return;
    }
    setWizSending(true);

    try {
      let channelConfig: Record<string, any> = {};
      if (wizChannel === 'APP_IO') {
        const svc = ioServices.find(s => s.id === wizAppIoServiceId) || ioServices[0];
        channelConfig = {
          ioServiceId: svc ? svc.id : '',
          subject: wizSubject,
          body: wizBody,
          attachments: wizAttachments,
        };
      } else if (wizChannel === 'EMAIL' || wizChannel === 'PEC') {
        const activeCfg = mailConfigs.find(c => c.id === wizMailConfigId);
        channelConfig = {
          subject: wizSubject,
          body: wizBody,
          attachments: wizAttachments,
          mailConfigId: wizMailConfigId,
          from: activeCfg?.fromAddress || '',
        };

        if (wizAppIoMode !== 'none') {
          const defaultSvc = ioServices.find(s => s.id === wizAppIoServiceId) || ioServices.find(s => s.isDefault) || ioServices[0];
          if (defaultSvc) {
            channelConfig.secondaryChannels = [{
              channel: 'APP_IO',
              mode: wizAppIoMode,
              ioServiceId: defaultSvc.id,
              ...(wizAppIoDifferentiate ? { subjectOverride: wizAppIoSubjectOverride, bodyOverride: wizAppIoBodyOverride } : {}),
            }];
          }
        }
      } else if (wizChannel === 'SEND') {
        channelConfig = {
          subject: wizSubject,
          body: wizBody,
          protocolla: true,
          taxonomyCode: wizTaxonomyCode,
          physicalCommunicationType: wizPhysicalCommunicationType,
        };
      } else if (wizChannel === 'POSTAL') {
        channelConfig.postalServiceType = wizPostalServiceType;
        channelConfig.postalReturnReceipt = wizPostalReturnReceipt;
        channelConfig.physicalAddressConfig = {
          enabled: true,
          addressColumn: wizPostalAddressColumn,
          municipalityColumn: wizPostalMunicipalityColumn,
          zipColumn: wizPostalZipColumn,
          provinceColumn: wizPostalProvinceColumn,
        };
        if (wizPostalUserDataColumn) {
          channelConfig.userDataColumn = wizPostalUserDataColumn;
        }
      }

      if (wizChannel !== 'SEND') {
        channelConfig.protocolla = wizProtocolla;
      }

      if (wizPaymentEnabled) {
        channelConfig.paymentConfig = {
          enabled: true,
          amountColumn: wizPaymentAmountCol,
          amountType: wizPaymentAmountType,
          noticeNumberColumn: wizPaymentNoticeCol,
          dueDateColumn: wizPaymentDueDateCol || null,
          payeeFiscalCodeType: wizPaymentPayeeType,
          payeeFiscalCodeStatic: wizPaymentPayeeType === 'static' ? wizPaymentPayeeStatic : null,
          payeeFiscalCodeColumn: wizPaymentPayeeType === 'column' ? wizPaymentPayeeCol : null,
        };
      }

      if (wizBlockedChannels.length > 0) {
        channelConfig.blockedChannels = wizBlockedChannels;
      }
      if (wizMapping.codice_fiscale) {
        channelConfig.csvMapping = wizMapping;
      }

      let campaignObj: { id: string };
      if (wizCampaignId) {
        const patchRes = await fetch(`${ADMIN_API_BASE}/campaigns/${wizCampaignId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: wizName, description: wizDesc || wizSubject || wizName, channelConfig }),
        });
        if (!patchRes.ok) throw new Error('Errore durante l\'aggiornamento della bozza');
        campaignObj = { id: wizCampaignId };
      } else {
        const res = await fetch(`${ADMIN_API_BASE}/campaigns`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc || wizSubject || wizName,
            channelType: wizChannel,
            channelConfig,
          }),
        });
        if (!res.ok) throw new Error('Errore durante la creazione della campagna');
        campaignObj = await res.json();
      }

      const extraHeaders = wizCsvHeaders.filter(h => 
        h !== wizMapping.codice_fiscale && 
        h !== wizMapping.full_name && 
        h !== wizMapping.full_name_2 && 
        h !== wizMapping.email && 
        h !== wizMapping.pec
      );

      const headerLine = ['codice_fiscale', 'full_name', 'email', 'pec', ...extraHeaders].join(',');
      const rowLines = wizValidRows.map(row => {
        const cf = row[wizMapping.codice_fiscale] || '';
        
        const fn1 = row[wizMapping.full_name] || '';
        const fn2 = wizMapping.full_name_2 ? (row[wizMapping.full_name_2] || '') : '';
        const fn = [fn1, fn2].filter(Boolean).join(' ');

        const email = row[wizMapping.email] || '';
        const pec = row[wizMapping.pec] || '';
        const extra = extraHeaders.map(h => row[h] || '');
        return [cf, fn, email, pec, ...extra].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
      });

      const csvContent = [headerLine, ...rowLines].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv' });

      setWizUploadProgress({ label: 'Caricamento destinatari', loaded: 0, total: blob.size });
      const uploadData = await uploadFileInChunks(
        `${ADMIN_API_BASE}/campaigns/${campaignObj.id}/recipients/upload`,
        token!,
        blob,
        'normalized_recipients.csv',
        (loaded) => setWizUploadProgress(p => (p ? { ...p, loaded } : p)),
        () => setWizUploadProgress({ label: 'Elaborazione destinatari in corso', loaded: blob.size, total: blob.size }),
      );
      setWizUploadProgress(null);
      if (uploadData?.blocked) {
        throw new Error(uploadData.message || 'Errore durante il caricamento dei destinatari.');
      }

      // Caricamento allegati PDF/ZIP personalizzati
      let discardCount = 0;
      if (wizPdfFiles && wizPdfFiles.length > 0) {
        const totalBytes = wizPdfFiles.reduce((sum, f) => sum + f.size, 0);
        setWizUploadProgress({ label: 'Caricamento allegati', loaded: 0, total: totalBytes });
        let cumulativeBefore = 0;
        let lastAttachData: { uploaded: number; discarded?: number; blocked?: boolean; message?: string } | null = null;
        for (const file of wizPdfFiles) {
          const base = cumulativeBefore;
          const isZip = file.name.toLowerCase().endsWith('.zip');
          lastAttachData = await uploadFileInChunks(
            `${ADMIN_API_BASE}/campaigns/${campaignObj.id}/attachments/upload`,
            token!,
            file,
            file.name,
            (loaded) => setWizUploadProgress(p => (p ? { ...p, loaded: base + loaded } : p)),
            () => setWizUploadProgress({
              label: isZip ? 'Estrazione allegati in corso' : 'Salvataggio allegato in corso',
              loaded: base + file.size,
              total: totalBytes
            }),
          );
          cumulativeBefore += file.size;
        }
        setWizUploadProgress(null);
        if (lastAttachData?.blocked) {
          throw new Error(lastAttachData.message || 'Errore durante la finalizzazione degli allegati.');
        }
        discardCount = lastAttachData?.discarded || 0;
      }

      const launchRes = await fetch(`${ADMIN_API_BASE}/campaigns/${campaignObj.id}/launch`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!launchRes.ok) {
        const errBody = await launchRes.json().catch(() => null);
        throw new Error(errBody?.message || 'Errore durante il lancio della campagna.');
      }

      // launch() risponde 200 anche quando blocca il lancio (allegati mancanti):
      // il reverse proxy di produzione intercetta le risposte non-2xx e ne
      // sostituisce il body con una pagina HTML propria, rendendo illeggibile
      // il messaggio di errore — vedi campaigns.service.ts::launch().
      const launchData = await launchRes.json().catch(() => null);
      if (launchData?.blocked) {
        throw new Error(launchData.message || 'Impossibile avviare la campagna.');
      }

      resetWizard();

      fetchCampaigns();
      setView('dashboard');
      
      const successMsg = discardCount > 0
        ? `Campagna creata e avviata con successo! I messaggi sono in coda.\nNota: ${discardCount} file non referenziati da alcun cittadino sono stati scartati.`
        : 'Campagna creata e avviata con successo! I messaggi sono in coda.';
      alert(successMsg);
    } catch (err: any) {
      alert(err.message || 'Errore durante l\'invio della campagna.');
    } finally {
      setWizSending(false);
      setWizUploadProgress(null);
    }
  };

  const handleCampaignClick = (id: string) => {
    setSelectedCampaignId(id);
    setView('campaign-detail');
    setCampaign(null);
    setFailureGroups([]);
    setChannelBreakdown(null);
    setCampaignSendStageCounts(null);
    setDownloadCombinations(null);
    setRecipientsPage(null);
    setRecipientsSearch('');
    setRecipientsPageNum(1);
    fetchCampaignDetail(id);
    fetchFailureGroups(id);
    fetchChannelBreakdown(id);
    fetchCampaignSendStageCounts(id);
    fetchDownloadCombinationStats(id);
  };

  const fetchChannelBreakdown = async (id: string) => {
    try {
      const res = await apiFetch(`/campaigns/${id}/channel-stats`);
      if (!res.ok) return;
      const data = await res.json();
      setChannelBreakdown(data.breakdown);
    } catch {
      // Non bloccante: la pagina dettaglio resta usabile senza il breakdown.
    }
  };

  const fetchCampaignSendStageCounts = async (id: string) => {
    try {
      const res = await apiFetch(`/campaigns/${id}/send-stage-counts`);
      if (!res.ok) return;
      setCampaignSendStageCounts(await res.json());
    } catch {
      // Non bloccante: il dettaglio campagna resta usabile senza la barra a stadi.
    }
  };

  const RECIPIENTS_PAGE_SIZE = 50;

  const fetchRecipientsPage = async (campaignId: string, page: number, search: string) => {
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(RECIPIENTS_PAGE_SIZE) });
      if (search.trim()) params.set('search', search.trim());
      const res = await apiFetch(`/campaigns/${campaignId}/stats/recipients?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      setRecipientsPage(data);
    } catch {
      // Non bloccante: la tabella resta sullo stato precedente.
    }
  };

  const fetchDownloadCombinationStats = async (id: string) => {
    try {
      const res = await apiFetch(`/campaigns/${id}/download-combination-stats`);
      if (!res.ok) return;
      const data = await res.json();
      setDownloadCombinations(data.combinations && data.combinations.length > 0 ? data.combinations : null);
    } catch {
      // Non bloccante.
    }
  };

  const fetchGlobalStats = async () => {
    setGlobalStatsLoading(true);
    try {
      const params = new URLSearchParams();
      if (statsDateFrom) params.set('dateFrom', statsDateFrom);
      if (statsDateTo) params.set('dateTo', statsDateTo);
      const res = await apiFetch(`/campaigns/stats/global?${params.toString()}`);
      if (res.ok) setGlobalStats(await res.json());
    } catch (err) {
      if (!(err instanceof ApiAuthError)) throw err;
    } finally {
      setGlobalStatsLoading(false);
    }
  };

  const handleExportNeverDownloaded = async () => {
    try {
      const params = new URLSearchParams();
      if (statsDateFrom) params.set('dateFrom', statsDateFrom);
      if (statsDateTo) params.set('dateTo', statsDateTo);
      const res = await apiFetch(`/campaigns/stats/global/never-downloaded.csv?${params.toString()}`);
      if (!res.ok) {
        alert('Impossibile esportare il report.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mai_scaricato.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      if (!(err instanceof ApiAuthError)) throw err;
    }
  };

  const handleLaunchCampaign = async () => {
    if (!campaign) return;
    if (!confirm(`Sei sicuro di voler lanciare la campagna "${campaign.name}"? L'invio ai destinatari avverrà asincronamente.`)) {
      return;
    }
    setLaunching(true);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/campaigns/${campaign.id}/launch`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Errore durante il lancio della campagna');
      }
      alert('Campagna lanciata con successo!');
      fetchCampaignDetail(campaign.id);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLaunching(false);
    }
  };

  const handleCancelCampaign = async () => {
    if (!campaign) return;
    if (!confirm(`Annullare la campagna "${campaign.name}"? I messaggi già inviati NON verranno toccati, ma quelli ancora in coda saranno eliminati e non potranno più essere inviati. L'operazione è irreversibile.`)) {
      return;
    }
    setCancelling(true);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/campaigns/${campaign.id}/cancel`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Errore durante l\'annullamento della campagna');
      }
      const data = await res.json();
      alert(`Campagna annullata. Destinatari rimossi dalla coda: ${data.cancelled}.`);
      fetchCampaignDetail(campaign.id);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setCancelling(false);
    }
  };

  // Render Guest Login View
  if (!token) {
    return (
      <div className="login-page-wrapper">
        <div className="login-glow-1"></div>
        <div className="login-glow-2"></div>
        <div className="login-card">
          <div className="login-header">
            <div className="login-logo-container">
              {brandLogoUrl ? (
                <img src={brandLogoUrl} alt={brandName} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              ) : (
                <i className="fas fa-building"></i>
              )}
            </div>
            <h1 className="login-title">{brandName}</h1>
            <p className="login-subtitle">{brandSubtitle || 'Amministrazione & Gestione Invii'}</p>
          </div>
          <div className="login-body">
            <form onSubmit={handleLogin}>
              {loginError && (
                <div className="login-error-alert" role="alert">
                  <i className="fas fa-exclamation-triangle"></i> {loginError}
                </div>
              )}
              <div className="login-form-group">
                <label className="login-label" htmlFor="username">Utente (sAMAccountName)</label>
                <div className="login-input-wrapper">
                  <input
                    type="text"
                    id="username"
                    className="login-input"
                    placeholder="Es: admin, operator"
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.target.value)}
                    required
                  />
                  <span className="login-input-icon"><i className="fas fa-user"></i></span>
                </div>
              </div>
              <div className="login-form-group">
                <label className="login-label" htmlFor="password">Password AD/LDAP</label>
                <div className="login-input-wrapper">
                  <input
                    type="password"
                    id="password"
                    className="login-input"
                    placeholder="••••••••"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                  />
                  <span className="login-input-icon"><i className="fas fa-lock"></i></span>
                </div>
              </div>
              <button
                type="submit"
                className="login-button"
                disabled={loginLoading}
              >
                {loginLoading ? (
                  <>
                    <i className="fas fa-spinner fa-spin"></i> Accesso in corso...
                  </>
                ) : (
                  <>
                    Accedi con Active Directory
                  </>
                )}
              </button>
            </form>
          </div>
          {isLdapMock && (
            <div className="login-footer">
              <div className="login-footer-text">
                Sviluppo locale: usa <code className="login-footer-code">admin/admin</code> o <code className="login-footer-code">operator/operator</code>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Render Shell Layout for Authenticated Users
  return (
    <div className="bo-shell-root">
      {/* Sidebar navigation */}
      <aside className="bo-sidebar">
        <div className="bo-sidebar-brand" style={{ cursor: 'pointer' }} onClick={() => setView('dashboard')}>
          <span className="bo-sidebar-brand-mark">
            {brandLogoUrl ? (
              <img src={brandLogoUrl} alt={settEntityName} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            ) : (
              <i className="fas fa-building bo-brand-logo-fallback text-warning"></i>
            )}
          </span>
          <span className="bo-sidebar-brand-copy">
            <span className="bo-sidebar-brand-title">{settEntityName}</span>
            <span className="bo-sidebar-brand-subtitle">{settSubtitle}</span>
          </span>
        </div>

        <nav className="bo-nav" onClick={() => setSidebarOpen(false)}>
          <div className="bo-nav-section-title">Operativo</div>
          <a
            className={`bo-nav-item ${view === 'dashboard' ? 'is-active' : ''}`}
            href="#"
            onClick={(e) => { e.preventDefault(); setView('dashboard'); }}
          >
            <i className="fas fa-chart-line"></i>
            <span>Dashboard</span>
          </a>
          <a
            className={`bo-nav-item ${view === 'invio-singolo' ? 'is-active' : ''}`}
            href="#"
            onClick={(e) => { e.preventDefault(); setView('invio-singolo'); setSingleSuccess(null); }}
          >
            <i className="fas fa-paper-plane"></i>
            <span>Invio Singolo</span>
          </a>
          <a
            className={`bo-nav-item ${view === 'invio-massivo' || view === 'campaign-detail' || view === 'invio-massivo-wizard' ? 'is-active' : ''}`}
            href="#"
            onClick={(e) => { e.preventDefault(); setView('invio-massivo'); }}
          >
            <i className="fas fa-mail-bulk"></i>
            <span>Invio Massivo</span>
          </a>
          <a
            className={`bo-nav-item ${view === 'statistiche' ? 'is-active' : ''}`}
            href="#"
            onClick={(e) => { e.preventDefault(); setView('statistiche'); }}
          >
            <i className="fas fa-chart-pie"></i>
            <span>Statistiche</span>
          </a>
          <a
            className={`bo-nav-item ${view === 'notifiche-ricerca' ? 'is-active' : ''}`}
            href="#"
            onClick={(e) => { e.preventDefault(); setView('notifiche-ricerca'); }}
          >
            <i className="fas fa-magnifying-glass"></i>
            <span>Ricerca Notifiche</span>
          </a>
          <a
            className={`bo-nav-item ${view === 'verifica-appio' ? 'is-active' : ''}`}
            href="#"
            onClick={(e) => { e.preventDefault(); setView('verifica-appio'); setVerificaCf(''); setVerificaResult(null); }}
          >
            <i className="fas fa-user-check"></i>
            <span>Verifica App IO</span>
          </a>
          <a
            className={`bo-nav-item ${view === 'template-dashboard' ? 'is-active' : ''}`}
            href="#"
            onClick={(e) => { e.preventDefault(); setView('template-dashboard'); }}
          >
            <i className="fas fa-file-lines"></i>
            <span>Template</span>
          </a>

          <div className="bo-nav-section-title">Sistema</div>
          {role === 'admin' && (
            <a
              className={`bo-nav-item ${view === 'impostazioni' ? 'is-active' : ''}`}
              href="#"
              onClick={(e) => { e.preventDefault(); setView('impostazioni'); }}
            >
              <i className="fas fa-sliders-h"></i>
              <span>Impostazioni</span>
            </a>
          )}
          <a
            className={`bo-nav-item ${view === 'audit-logs' ? 'is-active' : ''}`}
            href="#"
            onClick={(e) => { e.preventDefault(); setView('audit-logs'); setAuditPage(1); }}
          >
            <i className="fas fa-history"></i>
            <span>Registro Attività</span>
          </a>
        </nav>

        <div className="bo-sidebar-meta mt-auto">
          <span className="bo-sidebar-status-dot active"></span>
          <span>Online (Dev Mode)</span>
          {appVersion && (
            <span className="bo-sidebar-version" title="Versione applicazione">
              <i className="fas fa-tag me-1"></i>{appVersion}
            </span>
          )}
        </div>
      </aside>

      {/* Backdrop mobile: chiude la sidebar toccando fuori */}
      <button
        type="button"
        className="bo-sidebar-backdrop"
        aria-label="Chiudi menu"
        onClick={() => setSidebarOpen(false)}
      ></button>

      {/* Topbar */}
      <header className="bo-topbar">
        <button
          type="button"
          className="bo-topbar-hamburger"
          aria-label={sidebarOpen ? 'Chiudi menu' : 'Apri menu'}
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((o) => !o)}
        >
          <i className="fas fa-bars"></i>
        </button>
        <h2 className="h5 mb-0 text-dark fw-bold" style={{ display: 'inline-block' }}>
          {view === 'dashboard' && 'Dashboard'}
          {view === 'invio-singolo' && 'Nuova Notifica Singola'}
          {view === 'invio-massivo' && 'Campagne di Invio Massivo'}
          {view === 'invio-massivo-wizard' && 'Wizard Nuova Campagna Massiva'}
          {view === 'statistiche' && 'Statistiche e Andamento'}
          {view === 'notifiche-ricerca' && 'Ricerca Notifiche'}
          {view === 'template-dashboard' && 'Template'}
          {view === 'impostazioni' && 'Impostazioni di Sistema'}
          {view === 'audit-logs' && 'Registro Attività'}
          {view === 'campaign-detail' && `Dettaglio Campagna / ${campaign?.name || '...'}`}
        </h2>

        <div className="bo-topbar-actions ms-auto d-flex align-items-center gap-3">
          <div className="d-flex align-items-center gap-2">
            <span className="user-initials-avatar" style={{ width: '28px', height: '28px', fontSize: '10px' }}>
              {username?.slice(0, 2).toUpperCase()}
            </span>
            <div className="d-none d-md-block" style={{ lineHeight: 1.1 }}>
              <div className="small fw-bold text-dark">{username}</div>
              <div className="small text-muted text-uppercase" style={{ fontSize: '9px' }}>{role}</div>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="btn btn-outline-danger btn-sm border-0 px-2"
          >
            <i className="fas fa-sign-out-alt"></i> Logout
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="bo-content">
        <div className="bo-content-inner">

          {/* VIEW: DASHBOARD */}
          {view === 'dashboard' && (
            <div>
              <div className="bo-home-welcome mb-4 p-4 rounded shadow-sm" style={{ background: 'linear-gradient(135deg, var(--ms-purple-900), var(--ms-purple-600))', color: '#fff' }}>
                <h1 className="h4 text-white mb-2">Ciao, {username}! 👋</h1>
                <p className="mb-0 text-white-50 small">
                  Benvenuto nell'hub ComunicaPA del <strong>{settEntityName}</strong>. Qui puoi gestire gli invii e le impostazioni dei connettori.
                </p>
              </div>

              <div className="row g-3 mb-4">
                <div className="col-md-4">
                  <div className="card shadow-sm h-100" style={{ borderLeft: '4px solid var(--bi-primary)' }}>
                    <div className="card-body d-flex align-items-center gap-3">
                      <div className="bg-light text-primary rounded p-3" style={{ fontSize: '1.4rem' }}><i className="fas fa-bullhorn"></i></div>
                      <div>
                        <span className="text-muted small block">Campagne Create</span>
                        <div className="h4 mb-0 fw-bold">{campaigns.length}</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="col-md-4">
                  <div className="card shadow-sm h-100" style={{ borderLeft: '4px solid var(--ms-green-600)' }}>
                    <div className="card-body d-flex align-items-center gap-3">
                      <div className="bg-light text-success rounded p-3" style={{ fontSize: '1.4rem' }}><i className="fas fa-check-circle"></i></div>
                      <div>
                        <span className="text-muted small block">Messaggi Inviati</span>
                        <div className="h4 mb-0 fw-bold">{campaigns.reduce((acc, c) => acc + c.sentCount, 0)}</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="col-md-4">
                  <div className="card shadow-sm h-100" style={{ borderLeft: '4px solid var(--it-red)' }}>
                    <div className="card-body d-flex align-items-center gap-3">
                      <div className="bg-light text-danger rounded p-3" style={{ fontSize: '1.4rem' }}><i className="fas fa-times-circle"></i></div>
                      <div>
                        <span className="text-muted small block">Spedizioni Fallite</span>
                        <div className="h4 mb-0 fw-bold">{campaigns.reduce((acc, c) => acc + c.failedCount, 0)}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="row g-3">
                <div className="col-lg-8">
                  <div className="card shadow-sm h-100">
                    <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">
                      <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-history me-2 text-primary"></i>Attività Recenti</h3>
                      <button className="btn btn-outline-secondary btn-sm border-0" onClick={fetchCampaigns}><i className="fas fa-sync-alt"></i></button>
                    </div>
                    <div className="card-body p-0">
                      {campaigns.length === 0 ? (
                        <div className="text-center py-5 text-muted">Nessuna attività registrata.</div>
                      ) : (
                        <div className="table-responsive">
                          <table className="table table-hover align-middle mb-0" style={{ fontSize: '0.84rem' }}>
                            <thead className="table-light">
                              <tr>
                                <th>Nome Campagna</th>
                                <th>Canale</th>
                                <th>Stato</th>
                                <th className="text-end">Successi</th>
                              </tr>
                            </thead>
                            <tbody>
                              {campaigns.slice(0, 5).map((c) => (
                                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => handleCampaignClick(c.id)}>
                                  <td className="fw-bold text-primary">{c.name}</td>
                                  <td><ChannelBadge channel={c.channelType} /></td>
                                  <td><StatusBadge status={c.status} /></td>
                                  <td className="text-end fw-bold">{c.sentCount} / {c.totalRecipients}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="col-lg-4">
                  <div className="card shadow-sm h-100">
                    <div className="card-header bg-white py-3 border-bottom">
                      <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-network-wired me-2 text-primary"></i>GIL Services Hub</h3>
                    </div>
                    <div className="card-body">
                      <div className="daemon-service-item mb-3 p-3 bg-light rounded border">
                        <div className="d-flex align-items-center justify-content-between mb-1">
                          <span className="small fw-bold"><i className="fas fa-envelope-open-text text-primary me-2"></i>Sincronizzatore Mail/PEC</span>
                          <span className="badge bg-success">ATTIVO</span>
                        </div>
                        <p className="small text-muted mb-0">Gestisce la ricezione delle ricevute di consegna PEC.</p>
                      </div>
                      <div className="daemon-service-item p-3 bg-light rounded border">
                        <div className="d-flex align-items-center justify-content-between mb-1">
                          <span className="small fw-bold"><i className="fas fa-plug text-primary me-2"></i>Worker BullMQ</span>
                          <span className="badge bg-success">ATTIVO</span>
                        </div>
                        <p className="small text-muted mb-0">Elabora la coda delle notifiche SEND e App IO in background.</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* VIEW: INVIO SINGOLO */}
          {view === 'invio-singolo' && (
            <div className="card shadow-sm bg-white mx-auto" style={{ maxWidth: '800px' }}>
              <div className="card-header bg-white py-3 border-bottom">
                <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-paper-plane me-2 text-primary"></i>Nuova Notifica Singola</h3>
              </div>
              <div className="card-body p-4">
                {singleSuccess && (
                  <div className="alert alert-success d-flex align-items-center gap-2 mb-4">
                    <i className="fas fa-check-circle"></i>
                    <div>
                      Notifica singola inviata e accodata con successo! ID Campagna generata: <strong>{singleSuccess}</strong>
                    </div>
                  </div>
                )}

                <form onSubmit={handleSingleSendSubmit}>
                  <div className="row g-3">
                    <div className="col-md-6">
                      <label className="form-label small fw-bold text-dark" htmlFor="s_cf">Codice Fiscale Destinatario <span className="text-danger">*</span></label>
                      <input
                        type="text"
                        id="s_cf"
                        className="form-control form-control-sm"
                        placeholder="16 caratteri alfanumerici"
                        maxLength={16}
                        value={singleCf}
                        onChange={(e) => setSingleCf(e.target.value.toUpperCase())}
                        required
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label small fw-semibold text-muted" htmlFor="s_name">Nome Completo</label>
                      <input
                        type="text"
                        id="s_name"
                        className="form-control form-control-sm"
                        placeholder="Es: Mario Rossi"
                        value={singleName}
                        onChange={(e) => setSingleName(e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label small fw-semibold text-muted" htmlFor="s_email">Indirizzo Email</label>
                      <input
                        type="email"
                        id="s_email"
                        className="form-control form-control-sm"
                        placeholder="mario.rossi@example.com"
                        value={singleEmail}
                        onChange={(e) => setSingleEmail(e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label small fw-semibold text-muted" htmlFor="s_pec">Indirizzo PEC</label>
                      <input
                        type="email"
                        id="s_pec"
                        className="form-control form-control-sm"
                        placeholder="mario.rossi@pec.it"
                        value={singlePec}
                        onChange={(e) => setSinglePec(e.target.value)}
                      />
                    </div>

                    <div className="col-md-6 border-top pt-3">
                      <label className="form-label small fw-semibold text-muted" htmlFor="s_channel">Canale di Trasmissione</label>
                      <select
                        id="s_channel"
                        className="form-select form-select-sm"
                        value={singleChannel}
                        onChange={(e: any) => setSingleChannel(e.target.value)}
                      >
                        <option value="EMAIL">EMAIL</option>
                        <option value="PEC">PEC (Posta Elettronica Certificata)</option>
                        <option value="APP_IO">APP IO (PagoPA)</option>
                        <option value="SEND">SEND (Notifiche Digitali)</option>
                        <option value="POSTAL">POSTAL (Cartaceo)</option>
                      </select>
                    </div>

                    {singleChannel === 'APP_IO' && (
                      <div className="col-md-6 border-top pt-3">
                        <label className="form-label small fw-bold text-dark" htmlFor="s_io_svc">Servizio App IO Associato</label>
                        <select
                          id="s_io_svc"
                          className="form-select form-select-sm"
                          value={singleAppIoServiceId}
                          onChange={(e) => setSingleAppIoServiceId(e.target.value)}
                          required
                        >
                          {ioServices.map(s => (
                            <option key={s.id} value={s.id}>
                              {s.nome} {s.isDefault ? '(Predefinito)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div className="col-12">
                      <label className="form-label small fw-bold text-dark" htmlFor="s_subject">Oggetto dell'Avviso</label>
                      <input
                        type="text"
                        id="s_subject"
                        className="form-control form-control-sm"
                        placeholder="Oggetto dell'avviso istituzionale"
                        value={singleSubject}
                        onChange={(e) => setSingleSubject(e.target.value)}
                        required
                      />
                    </div>

                    <div className="col-12">
                      <label className="form-label small fw-bold text-dark" htmlFor="s_body">Contenuto della Comunicazione</label>
                      <textarea
                        id="s_body"
                        className="form-control form-control-sm"
                        rows={4}
                        placeholder="Digita qui il testo completo del messaggio..."
                        value={singleBody}
                        onChange={(e) => setSingleBody(e.target.value)}
                        required
                      ></textarea>
                    </div>

                    <div className="col-12 mt-4">
                      <button
                        type="submit"
                        className="btn btn-primary w-100 py-2 fw-bold"
                        style={{ backgroundColor: 'var(--bi-primary)', border: 'none' }}
                        disabled={singleSending}
                      >
                        {singleSending ? (
                          <><i className="fas fa-spinner fa-spin me-2"></i>Spedizione in corso...</>
                        ) : (
                          <><i className="fas fa-paper-plane me-2"></i>Invia Notifica Singola</>
                        )}
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            </div>
          )}

              {/* VIEW: INVIO MASSIVO */}
          {view === 'invio-massivo' && (
            <div className="row g-4">
              <div className="col-12">
                <div className="card shadow-sm h-100">
                  <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">
                    <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-list me-2 text-primary"></i>Campagne Massive</h3>
                    <div className="d-flex align-items-center gap-2">
                      <button className="btn btn-sm btn-primary" onClick={() => { resetWizard(); setView('invio-massivo-wizard'); }}>
                        <i className="fas fa-magic me-1"></i> Crea Nuova Campagna (Wizard)
                      </button>
                      <button className="btn btn-outline-secondary btn-sm border-0" onClick={fetchCampaigns}><i className="fas fa-sync-alt"></i></button>
                    </div>
                  </div>
                  <div className="card-body p-0">
                    {dashboardError && (
                      <div className="alert alert-danger m-3">{dashboardError}</div>
                    )}
                    {loadingCampaigns && campaigns.length === 0 ? (
                      <div className="text-center py-5">
                        <i className="fas fa-spinner fa-spin fa-2x text-primary mb-2"></i>
                        <div>Caricamento campagne...</div>
                      </div>
                    ) : campaigns.length === 0 ? (
                      <div className="text-center py-5 text-muted">Nessuna campagna presente.</div>
                    ) : (
                      <div className="table-responsive">
                        <table className="table table-hover align-middle mb-0" style={{ fontSize: '0.84rem' }}>
                          <thead className="table-light">
                            <tr>
                              <th>Nome</th>
                              <th>Canale</th>
                              <th className="text-center">Destinatari</th>
                              <th className="text-center">Stato</th>
                              <th>Creata il</th>
                            </tr>
                          </thead>
                          <tbody>
                            {campaigns.map((c) => (
                              <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => handleCampaignClick(c.id)}>
                                <td className="fw-bold text-primary">{c.name}</td>
                                <td>
                                  <ChannelBadge channel={c.channelType} extra={c.channelConfig?.['serviceName'] as string | undefined} />
                                </td>
                                <td className="text-center fw-bold">{c.totalRecipients}</td>
                                <td className="text-center">
                                  <StatusBadge status={c.status} />
                                </td>
                                <td className="text-muted">{new Date(c.createdAt).toLocaleDateString('it-IT')}</td>
                                <td className="text-end" onClick={(e) => e.stopPropagation()}>
                                  {c.status === 'draft' && (
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-outline-primary d-flex align-items-center gap-1 mb-1"
                                      title="Riprendi wizard campagna"
                                      onClick={() => handleResumeDraft(c.id)}
                                    >
                                      <i className="fas fa-edit"></i> Riprendi
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
                                    title="Duplica campagna in un nuovo wizard"
                                    onClick={() => handleDuplicateCampaign(c.id)}
                                  >
                                    <i className="fas fa-copy"></i> Duplica
                                  </button>
                                  {role === 'admin' && (
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-outline-danger d-flex align-items-center gap-1 mt-1"
                                      title="Elimina campagna definitivamente"
                                      onClick={() => handleDeleteCampaign(c.id, c.name)}
                                    >
                                      <i className="fas fa-trash"></i> Elimina
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* VIEW: WIZARD INVIO MASSIVO */}
          {view === 'invio-massivo-wizard' && (
            <div className="card shadow-sm bg-white p-4">
              {/* Step Navigation Indicators */}
              <div className="d-flex justify-content-between align-items-center mb-4 border-bottom pb-3">
                <div className="d-flex align-items-center gap-2">
                  <h3 className="h5 mb-0 fw-bold text-dark"><i className="fas fa-magic me-2 text-primary"></i>Procedura Guidata Campagna</h3>
                </div>
                <div className="d-flex gap-2">
                  <button className="btn btn-outline-primary btn-sm" onClick={handleSaveWizardDraft} disabled={wizDraftSaving}>
                    <i className="fas fa-floppy-disk me-1"></i>{wizDraftSaving ? 'Salvataggio...' : 'Salva bozza'}
                  </button>
                  <button className="btn btn-outline-secondary btn-sm" onClick={() => { setWizCampaignId(null); setView('invio-massivo'); }}>
                    <i className="fas fa-times me-1"></i> Annulla
                  </button>
                </div>
              </div>

              {/* Steps Progress Header — clickable when already visited */}
              <div className="d-flex justify-content-between mb-4 text-center" style={{ fontSize: '0.82rem' }}>
                {[
                  { n: 1, label: '1. Dettagli & Canale' },
                  { n: 2, label: '2. Caricamento File' },
                  { n: 3, label: '3. Mappatura & Validazione' },
                  { n: 4, label: '4. Template & Anteprima' },
                  { n: 5, label: '5. Riepilogo & Invio' },
                ].map(({ n, label }) => (
                  <div
                    key={n}
                    className={`col pb-2 border-bottom-2 ${
                      wizStep === n
                        ? 'border-primary fw-bold text-primary border-bottom'
                        : wizStep > n
                        ? 'border-success text-success fw-semibold border-bottom'
                        : 'text-muted'
                    }`}
                    style={{ cursor: wizStep > n ? 'pointer' : 'default', userSelect: 'none', transition: 'color 0.15s' }}
                    onClick={() => { if (wizStep > n) setWizStep(n); }}
                    title={wizStep > n ? `Torna al passo ${n}` : undefined}
                  >
                    {wizStep > n && <i className="fas fa-check me-1" style={{ fontSize: '0.7rem' }}></i>}
                    {label}
                  </div>
                ))}
              </div>

              {/* STEP 1: DETTAGLI & CANALE */}
              {wizStep === 1 && (
                <div style={{ maxWidth: '600px', margin: '0 auto' }}>
                  <h4 className="h6 fw-bold text-dark mb-3">Passo 1: Dettagli della Campagna & Canale Principale</h4>
                  <div className="mb-3">
                    <label className="form-label small fw-bold">Nome della Campagna *</label>
                    <input
                      type="text"
                      className="form-control form-control-sm"
                      placeholder="Es: Avviso TARI 2026 Montesilvano"
                      value={wizName}
                      onChange={e => setWizName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="mb-3">
                    <label className="form-label small fw-semibold text-muted">Descrizione / Note Interne</label>
                    <textarea
                      className="form-control form-control-sm"
                      rows={3}
                      placeholder="Es: Invio massivo TARI acconto per i cittadini residenti..."
                      value={wizDesc}
                      onChange={e => setWizDesc(e.target.value)}
                    ></textarea>
                  </div>
                  <div className="mb-3">
                    <label className="form-label small fw-bold">Canale di Invio Principale *</label>
                    <select
                      className="form-select form-select-sm"
                      value={wizChannel}
                      onChange={(e: any) => {
                        const newChan = e.target.value as any;
                        setWizChannel(newChan);
                        const activeCfg = mailConfigs.find(c => c.type === newChan && c.active);
                        setWizMailConfigId(activeCfg?.id || '');
                        setWizBlockedChannels(prev => prev.filter(x => x !== newChan));
                        if (newChan === 'SEND') setWizProtocolla(true);
                      }}
                    >
                      <option value="EMAIL">EMAIL</option>
                      <option value="PEC">PEC (Posta Elettronica Certificata)</option>
                      <option value="APP_IO">APP IO (PagoPA)</option>
                      <option value="SEND">SEND</option>
                      <option value="POSTAL">POSTAL</option>
                    </select>
                  </div>

                  <div className="form-check mb-3">
                    <input
                      type="checkbox"
                      className="form-check-input"
                      id="wiz_protocolla"
                      checked={wizProtocolla}
                      disabled={wizChannel === 'SEND'}
                      onChange={(e) => setWizProtocolla(e.target.checked)}
                    />
                    <label className="form-check-label small" htmlFor="wiz_protocolla">
                      Protocolla questo invio
                      {wizChannel === 'SEND' && (
                        <span className="text-muted"> (obbligatorio per SEND: ogni invio viene registrato sul Protocollo Informatico prima della trasmissione)</span>
                      )}
                    </label>
                  </div>

                  <div className="form-check mb-3">
                    <input
                      type="checkbox"
                      className="form-check-input"
                      id="wiz-payment-enabled"
                      checked={wizPaymentEnabled}
                      onChange={e => {
                        setWizPaymentEnabled(e.target.checked);
                        // La lista tassonomie si rifiltra su P/N in base a questo toggle:
                        // una tassonomia già selezionata per lo stato precedente può non
                        // essere più valida, va fatta riselezionare.
                        setWizTaxonomyCode('');
                      }}
                    />
                    <label className="form-check-label small fw-bold" htmlFor="wiz-payment-enabled" style={{ cursor: 'pointer' }}>
                      Integrazione pagamenti pagoPA
                    </label>
                    <div className="form-text small text-muted">Il mapping delle colonne CSV per importo/avviso/CF ente si configura allo step 3.</div>
                  </div>

                  {wizChannel === 'SEND' && (
                    <>
                      <div className="mb-3">
                        <label className="form-label small fw-bold">Tassonomia SEND *</label>
                        <select
                          className="form-select form-select-sm"
                          value={wizTaxonomyCode}
                          onChange={e => setWizTaxonomyCode(e.target.value)}
                          required
                        >
                          <option value="">-- Seleziona tassonomia --</option>
                          {settSendTaxonomies
                            .filter(t => t.code.endsWith(wizPaymentEnabled ? 'P' : 'N'))
                            .map(t => (
                              <option key={t.code} value={t.code}>{t.code} — {t.label}</option>
                            ))}
                        </select>
                        {settSendTaxonomies.filter(t => t.code.endsWith(wizPaymentEnabled ? 'P' : 'N')).length === 0 && (
                          <div className="form-text text-danger small">
                            Nessuna tassonomia {wizPaymentEnabled ? 'con pagamento (P)' : 'senza pagamento (N)'} abilitata. Configurale in Impostazioni → SEND.
                          </div>
                        )}
                      </div>

                      <div className="mb-3">
                        <label className="form-label small fw-bold">Tipo comunicazione fisica (fallback se la consegna digitale fallisce)</label>
                        <select
                          className="form-select form-select-sm"
                          value={wizPhysicalCommunicationType}
                          onChange={e => setWizPhysicalCommunicationType(e.target.value as any)}
                        >
                          <option value="AR_REGISTERED_LETTER">Raccomandata A/R</option>
                          <option value="REGISTERED_LETTER_890">Notifica ex L.890/1982</option>
                        </select>
                        <div className="alert alert-info small mt-2 mb-0">
                          Il costo del cartaceo si applica solo se la consegna digitale fallisce del tutto, e varia per regione/zona di recapito.
                          In generale la <strong>raccomandata A/R</strong> è più economica della <strong>890</strong> a parità di peso.
                          Consulta il <a href="https://notifichedigitali.pagopa.it/static/documents/Prezzi%20Ente%202024.pdf" target="_blank" rel="noreferrer">listino ufficiale aggiornato</a> per le tariffe esatte del tuo lotto/regione.
                        </div>
                      </div>
                    </>
                  )}

                  {wizChannel === 'POSTAL' && (
                    <div className="row g-3 mb-3">
                      <div className="col-md-4">
                        <label className="form-label small fw-bold">Tipo di invio</label>
                        <select className="form-select" value={wizPostalServiceType}
                          onChange={(e) => setWizPostalServiceType(e.target.value as 'Raccomandata' | 'Lettera')}>
                          <option value="Raccomandata">Raccomandata</option>
                          <option value="Lettera">Lettera (ordinaria)</option>
                        </select>
                      </div>
                      {wizPostalServiceType === 'Raccomandata' && (
                        <div className="col-md-4 d-flex align-items-end">
                          <div className="form-check">
                            <input className="form-check-input" type="checkbox" id="wizPostalAR"
                              checked={wizPostalReturnReceipt} onChange={(e) => setWizPostalReturnReceipt(e.target.checked)} />
                            <label className="form-check-label small" htmlFor="wizPostalAR">Ricevuta di ritorno (AR)</label>
                          </div>
                        </div>
                      )}
                      <div className="col-12"><hr /><span className="small text-muted fw-bold">Indirizzo destinatario (colonne CSV)</span></div>
                      <div className="col-md-3">
                        <label className="form-label small">Colonna indirizzo *</label>
                        <input className="form-control" placeholder="es. indirizzo" value={wizPostalAddressColumn} onChange={(e) => setWizPostalAddressColumn(e.target.value)} />
                      </div>
                      <div className="col-md-3">
                        <label className="form-label small">Colonna città *</label>
                        <input className="form-control" placeholder="es. comune" value={wizPostalMunicipalityColumn} onChange={(e) => setWizPostalMunicipalityColumn(e.target.value)} />
                      </div>
                      <div className="col-md-2">
                        <label className="form-label small">Colonna CAP</label>
                        <input className="form-control" placeholder="es. cap" value={wizPostalZipColumn} onChange={(e) => setWizPostalZipColumn(e.target.value)} />
                      </div>
                      <div className="col-md-2">
                        <label className="form-label small">Colonna provincia</label>
                        <input className="form-control" placeholder="es. prov" value={wizPostalProvinceColumn} onChange={(e) => setWizPostalProvinceColumn(e.target.value)} />
                      </div>
                      <div className="col-12"><hr /><span className="small text-muted fw-bold">Riconciliazione gestionale tributi (opzionale)</span></div>
                      <div className="col-md-4">
                        <label className="form-label small">Colonna riferimento (UserData1)</label>
                        <input className="form-control" placeholder="es. numero_avviso" value={wizPostalUserDataColumn} onChange={(e) => setWizPostalUserDataColumn(e.target.value)} />
                      </div>
                    </div>
                  )}

                  {(wizChannel === 'EMAIL' || wizChannel === 'PEC') && (
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Server di Invio / Mittente *</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizMailConfigId}
                        onChange={e => setWizMailConfigId(e.target.value)}
                        required
                      >
                        <option value="">-- Seleziona Configurazione Mittente --</option>
                        {mailConfigs
                          .filter(c => c.type === wizChannel && c.active)
                          .map(c => (
                            <option key={c.id} value={c.id}>
                              {c.name} ({c.fromAddress})
                            </option>
                          ))}
                      </select>
                      {mailConfigs.filter(c => c.type === wizChannel && c.active).length === 0 && (
                        <div className="form-text text-danger small">
                          Attenzione: non ci sono configurazioni attive per il canale {wizChannel}. Creane una nelle impostazioni.
                        </div>
                      )}
                    </div>
                  )}

                  {(wizChannel === 'EMAIL' || wizChannel === 'PEC') && (
                    <div className="card mb-3 border-light shadow-sm" style={{ background: '#f8f9fc' }}>
                      <div className="card-body p-3">
                        <h6 className="small fw-bold text-dark mb-3"><i className="fas fa-mobile-screen me-2 text-primary"></i>Co-consegna su App IO</h6>
                        <div className="mb-3">
                          <label className="form-label small">Modalità Co-consegna</label>
                          <select
                            className="form-select form-select-sm"
                            value={wizAppIoMode}
                            onChange={e => setWizAppIoMode(e.target.value as any)}
                          >
                            <option value="none">Disabilitata (Invia solo via {wizChannel})</option>
                            <option value="parallel">Parallela (Invia sia via {wizChannel} che via App IO)</option>
                            <option value="exclusive">Esclusiva (Invia su App IO se il cittadino è registrato, altrimenti ripiega su {wizChannel})</option>
                          </select>
                        </div>
                        {wizAppIoMode !== 'none' && (
                          <div className="mb-0">
                            <label className="form-label small fw-bold">Servizio App IO *</label>
                            <select
                              className="form-select form-select-sm"
                              value={wizAppIoServiceId}
                              onChange={e => setWizAppIoServiceId(e.target.value)}
                              required
                            >
                              <option value="">-- Seleziona Servizio App IO --</option>
                              {ioServices.map(s => (
                                <option key={s.id} value={s.id}>
                                  {s.nome} {s.isDefault ? '(Predefinito)' : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {wizAppIoMode !== 'none' && (
                          <div className="mt-3 pt-3 border-top">
                            <div className="form-check mb-2">
                              <input
                                type="checkbox"
                                className="form-check-input"
                                id="wiz-appio-differentiate"
                                checked={wizAppIoDifferentiate}
                                onChange={e => setWizAppIoDifferentiate(e.target.checked)}
                              />
                              <label className="form-check-label small" htmlFor="wiz-appio-differentiate">
                                Differenzia oggetto e testo per App IO (altrimenti usa lo stesso di {wizChannel})
                              </label>
                            </div>
                            {wizAppIoDifferentiate && (
                              <>
                                <div className="mb-2">
                                  <label className="form-label small fw-bold">Oggetto App IO *</label>
                                  <input
                                    type="text"
                                    className="form-control form-control-sm"
                                    value={wizAppIoSubjectOverride}
                                    onChange={e => setWizAppIoSubjectOverride(e.target.value)}
                                    placeholder="Es: Avviso TARI - %%nominativo%%"
                                    required
                                  />
                                </div>
                                <div className="mb-0">
                                  <label className="form-label small fw-bold">Testo App IO * (markdown)</label>
                                  <textarea
                                    className="form-control form-control-sm"
                                    rows={3}
                                    value={wizAppIoBodyOverride}
                                    onChange={e => setWizAppIoBodyOverride(e.target.value)}
                                    placeholder="Testo dedicato per il messaggio App IO..."
                                    required
                                  />
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {wizChannel === 'APP_IO' && (
                    <div className="mb-4">
                      <label className="form-label small fw-bold text-dark">Servizio App IO Associato *</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizAppIoServiceId}
                        onChange={e => setWizAppIoServiceId(e.target.value)}
                        required
                      >
                        <option value="">-- Seleziona Servizio App IO --</option>
                        {ioServices.map(s => (
                          <option key={s.id} value={s.id}>
                            {s.nome} {s.isDefault ? '(Predefinito)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="card mb-3 border-light shadow-sm">
                    <div className="card-body p-3">
                      <h6 className="small fw-bold text-dark mb-2"><i className="fas fa-ban me-2 text-danger"></i>Canali di Spedizione Bloccati</h6>
                      <p className="small text-muted mb-3">Seleziona i canali alternativi o primari che non devono ricevere l'invio (utile ad esempio per bloccare l'invio postale cartaceo).</p>
                      <div className="d-flex gap-3 flex-wrap">
                        {['EMAIL', 'PEC', 'APP_IO', 'SEND', 'POSTAL'].map(c => {
                          const isPrimary = wizChannel === c;
                          const isBlocked = wizBlockedChannels.includes(c);
                          return (
                            <div key={c} className="form-check">
                              <input
                                type="checkbox"
                                className="form-check-input"
                                id={`chk_block_${c}`}
                                checked={isBlocked}
                                disabled={isPrimary}
                                onChange={e => {
                                  if (e.target.checked) {
                                    setWizBlockedChannels([...wizBlockedChannels, c]);
                                  } else {
                                    setWizBlockedChannels(wizBlockedChannels.filter(x => x !== c));
                                  }
                                }}
                              />
                              <label className={`form-check-label small ${isPrimary ? 'text-muted' : ''}`} htmlFor={`chk_block_${c}`}>
                                {c} {isPrimary && '(Primario)'}
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-top d-flex justify-content-end">
                    <button
                      className="btn btn-primary"
                      onClick={() => setWizStep(2)}
                      disabled={
                        !wizName ||
                        ((wizChannel === 'EMAIL' || wizChannel === 'PEC') && !wizMailConfigId) ||
                        ((wizChannel === 'EMAIL' || wizChannel === 'PEC') && wizAppIoMode !== 'none' && !wizAppIoServiceId) ||
                        (wizChannel === 'APP_IO' && !wizAppIoServiceId)
                      }
                    >
                      Avanti <i className="fas fa-arrow-right ms-1"></i>
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 2: CARICAMENTO FILE */}
              {wizStep === 2 && (
                <div style={{ maxWidth: '600px', margin: '0 auto' }}>
                  <h4 className="h6 fw-bold text-dark mb-3">Passo 2: Caricamento File Destinatari (CSV)</h4>
                  <div className="p-4 border rounded bg-light text-center mb-4">
                    <i className="fas fa-file-csv fa-3x text-muted mb-3"></i>
                    <p className="small text-muted mb-3">Seleziona il file CSV contenente l'elenco dei destinatari della TARI.</p>
                    {wizCsvFile ? (
                      <div className="d-flex flex-column align-items-center mt-3">
                        <div className="badge bg-success p-2 mb-2">
                          <i className="fas fa-check-circle me-1"></i> {wizCsvFile.name} ({wizCsvRows.length} righe rilevate)
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-danger px-2"
                          onClick={() => {
                            setWizCsvFile(null);
                            setWizCsvHeaders([]);
                            setWizCsvRows([]);
                            setWizMapping({ codice_fiscale: '', full_name: '', full_name_2: '', email: '', pec: '', subject: '' });
                            setWizAttachments([]);
                            const input = document.getElementById('wiz_csv_input') as HTMLInputElement;
                            if (input) input.value = '';
                          }}
                        >
                          <i className="fas fa-trash me-1"></i> Rimuovi file
                        </button>
                      </div>
                    ) : (
                      <input
                        type="file"
                        id="wiz_csv_input"
                        accept=".csv"
                        className="form-control form-control-sm mx-auto"
                        style={{ maxWidth: '350px' }}
                        onChange={handleWizCsvChange}
                      />
                    )}
                    <div className="form-check d-flex justify-content-center gap-2 mt-3">
                      <input
                        type="checkbox"
                        className="form-check-input"
                        id="wiz_csv_headers"
                        checked={wizCsvHasHeaders}
                        onChange={e => {
                          const checked = e.target.checked;
                          setWizCsvHasHeaders(checked);
                          if (wizCsvFile) {
                            parseCsvFile(wizCsvFile, checked);
                          }
                        }}
                      />
                      <label className="form-check-label small text-muted" htmlFor="wiz_csv_headers">
                        Il file CSV contiene una riga di intestazione (Header)
                      </label>
                    </div>
                  </div>



                  <div className="mt-4 pt-3 border-top d-flex justify-content-between">
                    <button className="btn btn-outline-secondary" onClick={() => setWizStep(1)}>
                      <i className="fas fa-arrow-left me-1"></i> Indietro
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={() => setWizStep(3)}
                      disabled={!wizCsvFile}
                    >
                      Avanti <i className="fas fa-arrow-right ms-1"></i>
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 3: MAPPATURA & VALIDAZIONE */}
              {wizStep === 3 && (
                <div style={{ maxWidth: '700px', margin: '0 auto' }}>
                  <h4 className="h6 fw-bold text-dark mb-3">Passo 3: Associazione Colonne CSV & Validazione Formale</h4>
                  
                  <div className="row g-3 mb-4">
                    <div className="col-md-6">
                      <label className="form-label small fw-bold">Codice Fiscale { (wizChannel === 'APP_IO' || wizChannel === 'SEND') ? '*' : '(Consigliato)' }</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizMapping.codice_fiscale}
                        onChange={e => handleWizMappingChange('codice_fiscale', e.target.value)}
                        required={wizChannel === 'APP_IO' || wizChannel === 'SEND'}
                      >
                        <option value="">-- Seleziona Colonna CF --</option>
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                      </select>
                    </div>

                    <div className="col-md-6">
                      <label className="form-label small fw-bold">Nominativo (Cognome o Completo) *</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizMapping.full_name}
                        onChange={e => handleWizMappingChange('full_name', e.target.value)}
                        required
                      >
                        <option value="">-- Seleziona Colonna Cognome/Completo --</option>
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                      </select>
                    </div>

                    <div className="col-md-6">
                      <label className="form-label small fw-semibold text-muted">Nominativo (Nome - Opzionale)</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizMapping.full_name_2}
                        onChange={e => handleWizMappingChange('full_name_2', e.target.value)}
                      >
                        <option value="">-- Seleziona Colonna Nome (Opzionale) --</option>
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                      </select>
                    </div>

                    <div className="col-md-6">
                      <label className="form-label small fw-bold">Indirizzo E-mail { wizChannel === 'EMAIL' ? '*' : '(Opzionale)' }</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizMapping.email}
                        onChange={e => handleWizMappingChange('email', e.target.value)}
                        required={wizChannel === 'EMAIL'}
                      >
                        <option value="">-- Seleziona Colonna Email --</option>
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                      </select>
                    </div>

                    <div className="col-md-6">
                      <label className="form-label small fw-bold">Indirizzo PEC { wizChannel === 'PEC' ? '*' : '(Opzionale)' }</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizMapping.pec}
                        onChange={e => handleWizMappingChange('pec', e.target.value)}
                        required={wizChannel === 'PEC'}
                      >
                        <option value="">-- Seleziona Colonna PEC --</option>
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                      </select>
                    </div>

                    {wizChannel === 'SEND' && (
                      <div className="col-md-6">
                        <label className="form-label small fw-semibold text-muted">Oggetto (per destinatario - Opzionale)</label>
                        <select
                          className="form-select form-select-sm"
                          value={wizMapping.subject}
                          onChange={e => handleWizMappingChange('subject', e.target.value)}
                        >
                          <option value="">-- Usa template unico (Passo 4) --</option>
                          {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                        </select>
                        <div className="form-text small text-muted">Se una riga ha questa colonna vuota, viene usato l'Oggetto generico del Passo 4.</div>
                      </div>
                    )}

                    <div className="col-12">
                      <label className="form-label small fw-semibold text-muted">Colonne Allegato (una o più, con etichetta)</label>
                      <div className="border rounded p-2" style={{ maxHeight: '220px', overflowY: 'auto' }}>
                        {wizCsvHeaders.map(h => {
                          const existingIndex = wizAttachments.findIndex(a => a.key === h);
                          const isSelected = existingIndex !== -1;
                          return (
                            <div key={h} className="d-flex align-items-center gap-2 mb-1">
                              <div className="form-check mb-0">
                                <input
                                  type="checkbox"
                                  className="form-check-input"
                                  id={`wiz-attach-${h}`}
                                  checked={isSelected}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setWizAttachments(prev => [...prev, { key: h, label: '' }]);
                                    } else {
                                      setWizAttachments(prev => prev.filter(a => a.key !== h));
                                    }
                                  }}
                                />
                                <label htmlFor={`wiz-attach-${h}`} className="form-check-label small" style={{ cursor: 'pointer' }}>
                                  {wizColumnOptionLabel(h)}
                                </label>
                              </div>
                              {isSelected && (
                                <input
                                  type="text"
                                  className="form-control form-control-sm"
                                  style={{ maxWidth: '220px' }}
                                  placeholder="Etichetta (es: Tassa, Ruolo)"
                                  value={wizAttachments[existingIndex].label}
                                  onChange={(e) => {
                                    const label = e.target.value;
                                    setWizAttachments(prev => prev.map(a => (a.key === h ? { ...a, label } : a)));
                                  }}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="form-text small text-muted">
                        Ordine di selezione = %%allegato1%%, %%allegato2%%, ... nel template. Etichetta obbligatoria per usare il blocco "Elenco Allegati".
                      </div>
                    </div>
                  </div>

                  {(wizChannel === 'APP_IO' || wizChannel === 'SEND' || (wizAppIoMode && wizAppIoMode !== 'none')) && (
                    <div className="card border-light shadow-sm mb-4" style={{ background: '#f8f9fc' }}>
                      <div className="card-body p-3">
                        <h6 className="small fw-bold text-dark mb-3">
                          <i className="fas fa-credit-card me-2 text-primary"></i>Integrazione Pagamenti pagoPA (Opzionale)
                        </h6>

                        {wizPaymentEnabled && (
                          <div className="row g-2">
                            <div className="col-md-6">
                              <label className="form-label small fw-bold">Colonna Importo *</label>
                              <select
                                className="form-select form-select-sm"
                                value={wizPaymentAmountCol}
                                onChange={e => setWizPaymentAmountCol(e.target.value)}
                                required
                              >
                                <option value="">-- Seleziona Colonna Importo --</option>
                                {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                              </select>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold">Formato Importo *</label>
                              <select
                                className="form-select form-select-sm"
                                value={wizPaymentAmountType}
                                onChange={e => setWizPaymentAmountType(e.target.value as any)}
                                required
                              >
                                <option value="euro">Euro (es: 120.50)</option>
                                <option value="cents">Centesimi di Euro (es: 12050)</option>
                              </select>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold">Colonna Codice Avviso / IUV *</label>
                              <select
                                className="form-select form-select-sm"
                                value={wizPaymentNoticeCol}
                                onChange={e => setWizPaymentNoticeCol(e.target.value)}
                                required
                              >
                                <option value="">-- Seleziona Colonna IUV --</option>
                                {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                              </select>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small">Colonna Data Scadenza (Opzionale)</label>
                              <select
                                className="form-select form-select-sm"
                                value={wizPaymentDueDateCol}
                                onChange={e => setWizPaymentDueDateCol(e.target.value)}
                              >
                                <option value="">-- Nessuna Scadenza --</option>
                                {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                              </select>
                            </div>

                            <div className="col-md-6">
                              <label className="form-label small">Ente Creditore *</label>
                              <select
                                className="form-select form-select-sm"
                                value={wizPaymentPayeeType}
                                onChange={e => setWizPaymentPayeeType(e.target.value as any)}
                                required
                              >
                                <option value="static">Codice Fiscale Fisso</option>
                                <option value="column">Colonna Dinamica dal CSV</option>
                              </select>
                            </div>

                            <div className="col-md-6">
                              {wizPaymentPayeeType === 'static' ? (
                                <>
                                  <label className="form-label small fw-bold">Codice Fiscale Ente Creditore *</label>
                                  <input
                                    type="text"
                                    className="form-control form-control-sm"
                                    placeholder="Codice Fiscale Ente (es: 00223344556)"
                                    value={wizPaymentPayeeStatic}
                                    onChange={e => setWizPaymentPayeeStatic(e.target.value)}
                                    required
                                  />
                                </>
                              ) : (
                                <>
                                  <label className="form-label small fw-bold">Colonna Codice Fiscale Ente *</label>
                                  <select
                                    className="form-select form-select-sm"
                                    value={wizPaymentPayeeCol}
                                    onChange={e => setWizPaymentPayeeCol(e.target.value)}
                                    required
                                  >
                                    <option value="">-- Seleziona Colonna CF Ente --</option>
                                    {wizCsvHeaders.map(h => <option key={h} value={h}>{wizColumnOptionLabel(h)}</option>)}
                                  </select>
                                </>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Validation Panel */}
                  <div className="p-3 border rounded bg-light mb-4">
                    <h5 className="small fw-bold mb-2"><i className="fas fa-check-double text-success me-1"></i>Validazione Formale dei Campi</h5>
                    <p className="small text-muted mb-3">Verrà verificata la sintassi di E-mail, PEC e Codice Fiscale per escludere record malformati.</p>
                    <button className="btn btn-sm btn-outline-success" onClick={handleWizValidation}>
                      <i className="fas fa-shield-alt me-1"></i> Esegui Controllo e Valida
                    </button>

                    {wizValidationErrors.length > 0 && (
                      <div className="mt-3">
                        <div className="alert alert-warning py-2 small mb-3 d-flex justify-content-between align-items-center">
                          <div>
                            <i className="fas fa-exclamation-triangle me-1"></i> Trovati <strong>{wizValidationErrors.length}</strong> errori di validazione formale! I record con errori verranno esclusi dall'invio.
                          </div>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger fw-bold ms-3"
                            style={{ fontSize: '0.8rem' }}
                            onClick={downloadErrorsCsv}
                          >
                            <i className="fas fa-download me-1"></i> Scarica Righe Errate (CSV)
                          </button>
                        </div>
                        <div className="table-responsive" style={{ maxHeight: '200px' }}>
                          <table className="table table-striped table-sm align-middle mb-0" style={{ fontSize: '0.78rem' }}>
                            <thead className="table-dark">
                              <tr>
                                <th>Riga</th>
                                <th>Campo</th>
                                <th>Valore Rilevato</th>
                                <th>Errore Riscontrato</th>
                              </tr>
                            </thead>
                            <tbody>
                              {wizValidationErrors.map((err, idx) => (
                                <tr key={idx} className="table-danger-light">
                                  <td className="fw-bold">{err.row}</td>
                                  <td className="fw-bold">{err.field}</td>
                                  <td className="text-danger fw-mono">{err.val || 'VUOTO'}</td>
                                  <td>{err.err}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {wizValidRows.length > 0 && wizValidationErrors.length === 0 && wizValidationWarnings.length === 0 && (
                      <div className="alert alert-success py-2 small mt-3 mb-0">
                        <i className="fas fa-check-circle me-1"></i> Tutti i {wizValidRows.length} record sono formalmente corretti e pronti per il passo successivo!
                      </div>
                    )}

                    {wizValidationWarnings.length > 0 && (
                      <div className="mt-3">
                        <div className="alert alert-warning py-2 small mb-3 d-flex justify-content-between align-items-center">
                          <div>
                            <i className="fas fa-exclamation-circle me-1"></i> <strong>{wizValidationWarnings.length}</strong> record con formato CF/P.IVA non standard: verranno inclusi nell'invio ma potrebbero non essere abbinati correttamente.
                          </div>
                        </div>
                        <div className="table-responsive" style={{ maxHeight: '180px' }}>
                          <table className="table table-striped table-sm align-middle mb-0" style={{ fontSize: '0.78rem' }}>
                            <thead className="table-warning">
                              <tr>
                                <th>Riga</th>
                                <th>Campo</th>
                                <th>Valore Rilevato</th>
                                <th>Avviso</th>
                              </tr>
                            </thead>
                            <tbody>
                              {wizValidationWarnings.map((w, idx) => (
                                <tr key={idx}>
                                  <td className="fw-bold">{w.row}</td>
                                  <td className="fw-bold">{w.field}</td>
                                  <td className="text-warning fw-mono">{w.val || 'VUOTO'}</td>
                                  <td>{w.warn}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {wizValidRows.length > 0 && wizValidationErrors.length > 0 && (
                      <div className="alert alert-info py-2 small mt-3 mb-0">
                        <i className="fas fa-info-circle me-1"></i> Record validi pronti: <strong>{wizValidRows.length}</strong> su {wizCsvRows.length}.
                      </div>
                    )}
                  </div>

                  <div className="mt-4 pt-3 border-top d-flex justify-content-between">
                    <button className="btn btn-outline-secondary" onClick={() => setWizStep(2)}>
                      <i className="fas fa-arrow-left me-1"></i> Indietro
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={() => setWizStep(4)}
                      disabled={wizValidRows.length === 0}
                    >
                      Procedi a Template <i className="fas fa-arrow-right ms-1"></i>
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 4: TEMPLATE & ANTEPRIMA */}
              {wizStep === 4 && (
                <div className="row g-4">
                  <div className="col-lg-6 border-end">
                    <h4 className="h6 fw-bold text-dark mb-3">{wizChannel === 'SEND' ? 'Passo 4: Oggetto della Comunicazione' : 'Passo 4: Scrittura Template & Jolly Fields'}</h4>

                    <div className="mb-3">
                      <label className="form-label small fw-bold">Oggetto della Comunicazione (Template)</label>
                      <input
                        ref={subjectInputRef}
                        type="text"
                        className="form-control form-control-sm"
                        placeholder="Es: Avviso Scadenza TARI 2026 - %%nominativo%%"
                        value={wizSubject}
                        onChange={e => setWizSubject(e.target.value)}
                        onFocus={() => setWizLastFocusedField('subject')}
                        required
                      />
                    </div>

                    {wizChannel !== 'SEND' && (
                      <>
                        <div className="mb-3">
                          <label className="form-label small fw-bold">Corpo del Messaggio (Template)</label>
                          <TemplateEditor
                            value={wizBody}
                            onChange={setWizBody}
                            systemPlaceholders={[
                              ...(wizAttachments.length > 0 ? [{ label: 'Elenco Allegati', token: '%%elenco_allegati%%' }] : []),
                              ...wizAttachments.map((a, idx) => ({ label: `Link: ${a.label || `Allegato ${idx + 1}`}`, token: `%%allegato${idx + 1}%%` })),
                              { label: 'Nominativo', token: '%%nominativo%%' },
                              { label: 'Codice Fiscale', token: '%%codice_fiscale%%' },
                              ...(wizProtocolla ? [{ label: 'Numero di Protocollo', token: '%%numero_protocollo%%' }] : []),
                              ...(wizPaymentEnabled && wizPaymentNoticeCol ? [{ label: 'pagoPA: Numero Avviso', token: `%%${wizPaymentNoticeCol}%%` }] : []),
                              ...(wizPaymentEnabled && wizPaymentAmountCol ? [{ label: 'pagoPA: Importo', token: `%%${wizPaymentAmountCol}%%` }] : []),
                              ...(wizPaymentEnabled && wizPaymentDueDateCol ? [{ label: 'pagoPA: Data Scadenza', token: `%%${wizPaymentDueDateCol}%%` }] : []),
                              ...(wizPaymentEnabled && wizPaymentPayeeType === 'column' && wizPaymentPayeeCol ? [{ label: 'pagoPA: Codice Fiscale Ente', token: `%%${wizPaymentPayeeCol}%%` }] : []),
                            ]}
                            csvPlaceholders={wizCsvHeaders
                              .filter(h => {
                                const isMappedToSystem =
                                  h === wizMapping.codice_fiscale ||
                                  h === wizMapping.full_name ||
                                  h === wizMapping.full_name_2 ||
                                  h === wizMapping.email ||
                                  h === wizMapping.pec ||
                                  h === wizMapping.subject ||
                                  (wizPaymentEnabled && (
                                    h === wizPaymentNoticeCol ||
                                    h === wizPaymentAmountCol ||
                                    h === wizPaymentDueDateCol ||
                                    (wizPaymentPayeeType === 'column' && h === wizPaymentPayeeCol)
                                  )) ||
                                  wizAttachments.some(a => a.key === h);
                                return !isMappedToSystem;
                              })
                              .map(h => ({ label: `Colonna: ${h}`, token: `%%${h}%%` }))
                            }
                            wizLastFocusedField={wizLastFocusedField}
                            onInsertSubjectToken={insertTokenIntoSubject}
                            onFocusEditor={() => setWizLastFocusedField('body')}
                          />
                        </div>

                        {wizAppIoBodyLenInvalid && (
                          <div className="alert alert-warning py-2 small mb-0">
                            <i className="fas fa-exclamation-triangle me-1"></i>
                            Il testo per App IO deve essere lungo tra {APP_IO_MARKDOWN_MIN} e {APP_IO_MARKDOWN_MAX} caratteri
                            (attuale: {wizAppIoBodyLen}). PagoPA rifiuta messaggi più corti o più lunghi.
                          </div>
                        )}
                      </>
                    )}

                    <div className="mt-4 pt-3 border-top d-flex justify-content-between">
                      <button className="btn btn-outline-secondary" onClick={() => setWizStep(3)}>
                        <i className="fas fa-arrow-left me-1"></i> Indietro
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => setWizStep(5)}
                        disabled={!wizSubject || (wizChannel !== 'SEND' && (isWizBodyEmpty(wizBody) || wizAppIoBodyLenInvalid))}
                      >
                        Riepilogo <i className="fas fa-arrow-right ms-1"></i>
                      </button>
                    </div>
                  </div>

                  {/* Right Column: Live Preview with Paging */}
                  <div className="col-lg-6">
                    <h4 className="h6 fw-bold text-dark mb-2">Anteprima Live Destinatari ({wizValidRows.length} totali)</h4>
                    <p className="small text-muted mb-3">Sfoglia i record validi del CSV per vedere come verranno risolti i parametri Jolly. Anteprima renderizzata con lo stesso motore usato per l'invio reale (logo, footer e link inclusi).</p>

                    {(wizChannel === 'EMAIL' || wizChannel === 'PEC') && wizAppIoMode !== 'none' && (
                      <div className="btn-group btn-group-sm mb-3" role="group">
                        <button
                          type="button"
                          className={`btn ${wizPreviewChannelTab === 'MAIN' ? 'btn-primary' : 'btn-outline-secondary'}`}
                          onClick={() => setWizPreviewChannelTab('MAIN')}
                        >
                          <i className="fas fa-envelope me-1"></i> {wizChannel}
                        </button>
                        <button
                          type="button"
                          className={`btn ${wizPreviewChannelTab === 'APP_IO' ? 'btn-primary' : 'btn-outline-secondary'}`}
                          onClick={() => setWizPreviewChannelTab('APP_IO')}
                        >
                          <i className="fas fa-mobile-screen me-1"></i> App IO
                        </button>
                      </div>
                    )}

                    <div className="d-flex align-items-center justify-content-between p-2 border rounded bg-light mb-3">
                      <button
                        className="btn btn-sm btn-outline-secondary"
                        disabled={wizPreviewIndex === 0}
                        onClick={() => setWizPreviewIndex(i => Math.max(0, i - 1))}
                      >
                        <i className="fas fa-chevron-left"></i> Prec.
                      </button>
                      <span className="small fw-bold">Record {wizPreviewIndex + 1} di {wizValidRows.length}</span>
                      <button
                        className="btn btn-sm btn-outline-secondary"
                        disabled={wizPreviewIndex >= wizValidRows.length - 1}
                        onClick={() => setWizPreviewIndex(i => Math.min(wizValidRows.length - 1, i + 1))}
                      >
                        Succ. <i className="fas fa-chevron-right"></i>
                      </button>
                    </div>

                    {wizValidRows[wizPreviewIndex] && (
                      <div className="border rounded p-3" style={{ background: '#f8fafc' }}>
                        <div className="mb-2 text-muted" style={{ fontSize: '0.8rem' }}>
                          <strong>A:</strong> {wizValidRows[wizPreviewIndex][wizMapping.email || ''] || wizValidRows[wizPreviewIndex][wizMapping.pec || ''] || 'N/A'}<br />
                          <strong>Oggetto:</strong> {wizPreviewLoading ? '...' : (wizPreviewResult?.subject ?? '')}
                        </div>
                        {wizPreviewLoading && !wizPreviewResult ? (
                          <div className="text-center text-muted small py-4">
                            <i className="fas fa-spinner fa-spin me-1"></i> Rendering anteprima...
                          </div>
                        ) : wizPreviewChannelTab === 'APP_IO' ? (
                          <div className="bg-white border rounded p-3" data-color-mode="light">
                            <MDEditor.Markdown source={wizPreviewResult?.bodyMarkdown ?? ''} />
                          </div>
                        ) : wizPreviewResult?.bodyHtml ? (
                          <div
                            className="bg-white border rounded overflow-hidden"
                            style={{ padding: '4px' }}
                            dangerouslySetInnerHTML={{ __html: wizPreviewResult.bodyHtml }}
                          />
                        ) : wizPreviewResult?.bodyMarkdown ? (
                          // Copre wizChannel === 'APP_IO' diretto (senza co-consegna, tab mai mostrate).
                          // Nota: renderizza col motore %placeholder%/processTemplate del backend, non
                          // rappresentativo del canale App IO diretto reale, che invia via AppIoStrategy
                          // con sintassi {{mustache}} diversa — gap noto, vedi Global Constraints del
                          // piano "Fix Anteprima Email/PEC".
                          <div className="bg-white border rounded p-3" data-color-mode="light">
                            <MDEditor.Markdown source={wizPreviewResult.bodyMarkdown} />
                          </div>
                        ) : (
                          <div className="text-center text-muted small py-4">Nessuna anteprima disponibile per questo canale.</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* STEP 5: RIEPILOGO & SPEDIZIONE */}
              {wizStep === 5 && (
                <div style={{ maxWidth: '600px', margin: '0 auto' }}>
                  <h4 className="h6 fw-bold text-dark mb-3"><i className="fas fa-check-circle text-success me-2"></i>Passo 5: Riepilogo & Messa in Coda</h4>
                  
                  <div className="border rounded bg-light p-4 mb-4" style={{ fontSize: '0.9rem' }}>
                    <div className="mb-2"><strong>Nome Campagna:</strong> {wizName}</div>
                    <div className="mb-2"><strong>Canale di Trasmissione:</strong> {wizChannel}</div>
                    <div className="mb-2"><strong>File Destinatari:</strong> {wizCsvFile?.name} (<strong>{wizValidRows.length}</strong> record pronti per l'invio)</div>
                    {wizValidationErrors.length > 0 && (
                      <div className="mb-2 text-warning">
                        <i className="fas fa-exclamation-triangle me-1"></i> {wizValidationErrors.length} righe verranno escluse perché non hanno superato i controlli formali.
                      </div>
                    )}
                    {wizPdfFiles.length > 0 && (
                      <div className="mb-2 text-primary">
                        <i className="fas fa-paperclip me-1"></i> Allegati PDF caricati: <strong>{wizPdfFiles.length} file</strong>
                      </div>
                    )}
                    {wizMapping.codice_fiscale && (
                      <div className="mb-2 text-success">
                        <i className="fas fa-mobile-alt me-1"></i> Co-delivery App IO configurata (invio parallelo per utenti abilitati)
                      </div>
                    )}
                    <div className="mt-3 pt-3 border-top">
                      <strong>Anteprima Oggetto (Record 1):</strong>
                      <div className="p-2 border bg-white rounded mt-1 small text-muted">
                        {wizSubject.replace(/%([^%()]+)%/gi, (match, key) => {
                          const k = key.toLowerCase().trim();
                          if (k === 'nominativo' || k === 'full_name') return getWizRowFullName(wizValidRows[0]);
                          if (k === 'codice_fiscale' || k === 'cf') return wizValidRows[0]?.[wizMapping.codice_fiscale] || '';
                          return wizValidRows[0]?.[key] || match;
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="card shadow-sm border-warning mb-4">
                    <div className="card-header bg-warning-subtle py-2">
                      <h5 className="card-title small fw-bold mb-0 text-warning-emphasis">
                        <i className="fas fa-paperclip me-1"></i> Carica gli Allegati PDF per questa Spedizione
                      </h5>
                    </div>
                    <div className="card-body p-3">
                      <p className="small text-muted mb-2">
                        Seleziona o trascina qui i file PDF degli avvisi individuali (es. estratti dal desktop) oppure
                        un unico file ZIP che li contiene tutti (consigliato per molti destinatari).
                        Il nome del file PDF deve corrispondere a quello indicato nella colonna mappata del CSV.
                      </p>
                      <input
                        type="file"
                        accept=".pdf,.zip"
                        multiple
                        className="form-control form-control-sm"
                        onChange={e => setWizPdfFiles(Array.from(e.target.files || []))}
                      />
                      <div className="form-text small text-muted">Puoi selezionare e caricare più file PDF o uno ZIP contemporaneamente.</div>
                      {wizPdfFiles.length > 0 && (
                        <div className="badge bg-primary mt-2 p-2 w-100 text-start">
                          <i className="fas fa-file-pdf me-1"></i> {wizPdfFiles.length} allegati pronti per il caricamento
                        </div>
                      )}
                    </div>
                  </div>

                  {wizUploadProgress && (
                    <div className="mb-3">
                      <div className="d-flex justify-content-between small text-muted mb-1">
                        <span>{wizUploadProgress.label}...</span>
                        <span>
                          {(wizUploadProgress.loaded / (1024 * 1024)).toFixed(1)} / {(wizUploadProgress.total / (1024 * 1024)).toFixed(1)} MB
                          {' '}({wizUploadProgress.total > 0 ? Math.round((wizUploadProgress.loaded / wizUploadProgress.total) * 100) : 0}%)
                        </span>
                      </div>
                      <div className="progress" style={{ height: '8px' }}>
                        <div
                          className="progress-bar"
                          role="progressbar"
                          style={{ width: `${wizUploadProgress.total > 0 ? Math.min(100, (wizUploadProgress.loaded / wizUploadProgress.total) * 100) : 0}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="mt-4 pt-3 border-top d-flex justify-content-between">
                    <button
                      className="btn btn-outline-secondary"
                      onClick={() => setWizStep(4)}
                      disabled={wizSending}
                    >
                      <i className="fas fa-arrow-left me-1"></i> Indietro
                    </button>
                    <button
                      className="btn btn-success"
                      onClick={handleWizLaunch}
                      disabled={wizSending}
                    >
                      {wizSending ? (
                        <>
                          <i className="fas fa-spinner fa-spin me-1"></i>
                          {wizUploadProgress ? `${wizUploadProgress.label}...` : 'Spedizione in corso...'}
                        </>
                      ) : (
                        <><i className="fas fa-paper-plane me-1"></i>Conferma ed Avvia Campagna</>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* VIEW: STATISTICHE */}
          {view === 'statistiche' && (
            <div>
              <div className="card shadow-sm p-3 mb-3">
                <div className="row g-2 align-items-end">
                  <div className="col-md-3">
                    <label className="form-label small mb-1">Da</label>
                    <input type="date" className="form-control form-control-sm" value={statsDateFrom} onChange={e => setStatsDateFrom(e.target.value)} />
                  </div>
                  <div className="col-md-3">
                    <label className="form-label small mb-1">A</label>
                    <input type="date" className="form-control form-control-sm" value={statsDateTo} onChange={e => setStatsDateTo(e.target.value)} />
                  </div>
                  <div className="col-md-2">
                    <button className="btn btn-primary btn-sm w-100" onClick={fetchGlobalStats} disabled={globalStatsLoading}>
                      <i className="fas fa-filter me-1"></i>Applica
                    </button>
                  </div>
                </div>
              </div>

              {globalStatsLoading && !globalStats ? (
                <div className="text-center text-muted py-5">Caricamento statistiche…</div>
              ) : globalStats && (
                <>
                  <div className="row g-3 mb-4">
                    <div className="col-md-6 col-lg-3">
                      <div className="card shadow-sm text-center p-3">
                        <span className="text-muted small">Notifiche Totali</span>
                        <h3 className="h2 mb-0 fw-bold text-primary">{globalStats.totals.totalRecipients}</h3>
                      </div>
                    </div>
                    <div className="col-md-6 col-lg-3">
                      <div className="card shadow-sm text-center p-3">
                        <span className="text-muted small">Invii Avvenuti (Successo)</span>
                        <h3 className="h2 mb-0 fw-bold text-success">{globalStats.totals.totalSent}</h3>
                      </div>
                    </div>
                    <div className="col-md-6 col-lg-3">
                      <div className="card shadow-sm text-center p-3">
                        <span className="text-muted small">Fallimenti totali</span>
                        <h3 className="h2 mb-0 fw-bold text-danger">{globalStats.totals.totalFailed}</h3>
                      </div>
                    </div>
                    <div className="col-md-6 col-lg-3">
                      <div className="card shadow-sm text-center p-3">
                        <span className="text-muted small">% Download</span>
                        <h3 className="h2 mb-0 fw-bold text-warning">{globalStats.totals.downloadPercentage}%</h3>
                      </div>
                    </div>
                  </div>

                  <div className="row g-3">
                    <div className="col-md-8">
                      <div className="card shadow-sm">
                        <div className="card-header bg-white py-3 border-bottom">
                          <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-chart-line me-2 text-primary"></i>Andamento Invii e Download</h3>
                        </div>
                        <div className="card-body">
                          <ResponsiveContainer width="100%" height={260}>
                            <LineChart data={globalStats.monthlyTrend}>
                              <CartesianGrid strokeDasharray="3 3" />
                              <XAxis dataKey="month" fontSize={11} />
                              <YAxis allowDecimals={false} />
                              <Tooltip />
                              <Legend />
                              <Line type="monotone" dataKey="sent" name="Invii" stroke="var(--bi-primary)" strokeWidth={2} />
                              <Line type="monotone" dataKey="downloaded" name="Download" stroke="var(--ms-green-600)" strokeWidth={2} />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>

                    <div className="col-md-4">
                      <div className="card shadow-sm">
                        <div className="card-header bg-white py-3 border-bottom">
                          <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-chart-pie me-2 text-primary"></i>Ripartizione Invii per Canale</h3>
                        </div>
                        <div className="card-body">
                          <ResponsiveContainer width="100%" height={220}>
                            <PieChart>
                              <Pie data={globalStats.channelTotals} dataKey="sent" nameKey="channel" outerRadius={80} label>
                                {globalStats.channelTotals.map((entry, idx) => (
                                  <Cell key={entry.channel} fill={PIE_COLORS[idx % PIE_COLORS.length]} />
                                ))}
                              </Pie>
                              <Tooltip />
                              <Legend />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="row g-3 mt-1">
                    <div className="col-md-8">
                      <div className="card shadow-sm">
                        <div className="card-header bg-white py-3 border-bottom">
                          <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-ranking-star me-2 text-primary"></i>Classifica Campagne per Tasso Download</h3>
                        </div>
                        <div className="card-body p-0">
                          <div className="table-responsive">
                            <table className="table table-sm mb-0">
                              <thead><tr><th>Campagna</th><th className="text-end">Destinatari</th><th className="text-end">% Download</th></tr></thead>
                              <tbody>
                                {globalStats.campaignLeaderboard.slice(0, 5).map(c => (
                                  <tr key={c.campaignId} style={{ cursor: 'pointer' }} onClick={() => handleCampaignClick(c.campaignId)}>
                                    <td>{c.campaignName}</td>
                                    <td className="text-end">{c.totalRecipients}</td>
                                    <td className="text-end fw-bold text-success">{c.downloadPercentage}%</td>
                                  </tr>
                                ))}
                                {globalStats.campaignLeaderboard.length === 0 && (
                                  <tr><td colSpan={3} className="text-center text-muted py-3">Nessuna campagna nel periodo selezionato</td></tr>
                                )}
                              </tbody>
                            </table>
                          </div>
                          {globalStats.campaignLeaderboard.length > 5 && (
                            <>
                              <div className="px-3 py-2 small text-muted border-top">Peggiori 5</div>
                              <div className="table-responsive">
                                <table className="table table-sm mb-0">
                                  <tbody>
                                    {globalStats.campaignLeaderboard.slice(Math.max(5, globalStats.campaignLeaderboard.length - 5)).reverse().map(c => (
                                      <tr key={c.campaignId} style={{ cursor: 'pointer' }} onClick={() => handleCampaignClick(c.campaignId)}>
                                        <td>{c.campaignName}</td>
                                        <td className="text-end">{c.totalRecipients}</td>
                                        <td className="text-end fw-bold text-danger">{c.downloadPercentage}%</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="col-md-4">
                      <div className="card shadow-sm">
                        <div className="card-header bg-white py-3 border-bottom">
                          <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-triangle-exclamation me-2 text-warning"></i>Mai Scaricato</h3>
                        </div>
                        <div className="card-body text-center">
                          <h3 className="h2 fw-bold text-danger">{globalStats.neverDownloadedCount}</h3>
                          <p className="small text-muted">Destinatari con invio riuscito ma nessun download nel periodo selezionato.</p>
                          <button className="btn btn-outline-danger btn-sm" onClick={handleExportNeverDownloaded}>
                            <i className="fas fa-file-csv me-1"></i>Esporta CSV
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {view === 'notifiche-ricerca' && (
            <div>
              <h3 className="h5 fw-bold text-dark mb-3"><i className="fas fa-magnifying-glass me-2"></i>Ricerca Notifiche</h3>
              <div className="card shadow-sm p-3 mb-3">
                <div className="row g-2">
                  <div className="col-md-3">
                    <input className="form-control form-control-sm" placeholder="Codice Fiscale" value={searchCf} onChange={e => setSearchCf(e.target.value)} />
                  </div>
                  <div className="col-md-2">
                    <input className="form-control form-control-sm" placeholder="ID Campagna" value={searchCampaignId} onChange={e => setSearchCampaignId(e.target.value)} />
                  </div>
                  <div className="col-md-2">
                    <select className="form-select form-select-sm" value={searchChannel} onChange={e => setSearchChannel(e.target.value)}>
                      <option value="">Tutti i canali</option>
                      <option value="EMAIL">EMAIL</option>
                      <option value="PEC">PEC</option>
                      <option value="APP_IO">APP IO</option>
                      <option value="SEND">SEND</option>
                      <option value="POSTAL">POSTAL</option>
                    </select>
                  </div>
                  <div className="col-md-3">
                    <select className="form-select form-select-sm" value={searchStatus} onChange={e => setSearchStatus(e.target.value)}>
                      <option value="">Tutti gli stati</option>
                      <option value="pending">In attesa</option>
                      <option value="queued">In coda</option>
                      <option value="sent">Inviato</option>
                      <option value="failed">Fallito</option>
                      <option value="skipped">Saltato</option>
                    </select>
                  </div>
                  <div className="col-md-2">
                    <input type="date" className="form-control form-control-sm" value={searchDateFrom} onChange={e => setSearchDateFrom(e.target.value)} title="Data da" />
                  </div>
                  <div className="col-md-2">
                    <input type="date" className="form-control form-control-sm" value={searchDateTo} onChange={e => setSearchDateTo(e.target.value)} title="Data a" />
                  </div>
                  <div className="col-md-2">
                    <button className="btn btn-primary btn-sm w-100" onClick={() => runNotificationSearch(1)} disabled={searchLoading}>
                      <i className="fas fa-search me-1"></i>Cerca
                    </button>
                  </div>
                </div>
              </div>
              <div className="card shadow-sm">
                <div className="table-responsive">
                  <table className="table table-sm mb-0">
                    <thead><tr><th>CF</th><th>Nome</th><th>Campagna</th><th>Canale</th><th>Stato</th><th>Data</th></tr></thead>
                    <tbody>
                      {searchResults.map(r => (
                        <tr key={r.recipientId} style={{ cursor: 'pointer' }} onClick={() => openNotificationDetail(r.recipientId)}>
                          <td className="font-monospace small">{r.codiceFiscale}</td>
                          <td className="small">{r.fullName || '—'}</td>
                          <td className="small">{r.campaignName}</td>
                          <td><ChannelBadge channel={r.channelType} /></td>
                          <td><StatusBadge status={r.status} /></td>
                          <td className="small text-muted">{new Date(r.createdAt).toLocaleString('it-IT')}</td>
                        </tr>
                      ))}
                      {searchResults.length === 0 && <tr><td colSpan={6} className="text-center text-muted py-3">{searchLoading ? 'Caricamento…' : 'Nessun risultato'}</td></tr>}
                    </tbody>
                  </table>
                </div>
                {searchTotal > 0 && (
                  <div className="d-flex justify-content-between align-items-center p-2 border-top small text-muted">
                    <span>
                      {(searchPage - 1) * SEARCH_PAGE_SIZE + 1}–{Math.min(searchPage * SEARCH_PAGE_SIZE, searchTotal)} di {searchTotal}
                    </span>
                    <div className="btn-group">
                      <button className="btn btn-outline-secondary btn-sm" onClick={() => runNotificationSearch(searchPage - 1)} disabled={searchLoading || searchPage <= 1}>
                        <i className="fas fa-chevron-left"></i> Precedente
                      </button>
                      <button className="btn btn-outline-secondary btn-sm" onClick={() => runNotificationSearch(searchPage + 1)} disabled={searchLoading || searchPage * SEARCH_PAGE_SIZE >= searchTotal}>
                        Successiva <i className="fas fa-chevron-right"></i>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {(notifDetailLoading || notifDetail) && (
            <div className="modal fade show d-block" style={{ background: 'rgba(0,0,0,0.5)' }} tabIndex={-1}>
              <div className="modal-dialog modal-lg modal-dialog-scrollable">
                <div className="modal-content">
                  <div className="modal-header">
                    <h5 className="modal-title">Dettaglio Notifica</h5>
                    <button type="button" className="btn-close" onClick={() => setNotifDetail(null)}></button>
                  </div>
                  <div className="modal-body">
                    {notifDetailLoading ? (
                      <div className="text-center text-muted py-4"><i className="fas fa-spinner fa-spin me-1"></i>Caricamento...</div>
                    ) : notifDetail && (
                      <>
                        <div className="mb-3">
                          <div><strong>Destinatario:</strong> {notifDetail.recipient.fullName || notifDetail.recipient.codiceFiscale} ({notifDetail.recipient.codiceFiscale})</div>
                          <div><strong>Campagna:</strong> {notifDetail.campaign.name} <span className="ms-1"><ChannelBadge channel={notifDetail.campaign.channelType} /></span></div>
                        </div>

                        <h6 className="fw-bold small">Storico Tentativi</h6>
                        <div className="table-responsive">
                          <table className="table table-sm mb-4">
                            <thead>
                              <tr>
                                <th>#</th><th>Stato</th><th>Canale</th><th>Data</th>
                                {notifDetail.campaign.channelType === 'SEND' && (
                                  <><th>IUN</th><th>Protocollo</th><th>Stato SEND</th><th>Aggiornato il</th></>
                                )}
                                <th>Errore</th>
                              </tr>
                            </thead>
                            <tbody>
                              {notifDetail.attempts.map((a) => (
                                <React.Fragment key={a.attemptNumber}>
                                  <tr>
                                    <td>{a.attemptNumber}</td>
                                    <td><StatusBadge status={a.status} /></td>
                                    <td className="small"><ChannelBadge channel={a.channelType} /></td>
                                    <td className="small text-muted">{new Date(a.createdAt).toLocaleString('it-IT')}</td>
                                    {notifDetail.campaign.channelType === 'SEND' && (
                                      <>
                                        <td className="small fw-mono">{a.iun || '—'}</td>
                                        <td className="small">{a.protocolNumber ? `${a.protocolNumber}/${a.protocolYear}` : '—'}</td>
                                        <td className="small"><SendStatusBadge status={a.sendStatus} /></td>
                                        <td className="small text-muted">{a.sendStatusUpdatedAt ? new Date(a.sendStatusUpdatedAt).toLocaleString('it-IT') : '—'}</td>
                                      </>
                                    )}
                                    <td className="small text-danger text-break" style={{ maxWidth: '350px' }}>{a.errorMessage || '—'}</td>
                                  </tr>
                                  {/* Co-consegna App IO come tentativo a parte: non ha senso quando
                                      App IO è già il canale primario della campagna. */}
                                  {notifDetail.campaign.channelType !== 'APP_IO' && a.appIo.attempted && (
                                    <tr>
                                      <td>{a.attemptNumber}</td>
                                      <td><StatusBadge status={a.appIo.success ? 'success' : 'failed'} /></td>
                                      <td className="small"><ChannelBadge channel="APP_IO" /></td>
                                      <td className="small text-muted">{new Date(a.createdAt).toLocaleString('it-IT')}</td>
                                      {notifDetail.campaign.channelType === 'SEND' && (
                                        <>
                                          <td>—</td>
                                          <td>—</td>
                                          <td>—</td>
                                          <td>—</td>
                                        </>
                                      )}
                                      <td className="small text-danger text-break" style={{ maxWidth: '350px' }}>{a.appIo.success ? '—' : (a.appIo.error || 'Non consegnato')}</td>
                                    </tr>
                                  )}
                                </React.Fragment>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {notifDetail.campaign.channelType === 'SEND' && (
                          <>
                            <h6 className="fw-bold small d-flex align-items-center justify-content-between">
                              Documenti disponibili (SEND)
                              <button
                                type="button"
                                className="btn btn-sm btn-outline-primary"
                                onClick={loadSendLegalFacts}
                                disabled={sendLegalFactsLoading}
                              >
                                {sendLegalFactsLoading ? (
                                  <><i className="fas fa-spinner fa-spin me-1"></i>Caricamento...</>
                                ) : (
                                  <><i className="fas fa-rotate me-1"></i>Carica documenti</>
                                )}
                              </button>
                            </h6>
                            {sendLegalFacts !== null && (
                              sendLegalFacts.length === 0 ? (
                                <div className="text-muted small mb-4">Nessun documento disponibile al momento.</div>
                              ) : (
                                <div className="table-responsive">
                                  <table className="table table-sm mb-4">
                                    <thead><tr><th>Documento</th><th></th></tr></thead>
                                    <tbody>
                                      {sendLegalFacts.map((item) => (
                                        <tr key={item.legalFactId}>
                                          <td className="small">{SEND_LEGAL_FACT_CATEGORY_LABELS[item.category] ?? item.category}</td>
                                          <td className="small text-end">
                                            {sendLegalFactRetry[item.legalFactId] ? (
                                              <span className="text-muted">
                                                {sendLegalFactRetry[item.legalFactId].error
                                                  ? sendLegalFactRetry[item.legalFactId].error
                                                  : `Non ancora disponibile, riprova tra ${sendLegalFactRetry[item.legalFactId].retryAfterSeconds ?? '?'}s`}
                                              </span>
                                            ) : (
                                              <button
                                                type="button"
                                                className="btn btn-sm btn-outline-secondary"
                                                onClick={() => downloadSendLegalFact(item.legalFactId)}
                                              >
                                                <i className="fas fa-download me-1"></i>Scarica
                                              </button>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )
                            )}
                          </>
                        )}

                        {notifDetail.downloads.length > 0 && (
                          <>
                            <h6 className="fw-bold small">Download</h6>
                            <div className="table-responsive">
                              <table className="table table-sm mb-4">
                                <thead><tr><th>Canale</th><th>Allegato</th><th>Data</th></tr></thead>
                                <tbody>
                                  {notifDetail.downloads.map((d, idx) => (
                                    <tr key={idx}>
                                      <td className="small"><ChannelBadge channel={d.channel} /></td>
                                      <td className="small">#{d.attachmentIndex + 1}</td>
                                      <td className="small text-muted">{new Date(d.downloadedAt).toLocaleString('it-IT')}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </>
                        )}

                        <h6 className="fw-bold small">{notifDetail.campaign.channelType === 'SEND' ? 'Oggetto Inviato' : 'Anteprima Messaggio Inviato'}</h6>
                        <div className="mb-2 small text-muted"><strong>Oggetto:</strong> {notifDetail.preview.subject}</div>
                        {notifDetail.campaign.channelType !== 'SEND' && (
                          notifDetail.preview.bodyHtml ? (
                            <div className="bg-white border rounded overflow-hidden" style={{ padding: '4px' }} dangerouslySetInnerHTML={{ __html: notifDetail.preview.bodyHtml }} />
                          ) : notifDetail.preview.bodyMarkdown ? (
                            <div className="bg-white border rounded p-3" data-color-mode="light">
                              <MDEditor.Markdown source={notifDetail.preview.bodyMarkdown} />
                            </div>
                          ) : (
                            <div className="text-muted small">Nessuna anteprima disponibile.</div>
                          )
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {view === 'verifica-appio' && (
            <div style={{ maxWidth: '600px', margin: '0 auto' }}>
              <h3 className="h5 fw-bold text-dark mb-3">
                <i className="fas fa-user-check me-2"></i>Verifica Stato App IO
              </h3>
              <p className="small text-muted mb-4">
                Inserisci il codice fiscale di un cittadino per verificare in tempo reale se ha installato App IO, se è attivo sul canale ed eventualmente se ha abilitato i messaggi inviati dall'Ente. Utile ad esempio per la ricerca degli irreperibili.
              </p>

              <div className="card shadow-sm p-4 mb-4">
                <div className="mb-3">
                  <label className="form-label small fw-bold">Codice Fiscale</label>
                  <div className="input-group input-group-sm">
                    <span className="input-group-text"><i className="fas fa-id-card"></i></span>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="Inserisci il codice fiscale (16 caratteri)"
                      maxLength={16}
                      value={verificaCf}
                      onChange={e => setVerificaCf(e.target.value.toUpperCase().trim())}
                      onKeyDown={e => { if (e.key === 'Enter') runVerificaAppIo(); }}
                    />
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={runVerificaAppIo}
                      disabled={verificaLoading || !verificaCf.trim()}
                    >
                      {verificaLoading ? (
                        <>
                          <i className="fas fa-spinner fa-spin me-1"></i>Verifica...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-search me-1"></i>Verifica
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {verificaResult && (
                  <div className={`mt-3 p-3 border rounded ${
                    !verificaResult.success ? 'border-danger bg-light' : 
                    !verificaResult.active ? 'border-secondary bg-light' : 
                    verificaResult.message.includes('disabilitati') ? 'border-warning bg-light' : 
                    'border-success bg-light'
                  }`}>
                    <div className="d-flex align-items-start gap-3">
                      <div style={{ fontSize: '1.8rem' }}>
                        {!verificaResult.success ? (
                          <i className="fas fa-circle-exclamation text-danger"></i>
                        ) : !verificaResult.active ? (
                          <i className="fas fa-circle-xmark text-secondary"></i>
                        ) : verificaResult.message.includes('disabilitati') ? (
                          <i className="fas fa-circle-exclamation text-warning"></i>
                        ) : (
                          <i className="fas fa-circle-check text-success"></i>
                        )}
                      </div>
                      <div>
                        <h6 className="fw-bold mb-1">
                          {!verificaResult.success ? 'Errore di sistema' : 
                           !verificaResult.active ? 'Cittadino non attivo' : 
                           verificaResult.message.includes('disabilitati') ? 'Attivo con restrizioni' : 
                           'Cittadino attivo su App IO'}
                        </h6>
                        <p className="small text-muted mb-0">{verificaResult.message}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {view === 'template-dashboard' && (
            <div>
              <div className="d-flex justify-content-between align-items-center mb-3">
                <h3 className="h5 fw-bold text-dark"><i className="fas fa-file-lines me-2"></i>Template</h3>
                {!editingTemplate && (
                  <div className="btn-group">
                    <button className="btn btn-sm btn-primary" onClick={() => setEditingTemplate({ type: 'MAIL', name: '', subject: '', bodyHtml: '', bodyMarkdown: '', pairedTemplateId: null })}>
                      <i className="fas fa-plus me-1"></i>Nuovo Template Mail/PEC
                    </button>
                    <button className="btn btn-sm btn-outline-primary" onClick={() => setEditingTemplate({ type: 'APP_IO', name: '', subject: '', bodyHtml: '', bodyMarkdown: '', pairedTemplateId: null })}>
                      <i className="fas fa-plus me-1"></i>Nuovo Template App IO
                    </button>
                  </div>
                )}
              </div>

              {!editingTemplate ? (
                <div className="card shadow-sm">
                  <table className="table table-sm mb-0">
                    <thead><tr><th>Nome</th><th>Tipo</th><th>Oggetto</th><th>Gemello</th><th className="text-end">Azioni</th></tr></thead>
                    <tbody>
                      {templates.map(t => (
                        <tr key={t.id}>
                          <td>{t.name}</td>
                          <td><ChannelBadge channel={t.type} /></td>
                          <td className="small text-muted">{t.subject}</td>
                          <td className="small">{t.pairedTemplateId ? templates.find(x => x.id === t.pairedTemplateId)?.name || '—' : '—'}</td>
                          <td className="text-end">
                            <button className="btn btn-sm btn-outline-primary me-1" onClick={() => setEditingTemplate(t)}><i className="fas fa-edit"></i></button>
                            <button className="btn btn-sm btn-outline-danger" onClick={() => handleDeleteTemplate(t.id)}><i className="fas fa-trash"></i></button>
                          </td>
                        </tr>
                      ))}
                      {templates.length === 0 && <tr><td colSpan={5} className="text-center text-muted py-3">Nessun template creato</td></tr>}
                    </tbody>
                  </table>
                </div>
              ) : (
                <form onSubmit={handleSaveTemplate} className="card shadow-sm p-4">
                  <h5 className="fw-bold mb-3">{editingTemplate.id ? 'Modifica' : 'Nuovo'} Template ({editingTemplate.type === 'MAIL' ? 'Mail/PEC' : 'App IO'})</h5>
                  <div className="mb-3">
                    <label className="form-label small fw-bold">Nome</label>
                    <input className="form-control form-control-sm" required value={editingTemplate.name || ''} onChange={e => setEditingTemplate({ ...editingTemplate, name: e.target.value })} />
                  </div>
                  <div className="mb-3">
                    <label className="form-label small fw-bold">Oggetto</label>
                    <input className="form-control form-control-sm" required value={editingTemplate.subject || ''} onChange={e => setEditingTemplate({ ...editingTemplate, subject: e.target.value })} />
                  </div>
                  {editingTemplate.type === 'MAIL' ? (
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Corpo (HTML)</label>
                      <TemplateEditor
                        value={editingTemplate.bodyHtml || ''}
                        onChange={(v) => setEditingTemplate({ ...editingTemplate, bodyHtml: v })}
                        systemPlaceholders={[
                          { label: 'Nominativo', token: '%%nominativo%%' },
                          { label: 'Codice Fiscale', token: '%%codice_fiscale%%' },
                        ]}
                        csvPlaceholders={[]}
                      />
                    </div>
                  ) : (
                    <div className="mb-3" data-color-mode="light">
                      <label className="form-label small fw-bold">Corpo (Markdown App IO)</label>
                      <MDEditor
                        value={editingTemplate.bodyMarkdown || ''}
                        onChange={(v) => setEditingTemplate({ ...editingTemplate, bodyMarkdown: v || '' })}
                        height={300}
                      />
                      <div className="form-text small text-muted">
                        Sintassi supportata: grassetto, corsivo, elenchi, link. Vedi la guida ufficiale App IO al markdown.
                      </div>
                    </div>
                  )}
                  <div className="mb-3">
                    <label className="form-label small fw-bold">Template gemello (invio combinato)</label>
                    <select className="form-select form-select-sm" value={editingTemplate.pairedTemplateId || ''} onChange={e => setEditingTemplate({ ...editingTemplate, pairedTemplateId: e.target.value || null })}>
                      <option value="">Nessuno</option>
                      {templates.filter(t => t.type !== editingTemplate.type).map(t => (
                        <option key={t.id} value={t.id}>{t.name} ({t.type})</option>
                      ))}
                    </select>
                  </div>
                  <div className="d-flex justify-content-end gap-2">
                    <button type="button" className="btn btn-outline-secondary" onClick={() => setEditingTemplate(null)}>Annulla</button>
                    <button type="submit" className="btn btn-primary">Salva Template</button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* VIEW: IMPOSTAZIONI */}
          {view === 'impostazioni' && (
            <div>
              {settingsSavedMessage && (
                <div className={`alert ${settingsSavedMessage.error ? 'alert-danger' : 'alert-success'} d-flex align-items-center gap-2 mb-3`} style={{ position: 'fixed', top: '70px', right: '20px', zIndex: 2000, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                  <i className={`fas ${settingsSavedMessage.error ? 'fa-triangle-exclamation' : 'fa-check-circle'}`}></i>
                  <strong>{settingsSavedMessage.text}</strong>
                </div>
              )}

              <div className="row g-3">
                <div className="col-lg-3">
                  <nav className="nav imp-nav flex-column border rounded bg-white" aria-label="Sezioni impostazioni">
                    <span className="imp-section-title">Generale</span>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'personalizzazione' ? 'active' : ''}`}
                      onClick={() => setActiveSettingsTab('personalizzazione')}
                    >
                      <i className="fas fa-building me-2"></i>Personalizzazione
                    </button>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'smtp' ? 'active' : ''}`}
                      onClick={() => { setEditingMailConfig(null); setActiveSettingsTab('smtp'); }}
                    >
                      <i className="fas fa-envelope me-2"></i>Mail Server (SMTP)
                    </button>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'pec' ? 'active' : ''}`}
                      onClick={() => { setEditingMailConfig(null); setActiveSettingsTab('pec'); }}
                    >
                      <i className="fas fa-envelope-open-text me-2"></i>PEC Server
                    </button>

                    <span className="imp-section-title">Integrazioni API</span>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'app-io' ? 'active' : ''}`}
                      onClick={() => setActiveSettingsTab('app-io')}
                    >
                      <i className="fas fa-mobile-alt me-2"></i>App IO (Servizi)
                    </button>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'pdnd' ? 'active' : ''}`}
                      onClick={() => setActiveSettingsTab('pdnd')}
                    >
                      <i className="fas fa-key me-2"></i>Client PDND
                    </button>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'send' ? 'active' : ''}`}
                      onClick={() => setActiveSettingsTab('send')}
                    >
                      <i className="fas fa-paper-plane me-2"></i>SEND (Digitale)
                    </button>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'inad' ? 'active' : ''}`}
                      onClick={() => setActiveSettingsTab('inad')}
                    >
                      <i className="fas fa-address-book me-2"></i>INAD
                    </button>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'inipec' ? 'active' : ''}`}
                      onClick={() => setActiveSettingsTab('inipec')}
                    >
                      <i className="fas fa-address-card me-2"></i>INIPEC
                    </button>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'protocollo' ? 'active' : ''}`}
                      onClick={() => setActiveSettingsTab('protocollo')}
                    >
                      <i className="fas fa-folder-open me-2"></i>Protocollo
                    </button>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'postalizzazione' ? 'active' : ''}`}
                      onClick={() => setActiveSettingsTab('postalizzazione')}
                    >
                      <i className="fas fa-mail-bulk me-2"></i>Postalizzazione
                    </button>

                    <span className="imp-section-title">Sicurezza</span>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'oidc' ? 'active' : ''}`}
                      onClick={() => setActiveSettingsTab('oidc')}
                    >
                      <i className="fas fa-id-badge me-2"></i>SPID / CIE (OIDC)
                    </button>

                    <span className="imp-section-title">Sistema</span>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'motori' ? 'active' : ''}`}
                      onClick={() => {
                        setActiveSettingsTab('motori');
                        fetchEngines();
                      }}
                    >
                      <i className="fas fa-cogs me-2"></i>Motori di Invio
                    </button>
                  </nav>
                </div>

                <div className="col-lg-9">
                  <div className="card shadow-sm bg-white">
                    <div className="card-header bg-white py-3 border-bottom">
                      <h3 className="h6 mb-0 fw-bold text-dark">
                        {activeSettingsTab === 'personalizzazione' && 'Personalizzazione dell\'Ente'}
                        {activeSettingsTab === 'smtp' && 'Mail Server (SMTP) - Configurazione'}
                        {activeSettingsTab === 'pec' && 'PEC Server - Configurazione'}
                        {activeSettingsTab === 'app-io' && 'Configurazione Servizi App IO'}
                        {activeSettingsTab === 'pdnd' && 'Client PDND (Piattaforma Digitale Nazionale Dati)'}
                        {activeSettingsTab === 'send' && 'Integrazione SEND (Digital Delivery)'}
                        {activeSettingsTab === 'inad' && 'Integrazione INAD (Indice Nazionale Domicili Digitali)'}
                        {activeSettingsTab === 'inipec' && 'Integrazione INIPEC'}
                        {activeSettingsTab === 'protocollo' && 'Connettore Protocollo Informatico'}
                        {activeSettingsTab === 'postalizzazione' && 'Postalizzazione Cartacea Istituzionale'}
                        {activeSettingsTab === 'oidc' && 'SPID / CIE (OIDC) - Autenticazione Cittadini'}
                        {activeSettingsTab === 'motori' && 'Motori di Invio — Stato Code BullMQ'}
                      </h3>
                    </div>
                    <div className="card-body p-4">
                      <form onSubmit={handleSaveSettings}>
                        
                        {/* TAB: PERSONALIZZAZIONE */}
                        {activeSettingsTab === 'personalizzazione' && (
                          <div>
                            <div className="mb-3">
                              <label className="form-label small fw-bold text-dark" htmlFor="entity_name">Nome dell'Amministrazione Pubblica</label>
                              <input
                                type="text"
                                id="entity_name"
                                className="form-control form-control-sm"
                                value={settEntityName}
                                onChange={(e) => setSettEntityName(e.target.value)}
                                required
                              />
                              <div className="form-text small text-muted">Verrà mostrato nell'intestazione visiva dei portali e nei PDF generati.</div>
                            </div>
                            <div className="mb-3">
                              <label className="form-label small fw-semibold text-muted" htmlFor="sett_sub">Sottotitolo Hub</label>
                              <input
                                type="text"
                                id="sett_sub"
                                className="form-control form-control-sm"
                                value={settSubtitle}
                                onChange={(e) => setSettSubtitle(e.target.value)}
                              />
                            </div>
                            <div className="mb-3">
                              <label className="form-label">Logo ente (PNG/JPG/SVG, max 2 MB)</label>
                              <input type="file" className="form-control" accept="image/png,image/jpeg,image/svg+xml"
                                onChange={(e) => e.target.files?.[0] && handleUploadBranding('logo', e.target.files[0])} />
                              <input
                                type="text"
                                className="form-control form-control-sm mt-2"
                                placeholder="…oppure URL esterno, es. https://cdn.ente.it/logo.png"
                                value={settLogoValue}
                                onChange={(e) => setSettLogoValue(e.target.value)}
                              />
                              <div className="form-text small text-muted">In alternativa all'upload puoi indicare un URL https:// (salva con "Salva impostazioni").</div>
                            </div>
                            <div className="mb-3">
                              <label className="form-label">Favicon (ICO/PNG/SVG, max 2 MB)</label>
                              <input type="file" className="form-control" accept="image/x-icon,image/png,image/svg+xml"
                                onChange={(e) => e.target.files?.[0] && handleUploadBranding('favicon', e.target.files[0])} />
                              <input
                                type="text"
                                className="form-control form-control-sm mt-2"
                                placeholder="…oppure URL esterno, es. https://cdn.ente.it/favicon.ico"
                                value={settFaviconValue}
                                onChange={(e) => setSettFaviconValue(e.target.value)}
                              />
                              <div className="form-text small text-muted">In alternativa all'upload puoi indicare un URL https:// (salva con "Salva impostazioni").</div>
                            </div>
                            <div className="mb-3">
                              <label className="form-label">Conservazione allegati (giorni)</label>
                              <input type="number" min={1} className="form-control" value={settRetentionDays}
                                onChange={(e) => setSettRetentionDays(e.target.value)} />
                            </div>
                          </div>
                        )}

                        {/* TAB: SMTP — rendered outside the form (see below) */}

                        {/* TAB: PEC — rendered outside the form (see below) */}

                        {/* TAB: APP IO — rendered outside the form (see below) */}

                        {/* TAB: SEND */}
                        {activeSettingsTab === 'pdnd' && (
                          <div>
                            <div className="alert alert-info small mb-3">
                              Client PDND condiviso: le credenziali qui sotto vengono usate da tutte le
                              integrazioni PDND (SEND, e in futuro INAD/INIPEC). Ogni integrazione ha
                              il proprio Purpose ID configurato nella sua scheda dedicata.
                            </div>
                            {([
                              { label: 'Collaudo (UAT)', prefix: 'test' as const,
                                tokenUrl: settPdndTestTokenUrl, setTokenUrl: setSettPdndTestTokenUrl,
                                audience: settPdndTestAudience, setAudience: setSettPdndTestAudience,
                                clientId: settPdndTestClientId, setClientId: setSettPdndTestClientId,
                                kid: settPdndTestKid, setKid: setSettPdndTestKid,
                                privateKey: settPdndTestPrivateKey, setPrivateKey: setSettPdndTestPrivateKey },
                              { label: 'Produzione', prefix: 'prod' as const,
                                tokenUrl: settPdndProdTokenUrl, setTokenUrl: setSettPdndProdTokenUrl,
                                audience: settPdndProdAudience, setAudience: setSettPdndProdAudience,
                                clientId: settPdndProdClientId, setClientId: setSettPdndProdClientId,
                                kid: settPdndProdKid, setKid: setSettPdndProdKid,
                                privateKey: settPdndProdPrivateKey, setPrivateKey: setSettPdndProdPrivateKey },
                            ]).map((e) => (
                              <fieldset key={e.prefix} className="border rounded p-3 mb-3">
                                <legend className="float-none w-auto px-2 small fw-bold text-dark">{e.label}</legend>
                                <div className="mb-3">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`pdnd_${e.prefix}_tokenurl`}>Token endpoint PDND</label>
                                  <input
                                    type="text"
                                    id={`pdnd_${e.prefix}_tokenurl`}
                                    className="form-control form-control-sm"
                                    value={e.tokenUrl}
                                    onChange={(ev) => e.setTokenUrl(ev.target.value)}
                                  />
                                </div>
                                <div className="mb-3">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`pdnd_${e.prefix}_audience`}>Audience client_assertion</label>
                                  <input
                                    type="text"
                                    id={`pdnd_${e.prefix}_audience`}
                                    className="form-control form-control-sm"
                                    value={e.audience}
                                    onChange={(ev) => e.setAudience(ev.target.value)}
                                  />
                                </div>
                                <div className="mb-3">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`pdnd_${e.prefix}_clientid`}>Client ID PDND</label>
                                  <input
                                    type="text"
                                    id={`pdnd_${e.prefix}_clientid`}
                                    className="form-control form-control-sm"
                                    value={e.clientId}
                                    onChange={(ev) => e.setClientId(ev.target.value)}
                                  />
                                </div>
                                <div className="mb-3">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`pdnd_${e.prefix}_kid`}>Key ID (kid)</label>
                                  <input
                                    type="text"
                                    id={`pdnd_${e.prefix}_kid`}
                                    className="form-control form-control-sm"
                                    value={e.kid}
                                    onChange={(ev) => e.setKid(ev.target.value)}
                                  />
                                </div>
                                <div className="mb-1">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`pdnd_${e.prefix}_privatekey`}>Chiave privata (PEM)</label>
                                  <textarea
                                    id={`pdnd_${e.prefix}_privatekey`}
                                    className="form-control form-control-sm font-monospace"
                                    rows={4}
                                    placeholder="-----BEGIN PRIVATE KEY-----"
                                    value={e.privateKey}
                                    onChange={(ev) => e.setPrivateKey(ev.target.value)}
                                  />
                                  <div className="form-text small text-muted">Cifrata a riposo. Lasciare il valore mascherato per non sovrascriverla, oppure incollarne una tua.</div>
                                  <label className="btn btn-outline-secondary btn-sm mt-2 mb-0">
                                    Importa da file (.pem/.priv)
                                    <input
                                      type="file"
                                      accept=".pem,.priv,.key,text/plain"
                                      hidden
                                      onChange={(ev) => {
                                        const f = ev.target.files?.[0];
                                        if (f) handleImportPdndPrivateKeyFile(e.prefix, f);
                                        ev.target.value = '';
                                      }}
                                    />
                                  </label>
                                  <div className="form-text small text-muted">Carica una chiave generata altrove (es. via openssl): sostituisce il campo sopra, poi va salvata con "Salva impostazioni".</div>
                                </div>
                                <div className="mt-2 d-flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    className="btn btn-outline-secondary btn-sm"
                                    disabled={settPdndGeneratingKey === e.prefix}
                                    onClick={() => handleGeneratePdndKeypair(e.prefix)}
                                  >
                                    {settPdndGeneratingKey === e.prefix ? 'Generazione…' : 'Genera nuova coppia di chiavi RSA'}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-outline-secondary btn-sm"
                                    onClick={() => handleExportPdndPublicKey(e.prefix)}
                                  >
                                    Esporta chiave pubblica
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-outline-secondary btn-sm"
                                    onClick={() => handleExportPdndPrivateKey(e.prefix)}
                                  >
                                    Esporta chiave privata
                                  </button>
                                  <div className="form-text small text-muted w-100">"Genera" crea una nuova coppia e salva subito la privata. "Esporta pubblica" ricava la pubblica da quella già salvata sul server (funziona in ogni momento, non solo dopo "Genera"). "Esporta privata" scarica in chiaro quella salvata: usala solo per backup.</div>
                                </div>
                                {settPdndGeneratedPubKey?.env === e.prefix && (
                                  <div className="alert alert-success mt-3 mb-0">
                                    <div className="fw-bold small mb-1">Chiave pubblica generata — caricala ora su PDND, non verrà mostrata di nuovo:</div>
                                    <textarea
                                      readOnly
                                      className="form-control form-control-sm font-monospace"
                                      rows={6}
                                      value={settPdndGeneratedPubKey.pem}
                                      onFocus={(ev) => ev.target.select()}
                                    />
                                  </div>
                                )}

                                <hr className="my-3" />
                                <button
                                  type="button"
                                  className="btn btn-outline-primary btn-sm"
                                  disabled={settPdndTesting === e.prefix}
                                  onClick={() => handleValidatePdndClient(e.prefix)}
                                >
                                  {settPdndTesting === e.prefix ? 'Verifica in corso…' : 'Verifica configurazione (locale)'}
                                </button>
                                <div className="form-text small text-muted">Salva le impostazioni e verifica in locale che i campi siano compilati e la chiave privata sia valida. PDND rilascia voucher solo per client+finalità insieme: il test reale va fatto dal tab del servizio (SEND/INAD/INIPEC).</div>
                                {settPdndTestResult?.env === e.prefix && (
                                  <div className={`alert ${settPdndTestResult.ok ? 'alert-success' : 'alert-danger'} mt-2 mb-0 small`} style={{ wordBreak: 'break-word' }}>
                                    {settPdndTestResult.message}
                                  </div>
                                )}
                              </fieldset>
                            ))}
                          </div>
                        )}

                        {activeSettingsTab === 'send' && (
                          <div>
                            <div className="mb-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="send_env">Ambiente attivo</label>
                              <select
                                id="send_env"
                                className="form-select form-select-sm"
                                style={{ maxWidth: 260 }}
                                value={settSendEnvironment}
                                onChange={(e) => setSettSendEnvironment(e.target.value as 'collaudo' | 'produzione')}
                              >
                                <option value="collaudo">Collaudo (UAT)</option>
                                <option value="produzione">Produzione</option>
                              </select>
                              <div className="form-text small text-muted">Determina quale set di credenziali sotto viene usato per l'invio reale.</div>
                            </div>

                            <div className="mb-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="send_sender_taxid">Codice Fiscale / P.IVA Ente (senderTaxId)</label>
                              <input
                                type="text"
                                id="send_sender_taxid"
                                className="form-control form-control-sm"
                                style={{ maxWidth: 260 }}
                                value={settSendSenderTaxId}
                                onChange={(e) => setSettSendSenderTaxId(e.target.value)}
                                maxLength={11}
                              />
                              <div className="form-text small text-muted">11 cifre, obbligatorio nel payload SEND come mittente.</div>
                            </div>

                            <div className="mb-3">
                              <label className="form-label small fw-bold text-dark" htmlFor="send_entity_type">Tipologia Ente</label>
                              <select
                                id="send_entity_type"
                                className="form-select form-select-sm"
                                style={{ maxWidth: 340 }}
                                value={settSendEntityType}
                                onChange={(e) => { setSettSendEntityType(e.target.value); setWizAddTaxonomyCode(''); }}
                              >
                                <option value="">-- Seleziona tipologia ente --</option>
                                {SEND_ENTITY_TYPES.map(et => (
                                  <option key={et.code} value={et.code}>{et.code} - {et.label}</option>
                                ))}
                              </select>
                              <div className="form-text small text-muted">Filtra le tassonomie ufficiali selezionabili qui sotto. Un ente ha di norma una sola tipologia.</div>
                            </div>

                            <div className="mb-4">
                              <label className="form-label small fw-bold text-dark">Tassonomie SEND abilitate</label>
                              <div className="form-text small text-muted mb-2">
                                Codici a 7 caratteri dalla <a href="https://developer.pagopa.it/it/send/guides/knowledge-base/v2.5/tassonomia-send" target="_blank" rel="noreferrer">tabella ufficiale SEND</a>.
                                Termina per "P" se prevede pagamento, "N" se no.
                              </div>
                              <div className="d-flex gap-2 mb-3">
                                <select
                                  className="form-select form-select-sm"
                                  value={wizAddTaxonomyCode}
                                  onChange={(e) => setWizAddTaxonomyCode(e.target.value)}
                                >
                                  <option value="">-- Scegli tassonomia da elenco ufficiale --</option>
                                  {SEND_TAXONOMY_CATALOG
                                    .filter(t => !settSendEntityType || t.entityType === settSendEntityType)
                                    .map(t => (
                                      <option key={t.code} value={t.code}>{t.code} — {t.title}</option>
                                    ))}
                                </select>
                                <button
                                  type="button"
                                  className="btn btn-outline-primary btn-sm text-nowrap"
                                  disabled={!wizAddTaxonomyCode}
                                  onClick={() => {
                                    const entry = SEND_TAXONOMY_CATALOG.find(t => t.code === wizAddTaxonomyCode);
                                    if (!entry) return;
                                    setSettSendTaxonomies(prev => [...prev, { code: entry.code, label: entry.title }]);
                                    setWizAddTaxonomyCode('');
                                  }}
                                >
                                  + Aggiungi da elenco
                                </button>
                              </div>
                              {wizAddTaxonomyCode && (
                                <div className="form-text small text-muted mb-2">
                                  {SEND_TAXONOMY_CATALOG.find(t => t.code === wizAddTaxonomyCode)?.description}
                                </div>
                              )}
                              <div className="form-text small text-muted mb-2">
                                Codice non in elenco? Compila il <a href="https://tassonomia-send.limesurvey.net/638616?newtest=Y&lang=it" target="_blank" rel="noreferrer">questionario ufficiale</a> e inseriscilo qui sotto a mano.
                              </div>
                              {settSendTaxonomies.map((t, idx) => (
                                <div key={idx} className="d-flex gap-2 mb-2">
                                  <input
                                    type="text"
                                    className="form-control form-control-sm"
                                    style={{ maxWidth: 120 }}
                                    placeholder="Codice"
                                    value={t.code}
                                    maxLength={7}
                                    onChange={(e) => setSettSendTaxonomies(prev => prev.map((row, i) => i === idx ? { ...row, code: e.target.value.toUpperCase() } : row))}
                                  />
                                  <input
                                    type="text"
                                    className="form-control form-control-sm"
                                    placeholder="Etichetta descrittiva"
                                    value={t.label}
                                    onChange={(e) => setSettSendTaxonomies(prev => prev.map((row, i) => i === idx ? { ...row, label: e.target.value } : row))}
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-outline-danger btn-sm"
                                    onClick={() => setSettSendTaxonomies(prev => prev.filter((_, i) => i !== idx))}
                                  >
                                    Rimuovi
                                  </button>
                                </div>
                              ))}
                              <button
                                type="button"
                                className="btn btn-outline-secondary btn-sm"
                                onClick={() => setSettSendTaxonomies(prev => [...prev, { code: '', label: '' }])}
                              >
                                + Aggiungi tassonomia
                              </button>
                            </div>

                            {([
                              { label: 'Collaudo (UAT)', prefix: 'test' as const,
                                baseUrl: settSendTestBaseUrl, setBaseUrl: setSettSendTestBaseUrl,
                                apiKey: settSendTestApiKey, setApiKey: setSettSendTestApiKey,
                                purposeId: settSendTestPurposeId, setPurposeId: setSettSendTestPurposeId,
                                group: settSendTestGroup, setGroup: setSettSendTestGroup },
                              { label: 'Produzione', prefix: 'prod' as const,
                                baseUrl: settSendProdBaseUrl, setBaseUrl: setSettSendProdBaseUrl,
                                apiKey: settSendProdApiKey, setApiKey: setSettSendProdApiKey,
                                purposeId: settSendProdPurposeId, setPurposeId: setSettSendProdPurposeId,
                                group: settSendProdGroup, setGroup: setSettSendProdGroup },
                            ]).map((e) => (
                              <fieldset key={e.prefix} className="border rounded p-3 mb-3">
                                <legend className="float-none w-auto px-2 small fw-bold text-dark">{e.label}</legend>
                                <div className="mb-3">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`send_${e.prefix}_baseurl`}>Base URL API SEND</label>
                                  <input
                                    type="text"
                                    id={`send_${e.prefix}_baseurl`}
                                    className="form-control form-control-sm"
                                    value={e.baseUrl}
                                    onChange={(ev) => e.setBaseUrl(ev.target.value)}
                                  />
                                </div>
                                <div className="mb-3">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`send_${e.prefix}_apikey`}>API Key</label>
                                  <input
                                    type="password"
                                    id={`send_${e.prefix}_apikey`}
                                    className="form-control form-control-sm"
                                    value={e.apiKey}
                                    onChange={(ev) => e.setApiKey(ev.target.value)}
                                  />
                                  <div className="form-text small text-muted">Emessa dal portale self-care di PN (Piattaforma Notifiche) — header x-api-key, richiesta insieme al voucher PDND su ogni chiamata.</div>
                                </div>
                                <div className="mb-1">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`send_${e.prefix}_purposeid`}>Purpose ID</label>
                                  <input
                                    type="text"
                                    id={`send_${e.prefix}_purposeid`}
                                    className="form-control form-control-sm"
                                    value={e.purposeId}
                                    onChange={(ev) => e.setPurposeId(ev.target.value)}
                                  />
                                  <div className="form-text small text-muted">Usato per ottenere il voucher PDND (header Authorization), richiesto insieme alla API Key sopra. Le credenziali del client PDND (client ID, kid, chiave privata) si configurano nella scheda "Client PDND".</div>
                                </div>
                                <div className="mb-1">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`send_${e.prefix}_group`}>Gruppo PN (opzionale)</label>
                                  <div className="d-flex gap-2 mb-2">
                                    <button
                                      type="button"
                                      className="btn btn-outline-secondary btn-sm text-nowrap"
                                      disabled={settSendGroupsLoading === e.prefix}
                                      onClick={() => handleLoadSendGroups(e.prefix)}
                                    >
                                      {settSendGroupsLoading === e.prefix ? 'Carico…' : 'Carica gruppi'}
                                    </button>
                                    {settSendGroups[e.prefix].length > 0 && (
                                      <select
                                        className="form-select form-select-sm"
                                        value={e.group}
                                        onChange={(ev) => e.setGroup(ev.target.value)}
                                      >
                                        <option value="">-- Nessun gruppo --</option>
                                        {settSendGroups[e.prefix].map(g => (
                                          <option key={g.id} value={g.id}>{g.name} — {g.description}</option>
                                        ))}
                                      </select>
                                    )}
                                  </div>
                                  {settSendGroupsError[e.prefix] && (
                                    <div className="alert alert-danger mt-0 mb-2 small" style={{ wordBreak: 'break-word' }}>
                                      {settSendGroupsError[e.prefix]}
                                    </div>
                                  )}
                                  <input
                                    type="text"
                                    id={`send_${e.prefix}_group`}
                                    className="form-control form-control-sm"
                                    value={e.group}
                                    onChange={(ev) => e.setGroup(ev.target.value)}
                                  />
                                  <div className="form-text small text-muted">Necessario solo se l'account PN è associato a più gruppi utenti (portale self-care PN) — PN rifiuta l'invio senza specificarlo in quel caso ("Specify a group in cx_groups=..."). Usa "Carica gruppi" per scegliere da elenco, oppure inserisci l'id a mano. Lascia vuoto se l'account ha un solo gruppo.</div>
                                </div>
                                <hr className="my-3" />
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  disabled={settSendTesting === e.prefix}
                                  onClick={() => handleTestSendConnection(e.prefix)}
                                >
                                  {settSendTesting === e.prefix ? 'Test in corso…' : 'Test connessione (API Key + voucher PDND)'}
                                </button>
                                <div className="form-text small text-muted">Salva le impostazioni e prova una chiamata reale a PN con API Key + voucher PDND (client PDND + Purpose ID SEND).</div>
                                {settSendTestResult?.env === e.prefix && (
                                  <div className={`alert ${settSendTestResult.ok ? 'alert-success' : 'alert-danger'} mt-2 mb-0 small`} style={{ wordBreak: 'break-word' }}>
                                    {settSendTestResult.message}
                                  </div>
                                )}
                              </fieldset>
                            ))}
                          </div>
                        )}

                        {activeSettingsTab === 'inad' && (
                          <div>
                            <div className="alert alert-warning small mb-3">
                              Integrazione INAD in attesa di approvazione PDND: le specifiche non sono
                              ancora definite. Solo il Purpose ID è configurabile per ora.
                            </div>
                            {([
                              { label: 'Collaudo (UAT)', prefix: 'test' as const,
                                purposeId: settInadTestPurposeId, setPurposeId: setSettInadTestPurposeId },
                              { label: 'Produzione', prefix: 'prod' as const,
                                purposeId: settInadProdPurposeId, setPurposeId: setSettInadProdPurposeId },
                            ]).map((e) => (
                              <fieldset key={e.prefix} className="border rounded p-3 mb-3">
                                <legend className="float-none w-auto px-2 small fw-bold text-dark">{e.label}</legend>
                                <div className="mb-1">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`inad_${e.prefix}_purposeid`}>Purpose ID</label>
                                  <input
                                    type="text"
                                    id={`inad_${e.prefix}_purposeid`}
                                    className="form-control form-control-sm"
                                    value={e.purposeId}
                                    onChange={(ev) => e.setPurposeId(ev.target.value)}
                                  />
                                </div>
                                <hr className="my-3" />
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  disabled={settInadTesting === e.prefix}
                                  onClick={() => handleTestInadConnection(e.prefix)}
                                >
                                  {settInadTesting === e.prefix ? 'Test in corso…' : 'Test connessione (voucher PDND)'}
                                </button>
                                <div className="form-text small text-muted">Salva le impostazioni e prova a ottenere un voucher PDND reale con client PDND + Purpose ID INAD.</div>
                                {settInadTestResult?.env === e.prefix && (
                                  <div className={`alert ${settInadTestResult.ok ? 'alert-success' : 'alert-danger'} mt-2 mb-0 small`} style={{ wordBreak: 'break-word' }}>
                                    {settInadTestResult.message}
                                  </div>
                                )}
                              </fieldset>
                            ))}
                          </div>
                        )}

                        {activeSettingsTab === 'inipec' && (
                          <div>
                            <div className="alert alert-warning small mb-3">
                              Integrazione INIPEC in attesa di approvazione PDND: le specifiche non sono
                              ancora definite. Solo il Purpose ID è configurabile per ora.
                            </div>
                            {([
                              { label: 'Collaudo (UAT)', prefix: 'test' as const,
                                purposeId: settInipecTestPurposeId, setPurposeId: setSettInipecTestPurposeId },
                              { label: 'Produzione', prefix: 'prod' as const,
                                purposeId: settInipecProdPurposeId, setPurposeId: setSettInipecProdPurposeId },
                            ]).map((e) => (
                              <fieldset key={e.prefix} className="border rounded p-3 mb-3">
                                <legend className="float-none w-auto px-2 small fw-bold text-dark">{e.label}</legend>
                                <div className="mb-1">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`inipec_${e.prefix}_purposeid`}>Purpose ID</label>
                                  <input
                                    type="text"
                                    id={`inipec_${e.prefix}_purposeid`}
                                    className="form-control form-control-sm"
                                    value={e.purposeId}
                                    onChange={(ev) => e.setPurposeId(ev.target.value)}
                                  />
                                </div>
                                <hr className="my-3" />
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  disabled={settInipecTesting === e.prefix}
                                  onClick={() => handleTestInipecConnection(e.prefix)}
                                >
                                  {settInipecTesting === e.prefix ? 'Test in corso…' : 'Test connessione (voucher PDND)'}
                                </button>
                                <div className="form-text small text-muted">Salva le impostazioni e prova a ottenere un voucher PDND reale con client PDND + Purpose ID INIPEC.</div>
                                {settInipecTestResult?.env === e.prefix && (
                                  <div className={`alert ${settInipecTestResult.ok ? 'alert-success' : 'alert-danger'} mt-2 mb-0 small`} style={{ wordBreak: 'break-word' }}>
                                    {settInipecTestResult.message}
                                  </div>
                                )}
                              </fieldset>
                            ))}
                          </div>
                        )}

                        {/* TAB: PROTOCOLLO */}
                        {activeSettingsTab === 'protocollo' && (
                          <div className="row g-3">
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="proto_provider">Provider Protocollo</label>
                              <select
                                id="proto_provider"
                                className="form-select form-select-sm"
                                value={settProtoProvider}
                                onChange={(e) => setSettProtoProvider(e.target.value)}
                              >
                                <option value="tinn">TINN (Affari Generali)</option>
                              </select>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="proto_url">URL Protocollazione</label>
                              <input
                                type="text"
                                id="proto_url"
                                className="form-control form-control-sm"
                                value={settProtoUrl}
                                onChange={(e) => setSettProtoUrl(e.target.value)}
                                placeholder="https://protows01.esempio.it/"
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_codice_ente">Codice Ente</label>
                              <input
                                type="text"
                                id="proto_codice_ente"
                                className="form-control form-control-sm"
                                value={settProtoCodiceEnte}
                                onChange={(e) => setSettProtoCodiceEnte(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_user">Username</label>
                              <input
                                type="text"
                                id="proto_user"
                                className="form-control form-control-sm"
                                value={settProtoUser}
                                onChange={(e) => setSettProtoUser(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_pass">Password</label>
                              <input
                                type="password"
                                id="proto_pass"
                                className="form-control form-control-sm"
                                value={settProtoPass}
                                onChange={(e) => setSettProtoPass(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_gerarchia">Gerarchia di Classificazione (Codice Titolario)</label>
                              <input
                                type="text"
                                id="proto_gerarchia"
                                className="form-control form-control-sm"
                                value={settProtoCodiceTitolario}
                                onChange={(e) => setSettProtoCodiceTitolario(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_codice_amm">Codice Amministrazione (Classifica)</label>
                              <input
                                type="text"
                                id="proto_codice_amm"
                                className="form-control form-control-sm"
                                value={settProtoCodiceAmministrazione}
                                onChange={(e) => setSettProtoCodiceAmministrazione(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_unita_org">Unità Organizzativa</label>
                              <input
                                type="text"
                                id="proto_unita_org"
                                className="form-control form-control-sm"
                                value={settProtoUnitaOrganizzativa}
                                onChange={(e) => setSettProtoUnitaOrganizzativa(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_mittente">Denominazione Mittente (Ente)</label>
                              <input
                                type="text"
                                id="proto_mittente"
                                className="form-control form-control-sm"
                                value={settProtoMittenteDenominazione}
                                onChange={(e) => setSettProtoMittenteDenominazione(e.target.value)}
                                placeholder="Es: Comune di Montesilvano"
                              />
                            </div>
                          </div>
                        )}

                        {/* TAB: POSTALIZZAZIONE */}
                        {activeSettingsTab === 'postalizzazione' && (
                          <div className="row g-3">
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="postal_provider">Gestore Postalizzazione</label>
                              <select
                                id="postal_provider"
                                className="form-select form-select-sm"
                                value={settPostalProvider}
                                onChange={(e) => setSettPostalProvider(e.target.value)}
                              >
                                <option value="Postel">Postel (Gruppo Poste Italiane)</option>
                                <option value="HCS">HCS Civico</option>
                                <option value="Simulazione">Strategia Stateless Interna</option>
                              </select>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="postal_url">Endpoint Gateway</label>
                              <input
                                type="text"
                                id="postal_url"
                                className="form-control form-control-sm"
                                value={settPostalUrl}
                                onChange={(e) => setSettPostalUrl(e.target.value)}
                              />
                            </div>
                            <div className="col-12">
                              <label className="form-label small fw-bold text-dark" htmlFor="postal_key">Token di Autorizzazione API</label>
                              <input
                                type="text"
                                id="postal_key"
                                className="form-control form-control-sm"
                                value={settPostalKey}
                                onChange={(e) => setSettPostalKey(e.target.value)}
                              />
                            </div>

                            <div className="col-12"><hr /><span className="small text-muted fw-bold">Postalizzazione (GlobalCom)</span></div>
                            <div className="col-md-8">
                              <label className="form-label small fw-bold text-dark" htmlFor="postal_globalcom_baseurl">URL Web Service (WSDL)</label>
                              <input
                                type="text"
                                id="postal_globalcom_baseurl"
                                className="form-control form-control-sm"
                                placeholder="https://<comune>.corrispondenzadigitale.it/gbcweb/GBCWebservice.asmx"
                                value={settPostalBaseUrl}
                                onChange={(e) => setSettPostalBaseUrl(e.target.value)}
                              />
                            </div>
                            <div className="col-md-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="postal_globalcom_centrocosto">Centro di Costo</label>
                              <input
                                type="text"
                                id="postal_globalcom_centrocosto"
                                className="form-control form-control-sm"
                                value={settPostalCentroDiCosto}
                                onChange={(e) => setSettPostalCentroDiCosto(e.target.value)}
                              />
                            </div>
                            <div className="col-md-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="postal_globalcom_user">Utente</label>
                              <input
                                type="text"
                                id="postal_globalcom_user"
                                className="form-control form-control-sm"
                                value={settPostalUser}
                                onChange={(e) => setSettPostalUser(e.target.value)}
                              />
                            </div>
                            <div className="col-md-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="postal_globalcom_password">Password</label>
                              <input
                                type="password"
                                id="postal_globalcom_password"
                                className="form-control form-control-sm"
                                value={settPostalPassword}
                                onChange={(e) => setSettPostalPassword(e.target.value)}
                              />
                            </div>
                            <div className="col-md-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="postal_globalcom_group">Gruppo</label>
                              <input
                                type="text"
                                id="postal_globalcom_group"
                                className="form-control form-control-sm"
                                placeholder="<DEFAULT> se utenza spare"
                                value={settPostalGroup}
                                onChange={(e) => setSettPostalGroup(e.target.value)}
                              />
                            </div>
                            <div className="col-12"><span className="small text-muted fw-bold">Mittente (opzionale — vuoto = mittente predefinito utenza GlobalCom)</span></div>
                            <div className="col-md-6">
                              <label className="form-label small text-dark" htmlFor="postal_globalcom_mitt_denom">Denominazione</label>
                              <input
                                type="text"
                                id="postal_globalcom_mitt_denom"
                                className="form-control form-control-sm"
                                value={settPostalMittenteDenominazione1}
                                onChange={(e) => setSettPostalMittenteDenominazione1(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small text-dark" htmlFor="postal_globalcom_mitt_indirizzo">Indirizzo</label>
                              <input
                                type="text"
                                id="postal_globalcom_mitt_indirizzo"
                                className="form-control form-control-sm"
                                value={settPostalMittenteIndirizzo1}
                                onChange={(e) => setSettPostalMittenteIndirizzo1(e.target.value)}
                              />
                            </div>
                            <div className="col-md-4">
                              <label className="form-label small text-dark" htmlFor="postal_globalcom_mitt_cap">CAP</label>
                              <input
                                type="text"
                                id="postal_globalcom_mitt_cap"
                                className="form-control form-control-sm"
                                value={settPostalMittenteCap}
                                onChange={(e) => setSettPostalMittenteCap(e.target.value)}
                              />
                            </div>
                            <div className="col-md-4">
                              <label className="form-label small text-dark" htmlFor="postal_globalcom_mitt_citta">Città</label>
                              <input
                                type="text"
                                id="postal_globalcom_mitt_citta"
                                className="form-control form-control-sm"
                                value={settPostalMittenteCitta}
                                onChange={(e) => setSettPostalMittenteCitta(e.target.value)}
                              />
                            </div>
                            <div className="col-md-4">
                              <label className="form-label small text-dark" htmlFor="postal_globalcom_mitt_provincia">Provincia</label>
                              <input
                                type="text"
                                id="postal_globalcom_mitt_provincia"
                                className="form-control form-control-sm"
                                maxLength={2}
                                value={settPostalMittenteProvincia}
                                onChange={(e) => setSettPostalMittenteProvincia(e.target.value.toUpperCase())}
                              />
                            </div>
                          </div>
                        )}

                        {/* TAB: OIDC (SPID/CIE) */}
                        {activeSettingsTab === 'oidc' && (
                          <div className="row g-3">
                            <div className="col-12">
                              <div className="form-text small text-muted mb-2">Autenticazione cittadini sul portale pubblico. Lasciare vuoto per disabilitare la verifica issuer/audience.</div>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="oidc_issuer">OIDC Issuer (Base URL)</label>
                              <input
                                type="text"
                                id="oidc_issuer"
                                className="form-control form-control-sm"
                                placeholder="https://id.provider.it"
                                value={settOidcIssuer}
                                onChange={(e) => setSettOidcIssuer(e.target.value)}
                              />
                              <div className="form-text small text-muted">URL base del provider OIDC: deve coincidere con il claim <code>iss</code> dei token rilasciati.</div>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="oidc_audience">Audience</label>
                              <input
                                type="text"
                                id="oidc_audience"
                                className="form-control form-control-sm"
                                placeholder="es. lo stesso Client ID"
                                value={settOidcAudience}
                                onChange={(e) => setSettOidcAudience(e.target.value)}
                              />
                              <div className="form-text small text-muted">Valore atteso nel claim <code>aud</code> del token (di norma il Client ID assegnato dal provider).</div>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="oidc_client_id">Client ID</label>
                              <input
                                type="text"
                                id="oidc_client_id"
                                className="form-control form-control-sm"
                                value={settOidcClientId}
                                onChange={(e) => setSettOidcClientId(e.target.value)}
                              />
                              <div className="form-text small text-muted">Identificativo del client registrato presso il provider SPID/CIE.</div>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="oidc_client_secret">Client Secret</label>
                              <input
                                type="password"
                                id="oidc_client_secret"
                                className="form-control form-control-sm"
                                value={settOidcClientSecret}
                                onChange={(e) => setSettOidcClientSecret(e.target.value)}
                              />
                              <div className="form-text small text-muted">Cifrato nel database; il valore salvato viene mostrato mascherato.</div>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="oidc_jwks_uri">JWKS URI</label>
                              <input
                                type="text"
                                id="oidc_jwks_uri"
                                className="form-control form-control-sm"
                                placeholder="https://id.provider.it/.well-known/jwks.json"
                                value={settOidcJwksUri}
                                onChange={(e) => setSettOidcJwksUri(e.target.value)}
                              />
                              <div className="form-text small text-muted">Endpoint delle chiavi pubbliche per la verifica delle firme dei token.</div>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="oidc_logout_url">OIDC Logout URL</label>
                              <input
                                type="text"
                                id="oidc_logout_url"
                                className="form-control form-control-sm"
                                placeholder="https://id.provider.it/logout"
                                value={settOidcLogoutUrl}
                                onChange={(e) => setSettOidcLogoutUrl(e.target.value)}
                              />
                              <div className="form-text small text-muted">End session endpoint del provider, usato per terminare la sessione SPID/CIE al logout.</div>
                            </div>
                            <div className="col-12">
                              <div className="border border-primary rounded p-3 mt-2" style={{background:'#f4f8fd'}}>
                                <h6 className="small fw-bold text-dark mb-2"><i className="fas fa-info-circle me-1 text-primary"></i>Parametri da configurare nel proxy OIDC</h6>
                                <p className="small text-muted mb-2">Usa questi dati per registrare il client nella WebUI del proxy (es. pa-sso-proxy):</p>
                                <label className="form-label small fw-semibold text-muted mb-1">Redirect URI</label>
                                <div className="input-group input-group-sm mb-2">
                                  <input
                                    type="text"
                                    className="form-control font-monospace"
                                    readOnly
                                    value={settCitizenPublicUrl
                                      ? `${settCitizenPublicUrl.replace(/\/+$/, '')}/oidc/callback`
                                      : ''}
                                    placeholder="Imposta CITIZEN_ORIGIN nel .env del server e riavvia il backend"
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-outline-primary"
                                    title="Copia negli appunti"
                                    disabled={!settCitizenPublicUrl}
                                    onClick={() => {
                                      navigator.clipboard.writeText(`${settCitizenPublicUrl.replace(/\/+$/, '')}/oidc/callback`);
                                      setSettingsSavedMessage({ text: 'Redirect URI copiata negli appunti.', error: false });
                                      setTimeout(() => setSettingsSavedMessage(null), 3000);
                                    }}
                                  >
                                    <i className="fas fa-copy"></i>
                                  </button>
                                </div>
                                <div className="small">
                                  <span className="me-4"><strong>Allowed Scopes:</strong> <code>openid profile email</code></span>
                                  <span><strong>Response Type:</strong> <code>code</code> (Auth Code Flow + PKCE)</span>
                                </div>
                                <div className="form-text small text-muted mt-2">La Redirect URI deriva da <code>CITIZEN_ORIGIN</code> nel <code>.env</code> del server (bootstrap, non modificabile da qui).</div>
                              </div>
                            </div>
                          </div>
                        )}

                        <div className="mt-4 border-top pt-3 text-end">
                          <button
                            type="submit"
                            className="btn btn-primary px-4 py-2"
                            style={{ backgroundColor: 'var(--bi-primary)', border: 'none' }}
                          >
                            <i className="fas fa-save me-2"></i>Salva Impostazioni
                          </button>
                        </div>

                      </form>

                      {/* TAB: SMTP — outside form to avoid nested form conflicts */}
                      {activeSettingsTab === 'smtp' && renderMailConfigTab('EMAIL')}

                      {/* TAB: PEC — outside form to avoid nested form conflicts */}
                      {activeSettingsTab === 'pec' && renderMailConfigTab('PEC')}

                      {/* TAB: APP IO (Multiple services creation & management) — outside form to avoid nested form conflicts */}
                      {activeSettingsTab === 'app-io' && (
                        <div>
                          <div className="border rounded bg-light p-3 mb-4">
                            <div className="d-flex justify-content-between align-items-center mb-3">
                              <h4 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-list me-1 text-primary"></i>Servizi App IO Configurati</h4>
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                onClick={() => setShowNewSvcForm(!showNewSvcForm)}
                              >
                                <i className={`fas ${showNewSvcForm ? 'fa-minus' : 'fa-plus'} me-1`}></i> Nuovo Servizio
                              </button>
                            </div>

                            {showNewSvcForm && (
                              <div className="card card-body border-0 shadow-sm p-3 mb-4 bg-white">
                                <h5 className="small fw-bold text-dark border-bottom pb-2 mb-3">Crea Nuovo Servizio App IO</h5>
                                <div className="row g-3">
                                  <div className="col-md-6">
                                    <label className="form-label small fw-bold text-dark">Nome Servizio *</label>
                                    <input
                                      type="text"
                                      className="form-control form-control-sm"
                                      placeholder="Es. Servizio TARI"
                                      value={newSvcNome}
                                      onChange={(e) => setNewSvcNome(e.target.value)}
                                      required
                                    />
                                  </div>
                                  <div className="col-md-6">
                                    <label className="form-label small fw-bold text-dark">ID Servizio App IO (IO) *</label>
                                    <input
                                      type="text"
                                      className="form-control form-control-sm"
                                      placeholder="Es. 01ARZ3NDEKTSN4FFFSUQFW0C5"
                                      value={newSvcIdService}
                                      onChange={(e) => setNewSvcIdService(e.target.value)}
                                      required
                                    />
                                  </div>
                                  <div className="col-12">
                                    <label className="form-label small text-muted">Descrizione Servizio</label>
                                    <textarea
                                      className="form-control form-control-sm"
                                      rows={2}
                                      placeholder="Descrizione del servizio visualizzata nell'App IO..."
                                      value={newSvcDesc}
                                      onChange={(e) => setNewSvcDesc(e.target.value)}
                                    ></textarea>
                                  </div>
                                  <div className="col-md-6">
                                    <label className="form-label small fw-bold text-dark">API Key Primaria *</label>
                                    <input
                                      type="password"
                                      className="form-control form-control-sm"
                                      placeholder="API Key principale"
                                      value={newSvcApiKeyPrimaria}
                                      onChange={(e) => setNewSvcApiKeyPrimaria(e.target.value)}
                                      required
                                    />
                                  </div>
                                  <div className="col-md-6">
                                    <label className="form-label small text-muted">API Key Secondaria</label>
                                    <input
                                      type="password"
                                      className="form-control form-control-sm"
                                      placeholder="API Key backup"
                                      value={newSvcApiKeySecondaria}
                                      onChange={(e) => setNewSvcApiKeySecondaria(e.target.value)}
                                    />
                                  </div>
                                  <div className="col-md-6">
                                    <label className="form-label small text-muted">Codice Catalogo</label>
                                    <input
                                      type="text"
                                      className="form-control form-control-sm"
                                      placeholder="Es. 000000000000000"
                                      value={newSvcCodiceCatalogo}
                                      onChange={(e) => setNewSvcCodiceCatalogo(e.target.value)}
                                    />
                                  </div>
                                  <div className="col-md-6 d-flex align-items-center">
                                    <div className="form-check mt-3">
                                      <input
                                        type="checkbox"
                                        id="svc_default"
                                        className="form-check-input"
                                        checked={newSvcIsDefault}
                                        onChange={(e) => setNewSvcIsDefault(e.target.checked)}
                                      />
                                      <label htmlFor="svc_default" className="form-check-label small" style={{ cursor: 'pointer' }}>Imposta come servizio predefinito</label>
                                    </div>
                                  </div>
                                  <div className="col-12 text-end border-top pt-2">
                                    <button type="button" className="btn btn-sm btn-success px-3" onClick={handleAddIoService}>Crea Servizio</button>
                                  </div>
                                </div>
                              </div>
                            )}

                            {editingIoService && (
                              <div className="card card-body border-0 shadow-sm p-3 mb-4 bg-white">
                                <h5 className="small fw-bold text-dark border-bottom pb-2 mb-3">Modifica Servizio App IO: {editingIoService.nome}</h5>
                                <form onSubmit={handleUpdateIoService}>
                                  <div className="row g-3">
                                    <div className="col-md-6">
                                      <label className="form-label small fw-bold text-dark">Nome Servizio *</label>
                                      <input
                                        type="text"
                                        className="form-control form-control-sm"
                                        placeholder="Es. Servizio TARI"
                                        value={editingIoService.nome}
                                        onChange={(e) => setEditingIoService({ ...editingIoService, nome: e.target.value })}
                                        required
                                      />
                                    </div>
                                    <div className="col-md-6">
                                      <label className="form-label small fw-bold text-dark">ID Servizio App IO (IO) *</label>
                                      <input
                                        type="text"
                                        className="form-control form-control-sm"
                                        placeholder="Es. 01ARZ3NDEKTSN4FFFSUQFW0C5"
                                        value={editingIoService.idService}
                                        onChange={(e) => setEditingIoService({ ...editingIoService, idService: e.target.value })}
                                        required
                                      />
                                    </div>
                                    <div className="col-12">
                                      <label className="form-label small text-muted">Descrizione Servizio</label>
                                      <textarea
                                        className="form-control form-control-sm"
                                        rows={2}
                                        placeholder="Descrizione del servizio visualizzata nell'App IO..."
                                        value={editingIoService.descrizione || ''}
                                        onChange={(e) => setEditingIoService({ ...editingIoService, descrizione: e.target.value })}
                                      ></textarea>
                                    </div>
                                    <div className="col-md-6">
                                      <label className="form-label small fw-bold text-dark">API Key Primaria *</label>
                                      <input
                                        type="password"
                                        className="form-control form-control-sm"
                                        placeholder="API Key principale (lascia mascherata per non modificarla)"
                                        value={editingIoService.apiKeyPrimaria}
                                        onChange={(e) => setEditingIoService({ ...editingIoService, apiKeyPrimaria: e.target.value })}
                                        required
                                      />
                                    </div>
                                    <div className="col-md-6">
                                      <label className="form-label small text-muted">API Key Secondaria</label>
                                      <input
                                        type="password"
                                        className="form-control form-control-sm"
                                        placeholder="API Key backup"
                                        value={editingIoService.apiKeySecondaria || ''}
                                        onChange={(e) => setEditingIoService({ ...editingIoService, apiKeySecondaria: e.target.value })}
                                      />
                                    </div>
                                    <div className="col-md-6">
                                      <label className="form-label small text-muted">Codice Catalogo</label>
                                      <input
                                        type="text"
                                        className="form-control form-control-sm"
                                        placeholder="Es. 000000000000000"
                                        value={editingIoService.codiceCatalogo || ''}
                                        onChange={(e) => setEditingIoService({ ...editingIoService, codiceCatalogo: e.target.value })}
                                      />
                                    </div>
                                    <div className="col-12 text-end border-top pt-2 d-flex justify-content-end gap-2">
                                      <button type="button" className="btn btn-sm btn-outline-secondary px-3" onClick={() => setEditingIoService(null)}>Annulla</button>
                                      <button type="submit" className="btn btn-sm btn-success px-3">Salva Modifiche</button>
                                    </div>
                                  </div>
                                </form>
                              </div>
                            )}

                            {ioServices.length === 0 ? (
                              <div className="text-center py-4 text-muted bg-white border rounded">Nessun servizio App IO configurato.</div>
                            ) : (
                              <div className="table-responsive bg-white border rounded">
                                <table className="table table-striped table-sm align-middle mb-0" style={{ fontSize: '0.8rem' }}>
                                  <thead>
                                    <tr>
                                      <th>Nome</th>
                                      <th>ID Servizio (IO)</th>
                                      <th>Catalogo</th>
                                      <th className="text-end">Azioni</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {ioServices.map(s => (
                                      <React.Fragment key={s.id}>
                                        <tr>
                                          <td>
                                            <strong>{s.nome}</strong>
                                            {s.isDefault && <span className="badge bg-success ms-2">Predefinito</span>}
                                          </td>
                                          <td className="font-monospace small">{s.idService}</td>
                                          <td>{s.codiceCatalogo || <span className="text-muted">—</span>}</td>
                                          <td className="text-end">
                                            <div className="btn-group">
                                              {!s.isDefault && (
                                                <button
                                                  type="button"
                                                  className="btn btn-sm btn-outline-info border-0"
                                                  onClick={() => handleSetDefaultIoService(s.id)}
                                                  title="Imposta come predefinito"
                                                >
                                                  <i className="fas fa-star"></i>
                                                </button>
                                              )}
                                              <button
                                                type="button"
                                                className="btn btn-sm btn-outline-secondary border-0"
                                                onClick={() => { setEditingIoService(s); setShowNewSvcForm(false); }}
                                                title="Modifica"
                                              >
                                                <i className="fas fa-edit"></i>
                                              </button>
                                              <button
                                                type="button"
                                                className="btn btn-sm btn-outline-danger border-0"
                                                onClick={() => handleDeleteIoService(s.id)}
                                                title="Elimina"
                                              >
                                                <i className="fas fa-trash"></i>
                                              </button>
                                            </div>
                                          </td>
                                        </tr>
                                        <tr>
                                          <td colSpan={4} className="pt-0">
                                            <form onSubmit={(e) => { e.preventDefault(); handleTestIoService(s.id); }} className="d-flex align-items-center gap-2 pb-2">
                                              <span className="text-muted small fw-semibold">Test invio:</span>
                                              <input
                                                type="text"
                                                className="form-control form-control-sm"
                                                placeholder="RSSMRA80A01H501X"
                                                required
                                                value={ioTestCf}
                                                onChange={(e) => setIoTestCf(e.target.value)}
                                                style={{ maxWidth: 200 }}
                                              />
                                              <button type="submit" className="btn btn-sm btn-outline-secondary" disabled={ioTestBusyId === s.id}>
                                                <i className="fas fa-paper-plane"></i> Invia Test
                                              </button>
                                              {ioTestMsg?.id === s.id && (
                                                <span className={`small ${ioTestMsg.error ? 'text-danger' : 'text-success'}`}>{ioTestMsg.text}</span>
                                              )}
                                            </form>
                                          </td>
                                        </tr>
                                      </React.Fragment>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* TAB: MOTORI — outside form to avoid submit conflicts */}
                      {activeSettingsTab === 'motori' && (
                        <div>
                          <div className="d-flex justify-content-between align-items-center mb-4">
                            <p className="text-muted small mb-0">Stato in tempo reale delle code BullMQ. Puoi mettere in pausa o riprendere ogni motore individualmente.</p>
                            <button
                              type="button"
                              className="btn btn-sm btn-outline-secondary d-flex align-items-center gap-2"
                              onClick={fetchEngines}
                              disabled={loadingEngines}
                            >
                              <i className={`fas fa-sync-alt ${loadingEngines ? 'fa-spin' : ''}`}></i>
                              Aggiorna
                            </button>
                          </div>

                          {enginesError && (
                            <div className="alert alert-danger d-flex align-items-center gap-2">
                              <i className="fas fa-triangle-exclamation"></i>
                              {enginesError}
                            </div>
                          )}

                          {loadingEngines && engines.length === 0 ? (
                            <div className="text-center py-5 text-muted">
                              <i className="fas fa-spinner fa-spin fa-2x mb-3"></i>
                              <div>Caricamento stato motori...</div>
                            </div>
                          ) : (
                            <div className="d-flex flex-column gap-3">
                              {engines.map((eng) => {
                                const channelLabel: Record<string, string> = {
                                  EMAIL: 'Mail (SMTP)',
                                  PEC: 'PEC',
                                  APP_IO: 'App IO',
                                  SEND: 'SEND',
                                  POSTAL: 'Postale',
                                  PROTOCOLLAZIONE: 'Protocollazione',
                                };
                                const channelIcon: Record<string, string> = {
                                  EMAIL: 'fa-envelope',
                                  PEC: 'fa-envelope-open-text',
                                  APP_IO: 'fa-mobile-alt',
                                  SEND: 'fa-paper-plane',
                                  POSTAL: 'fa-mail-bulk',
                                  PROTOCOLLAZIONE: 'fa-stamp',
                                };
                                const total = (eng.counts?.waiting ?? 0) + (eng.counts?.active ?? 0) + (eng.counts?.delayed ?? 0);
                                const failed = eng.counts?.failed ?? 0;
                                const completed = eng.counts?.completed ?? 0;

                                return (
                                  <div key={eng.channel} className={`card border shadow-sm ${eng.paused ? 'border-warning' : failed > 0 ? 'border-danger' : 'border-light'}`}>
                                    <div className="card-body p-3">
                                      <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
                                        <div className="d-flex align-items-center gap-3">
                                          <div className={`rounded-circle d-flex align-items-center justify-content-center text-white ${eng.paused ? 'bg-warning' : 'bg-primary'}`} style={{ width: 40, height: 40 }}>
                                            <i className={`fas ${channelIcon[eng.channel] ?? 'fa-cog'}`}></i>
                                          </div>
                                          <div>
                                            <div className="fw-bold text-dark">{channelLabel[eng.channel] ?? eng.channel}</div>
                                            <div className="text-muted small">{eng.queueName}</div>
                                          </div>
                                        </div>

                                        <div className="d-flex align-items-center gap-3">
                                          <div className="d-flex gap-3 text-center">
                                            <div>
                                              <div className="fw-bold text-primary">{eng.counts?.waiting ?? 0}</div>
                                              <div className="text-muted" style={{ fontSize: '0.7rem' }}>In Attesa</div>
                                            </div>
                                            <div>
                                              <div className="fw-bold text-info">{eng.counts?.active ?? 0}</div>
                                              <div className="text-muted" style={{ fontSize: '0.7rem' }}>Attivi</div>
                                            </div>
                                            <div>
                                              <div className="fw-bold text-secondary">{eng.counts?.delayed ?? 0}</div>
                                              <div className="text-muted" style={{ fontSize: '0.7rem' }}>In Ritardo</div>
                                            </div>
                                            <div>
                                              <div className="fw-bold text-success">{completed}</div>
                                              <div className="text-muted" style={{ fontSize: '0.7rem' }}>Completati</div>
                                            </div>
                                            <div>
                                              <div className={`fw-bold ${failed > 0 ? 'text-danger' : 'text-muted'}`}>{failed}</div>
                                              <div className="text-muted" style={{ fontSize: '0.7rem' }}>Falliti</div>
                                            </div>
                                          </div>

                                          <div>
                                            {eng.paused ? (
                                              <div className="d-flex flex-column align-items-center gap-1">
                                                <span className="badge bg-warning text-dark mb-1"><i className="fas fa-pause me-1"></i>In Pausa</span>
                                                <button
                                                  type="button"
                                                  className="btn btn-sm btn-success d-flex align-items-center gap-1"
                                                  onClick={() => handleEngineAction(eng.channel, 'resume')}
                                                  disabled={loadingEngines}
                                                >
                                                  <i className="fas fa-play"></i> Riprendi
                                                </button>
                                              </div>
                                            ) : (
                                              <div className="d-flex flex-column align-items-center gap-1">
                                                <span className={`badge ${total > 0 ? 'bg-primary' : 'bg-secondary'} mb-1`}>
                                                  {total > 0 ? <><i className="fas fa-circle-notch fa-spin me-1"></i>Attivo ({total})</> : <><i className="fas fa-check me-1"></i>Idle</>}
                                                </span>
                                                <button
                                                  type="button"
                                                  className="btn btn-sm btn-outline-warning d-flex align-items-center gap-1"
                                                  onClick={() => handleEngineAction(eng.channel, 'pause')}
                                                  disabled={loadingEngines}
                                                >
                                                  <i className="fas fa-pause"></i> Pausa
                                                </button>
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      </div>

                                      <div className="mt-2">
                                        <button
                                          type="button"
                                          className="btn btn-sm btn-outline-secondary"
                                          onClick={() => handleViewEngineJobs(eng.channel)}
                                        >
                                          <i className="fas fa-list me-1"></i>Vedi job falliti
                                        </button>
                                        {engineJobsChannel === eng.channel && (
                                          <div className="table-responsive">
                                            <table className="table table-sm mt-2">
                                              <thead><tr><th>Job</th><th>Campagna</th><th>Destinatario</th><th>Tentativi</th><th>Motivo</th><th>Log</th></tr></thead>
                                              <tbody>
                                                {engineJobs.map(j => (
                                                  <React.Fragment key={j.jobId}>
                                                    <tr>
                                                      <td className="font-monospace small">{j.jobId}</td>
                                                      <td className="font-monospace small">{j.campaignId}</td>
                                                      <td className="font-monospace small">{j.recipientId}</td>
                                                      <td>{j.attemptsMade}</td>
                                                      <td className="small text-danger">{j.failedReason || '—'}</td>
                                                      <td>
                                                        <button
                                                          type="button"
                                                          className="btn btn-sm btn-outline-secondary"
                                                          onClick={() => handleViewJobLogs(eng.channel, j.jobId)}
                                                          disabled={loadingJobLogs}
                                                        >
                                                          {expandedJobLogs?.jobId === j.jobId ? 'Nascondi' : 'Vedi log'}
                                                        </button>
                                                      </td>
                                                    </tr>
                                                    {expandedJobLogs?.jobId === j.jobId && (
                                                      <tr>
                                                        <td colSpan={6}>
                                                          {expandedJobLogs.logs.length === 0 ? (
                                                            <div className="text-muted small">Nessun log registrato per questo job.</div>
                                                          ) : (
                                                            <pre className="small bg-light border rounded p-2 mb-0" style={{ whiteSpace: 'pre-wrap', maxHeight: '300px', overflowY: 'auto' }}>
                                                              {expandedJobLogs.logs.join('\n')}
                                                            </pre>
                                                          )}
                                                        </td>
                                                      </tr>
                                                    )}
                                                  </React.Fragment>
                                                ))}
                                                {engineJobs.length === 0 && <tr><td colSpan={6} className="text-center text-muted">Nessun job fallito</td></tr>}
                                              </tbody>
                                            </table>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}

                              {sendStageCounts && (
                                <div className="card border shadow-sm border-light">
                                  <div className="card-body p-3">
                                    <div className="d-flex align-items-center gap-3 mb-2">
                                      <div className="rounded-circle d-flex align-items-center justify-content-center text-white bg-primary" style={{ width: 40, height: 40 }}>
                                        <i className="fas fa-paper-plane"></i>
                                      </div>
                                      <div>
                                        <div className="fw-bold text-dark">SEND</div>
                                        <div className="text-muted small">Invio (nessuna coda BullMQ, demone schedulato) — la protocollazione ha il suo motore dedicato sopra.</div>
                                      </div>
                                    </div>
                                    <div className="d-flex gap-3 text-center">
                                      <div>
                                        <div className="fw-bold text-info">{sendStageCounts.protocollato}</div>
                                        <div className="text-muted" style={{ fontSize: '0.7rem' }}>Protocollato (da inviare)</div>
                                      </div>
                                      <div>
                                        <div className="fw-bold text-success">{sendStageCounts.inviato}</div>
                                        <div className="text-muted" style={{ fontSize: '0.7rem' }}>Inviato</div>
                                      </div>
                                      <div>
                                        <div className={`fw-bold ${sendStageCounts.fallito > 0 ? 'text-danger' : 'text-muted'}`}>{sendStageCounts.fallito}</div>
                                        <div className="text-muted" style={{ fontSize: '0.7rem' }}>Fallito</div>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* VIEW: AUDIT LOGS */}
          {view === 'audit-logs' && (
            <div className="card shadow-sm border-0 rounded-3">
              <div className="card-header bg-white border-0 pt-4 pb-3">
                <div className="d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
                  <div>
                    <h3 className="h5 mb-1 text-dark fw-bold">Registro Attività</h3>
                    <p className="text-muted small mb-0">Cronologia di tutte le operazioni effettuate sulle campagne di invio massivo</p>
                  </div>
                  <div style={{ maxWidth: '350px', width: '100%' }}>
                    <div className="input-group">
                      <span className="input-group-text bg-light border-end-0 text-muted">
                        <i className="fas fa-search"></i>
                      </span>
                      <input
                        type="text"
                        className="form-control bg-light border-start-0 ps-0 shadow-none"
                        placeholder="Cerca per operatore o campagna..."
                        value={auditSearch}
                        onChange={(e) => { setAuditSearch(e.target.value); setAuditPage(1); }}
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div className="card-body p-0">
                {auditLoading ? (
                  <div className="d-flex justify-content-center align-items-center py-5">
                    <div className="spinner-border text-primary" role="status">
                      <span className="visually-hidden">Caricamento in corso...</span>
                    </div>
                  </div>
                ) : auditLogs.length === 0 ? (
                  <div className="text-center py-5 text-muted">
                    <i className="fas fa-history fa-3x mb-3 text-light"></i>
                    <p className="mb-0">Nessuna attività registrata con i filtri correnti.</p>
                  </div>
                ) : (
                  <>
                    <div className="table-responsive">
                      <table className="table table-hover align-middle mb-0" style={{ borderCollapse: 'separate' }}>
                        <thead className="table-light text-muted small text-uppercase">
                          <tr>
                            <th className="px-4 py-3" style={{ width: '180px' }}>Data e Ora</th>
                            <th className="py-3" style={{ width: '180px' }}>Operatore</th>
                            <th className="py-3" style={{ width: '180px' }}>Operazione</th>
                            <th className="py-3">Campagna</th>
                            <th className="px-4 py-3">Dettagli</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditLogs.map((log) => {
                            let badgeClass = 'bg-secondary';
                            let actionText = log.action;
                            if (log.action === 'CREATE') {
                              badgeClass = 'bg-success-subtle text-success border border-success-subtle';
                              actionText = 'Creazione';
                            } else if (log.action === 'UPDATE_DRAFT') {
                              badgeClass = 'bg-info-subtle text-info border border-info-subtle';
                              actionText = 'Modifica';
                            } else if (log.action === 'UPLOAD_RECIPIENTS') {
                              badgeClass = 'bg-primary-subtle text-primary border border-primary-subtle';
                              actionText = 'Destinatari';
                            } else if (log.action === 'UPLOAD_ATTACHMENTS') {
                              badgeClass = 'bg-primary-subtle text-primary border border-primary-subtle';
                              actionText = 'Allegati';
                            } else if (log.action === 'LAUNCH') {
                              badgeClass = 'bg-success text-white border border-success';
                              actionText = 'Lancio';
                            } else if (log.action === 'CANCEL') {
                              badgeClass = 'bg-warning-subtle text-warning border border-warning-subtle';
                              actionText = 'Annullamento';
                            } else if (log.action === 'DELETE') {
                              badgeClass = 'bg-danger-subtle text-danger border border-danger-subtle';
                              actionText = 'Eliminazione';
                            } else if (log.action === 'RETRY') {
                              badgeClass = 'bg-warning-subtle text-warning border border-warning-subtle';
                              actionText = 'Rinvio';
                            }

                            // Dettagli dinamici descrittivi
                            let detailText = '';
                            if (log.action === 'CREATE') {
                              detailText = 'Creazione bozza campagna';
                            } else if (log.action === 'UPDATE_DRAFT') {
                              detailText = 'Modifica parametri/configurazione';
                            } else if (log.action === 'UPLOAD_RECIPIENTS') {
                              const fn = log.details?.filename || 'destinatari.csv';
                              const count = log.details?.imported || 0;
                              detailText = `Caricamento file CSV "${fn}" (${count} destinatari importati)`;
                            } else if (log.action === 'UPLOAD_ATTACHMENTS') {
                              const up = log.details?.uploaded || 0;
                              const disc = log.details?.discarded || 0;
                              const fn = log.details?.filename;
                              detailText = fn 
                                ? `Caricato pacchetto allegati "${fn}" (${up} caricati, ${disc} scartati)`
                                : `Caricamento allegati singoli (${up} caricati, ${disc} scartati)`;
                            } else if (log.action === 'LAUNCH') {
                              const l = log.details?.launched || 0;
                              detailText = `Lancio completato, ${l} notifiche messe in coda per l'invio`;
                            } else if (log.action === 'CANCEL') {
                              const c = log.details?.cancelled || 0;
                              detailText = `Invio annullato, ${c} tentativi non ancora inviati rimossi dalla coda`;
                            } else if (log.action === 'DELETE') {
                              detailText = 'Campagna eliminata definitivamente dal sistema';
                            } else if (log.action === 'RETRY') {
                              const count = log.details?.count;
                              detailText = count 
                                ? `Rinvio bulk avviato per ${count} notifiche fallite`
                                : `Rinvio avviato per notifica fallita`;
                            } else if (log.details) {
                              detailText = JSON.stringify(log.details);
                            }

                            return (
                              <tr key={log.id}>
                                <td className="px-4 text-muted small">
                                  {new Date(log.createdAt).toLocaleString('it-IT')}
                                </td>
                                <td className="fw-medium text-dark">
                                  <i className="fas fa-user-circle me-2 text-muted"></i>
                                  {log.operator}
                                </td>
                                <td>
                                  <span className={`badge ${badgeClass} px-2.5 py-1.5 rounded-pill font-monospace small`} style={{ fontSize: '0.75rem' }}>
                                    {actionText}
                                  </span>
                                </td>
                                <td>
                                  {log.campaignId && log.action !== 'DELETE' ? (
                                    <a
                                      href="#"
                                      className="text-decoration-none fw-semibold"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        setSelectedCampaignId(log.campaignId);
                                        setView('campaign-detail');
                                      }}
                                    >
                                      {log.campaignName || 'Visualizza Dettaglio'}
                                    </a>
                                  ) : (
                                    <span className="text-muted text-italic">
                                      {log.campaignName || 'Nessun riferimento'}
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 text-muted small">
                                  {detailText}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination */}
                    {auditTotal > auditPageSize && (
                      <div className="card-footer bg-white border-0 d-flex flex-column flex-md-row justify-content-between align-items-center gap-3 py-3 px-4">
                        <span className="small text-muted">
                          Mostrati <strong>{((auditPage - 1) * auditPageSize) + 1}</strong> - <strong>{Math.min(auditPage * auditPageSize, auditTotal)}</strong> di <strong>{auditTotal}</strong> risultati
                        </span>
                        <nav aria-label="Navigazione pagine audit logs">
                          <ul className="pagination pagination-sm mb-0">
                            <li className={`page-item ${auditPage === 1 ? 'disabled' : ''}`}>
                              <button
                                className="page-item page-link border-0 rounded-circle me-1"
                                onClick={() => setAuditPage((p) => Math.max(p - 1, 1))}
                                disabled={auditPage === 1}
                              >
                                <i className="fas fa-chevron-left"></i>
                              </button>
                            </li>
                            {Array.from({ length: Math.ceil(auditTotal / auditPageSize) }, (_, i) => i + 1).map((p) => {
                              const isNear = Math.abs(p - auditPage) <= 2;
                              const isEdge = p === 1 || p === Math.ceil(auditTotal / auditPageSize);
                              if (!isNear && !isEdge) return null;
                              
                              return (
                                <li key={p} className={`page-item ${auditPage === p ? 'active' : ''}`}>
                                  <button
                                    className={`page-link border-0 rounded-circle mx-1 ${auditPage === p ? 'bg-primary text-white' : 'text-dark bg-transparent'}`}
                                    onClick={() => setAuditPage(p)}
                                  >
                                    {p}
                                  </button>
                                </li>
                              );
                            })}
                            <li className={`page-item ${auditPage >= Math.ceil(auditTotal / auditPageSize) ? 'disabled' : ''}`}>
                              <button
                                className="page-item page-link border-0 rounded-circle ms-1"
                                onClick={() => setAuditPage((p) => Math.min(p + 1, Math.ceil(auditTotal / auditPageSize)))}
                                disabled={auditPage >= Math.ceil(auditTotal / auditPageSize)}
                              >
                                <i className="fas fa-chevron-right"></i>
                              </button>
                            </li>
                          </ul>
                        </nav>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* VIEW: CAMPAIGN DETAIL */}
          {view === 'campaign-detail' && (
            <div>
              <div className="mb-4">
                <button
                  className="btn btn-outline-secondary btn-sm px-3 mb-3 border"
                  onClick={() => setView('invio-massivo')}
                >
                  <i className="fas fa-arrow-left me-1"></i> Torna a Campagne
                </button>
              </div>

              {loadingCampaignDetail && !campaign ? (
                <div className="text-center py-5">
                  <i className="fas fa-spinner fa-spin fa-2x text-primary mb-2"></i>
                  <div>Caricamento dati campagna...</div>
                </div>
              ) : detailError ? (
                <div className="alert alert-danger"><i className="fas fa-exclamation-triangle"></i> {detailError}</div>
              ) : campaign ? (
                <div className="row g-4">
                  <div className="col-lg-4">
                    <div className="card shadow-sm mb-4">
                      <div className="card-header bg-white py-3 border-bottom">
                        <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-info-circle me-2"></i>Metadati Campagna</h3>
                      </div>
                      <div className="card-body">
                        <div className="mb-3">
                          <label className="text-muted small fw-semibold block">ID Campagna</label>
                          <div className="fw-mono" style={{ fontSize: '0.82rem' }}>{campaign.id}</div>
                        </div>
                        <div className="mb-3">
                          <label className="text-muted small fw-semibold block">Nome</label>
                          <div className="fw-bold">{campaign.name}</div>
                        </div>
                        <div className="mb-3">
                          <label className="text-muted small fw-semibold block">Canale</label>
                          <div>
                            <ChannelBadge channel={campaign.channelType} extra={campaign.channelConfig?.['serviceName'] as string | undefined} />
                          </div>
                        </div>
                        <div className="mb-3">
                          <label className="text-muted small fw-semibold block">Stato</label>
                          <div>
                            <StatusBadge status={campaign.status} />
                          </div>
                        </div>
                        {campaign.channelConfig?.['subject'] && (
                          <div className="mb-3">
                            <label className="text-muted small fw-semibold block">Oggetto</label>
                            <div className="p-2 bg-light border rounded small" style={{ wordBreak: 'break-all' }}>
                              {campaign.channelConfig['subject']}
                            </div>
                          </div>
                        )}
                        {campaign.channelConfig?.['body'] ? (
                          <div className="mb-3">
                            <label className="text-muted small fw-semibold block">Testo Messaggio</label>
                            <div
                              className="p-2 bg-light border rounded small"
                              style={{ whiteSpace: 'pre-wrap', maxHeight: '180px', overflowY: 'auto' }}
                              dangerouslySetInnerHTML={{ __html: campaign.channelConfig['body'] }}
                            />
                          </div>
                        ) : campaign.description ? (
                          <div className="mb-3">
                            <label className="text-muted small fw-semibold block">Descrizione Campagna</label>
                            <div className="p-2 bg-light border rounded small" style={{ whiteSpace: 'pre-wrap' }}>
                              {campaign.description}
                            </div>
                          </div>
                        ) : null}

                        {(campaign.status === 'running' || campaign.status === 'completed' || campaign.status === 'queued' || campaign.status === 'cancelled') && (
                          <div className="mt-4 border-top pt-3">
                            <h4 className="small fw-bold mb-2">Stato dell'Invio ({campaign.sentCount + campaign.failedCount} / {campaign.totalRecipients})</h4>
                            <div className="progress mb-2" style={{ height: '10px' }}>
                              <div
                                className="progress-bar bg-success"
                                role="progressbar"
                                style={{ width: `${campaign.totalRecipients ? (campaign.sentCount / campaign.totalRecipients) * 100 : 0}%` }}
                              ></div>
                              <div
                                className="progress-bar bg-danger"
                                role="progressbar"
                                style={{ width: `${campaign.totalRecipients ? (campaign.failedCount / campaign.totalRecipients) * 100 : 0}%` }}
                              ></div>
                            </div>
                            <div className="d-flex justify-content-between small text-muted">
                              <span><i className="fas fa-check text-success"></i> Successo: {campaign.sentCount}</span>
                              <span><i className="fas fa-times text-danger"></i> Errori: {campaign.failedCount}</span>
                            </div>
                          </div>
                        )}

                        {(campaign.channelType === 'SEND' || campaign.channelConfig?.['protocolla'] === true) && campaignSendStageCounts && (
                          <div className="mt-4 border-top pt-3">
                            <h4 className="small fw-bold mb-2">
                              <i className="fas fa-stamp me-1 text-primary"></i>
                              {campaign.channelType === 'SEND' ? 'Progressione SEND' : 'Stato Protocollazione'}
                            </h4>
                            <div className="d-flex gap-3 text-center small">
                              <div>
                                <div className="fw-bold text-secondary">{campaignSendStageCounts.queued}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>In attesa protocollo</div>
                              </div>
                              <div>
                                <div className="fw-bold text-info">{campaignSendStageCounts.protocollato}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Protocollato (in attesa invio)</div>
                              </div>
                              <div>
                                <div className="fw-bold text-success">{campaignSendStageCounts.inviato}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Inviato</div>
                              </div>
                              <div>
                                <div className={`fw-bold ${campaignSendStageCounts.fallito > 0 ? 'text-danger' : 'text-muted'}`}>{campaignSendStageCounts.fallito}</div>
                                <div className="text-muted" style={{ fontSize: '0.7rem' }}>Fallito</div>
                              </div>
                            </div>
                          </div>
                        )}

                        {channelBreakdown && (
                          <div className="mt-4 border-top pt-3">
                            <h4 className="small fw-bold mb-2">
                              <i className="fas fa-mobile-screen me-1 text-primary"></i>Dettaglio Consegna Multicanale
                            </h4>
                            <div className="small">
                              <div className="d-flex justify-content-between mb-1">
                                <span><i className="fas fa-envelope text-muted me-1"></i>Solo canale primario</span>
                                <span className="fw-bold">{channelBreakdown.primaryOnly}</span>
                              </div>
                              <div className="d-flex justify-content-between mb-1">
                                <span><i className="fas fa-check-double text-success me-1"></i>Anche App IO (parallela)</span>
                                <span className="fw-bold">{channelBreakdown.both}</span>
                              </div>
                              <div className="d-flex justify-content-between mb-1">
                                <span><i className="fas fa-mobile-screen text-success me-1"></i>Solo App IO (esclusiva)</span>
                                <span className="fw-bold">{channelBreakdown.appIoOnly}</span>
                              </div>
                              <div className="d-flex justify-content-between mb-1">
                                <span><i className="fas fa-triangle-exclamation text-warning me-1"></i>App IO riuscito, primario fallito</span>
                                <span className="fw-bold">{channelBreakdown.appIoDespitePrimaryFail}</span>
                              </div>
                              <div className="d-flex justify-content-between">
                                <span><i className="fas fa-times text-danger me-1"></i>Nessuno dei due (fallito)</span>
                                <span className="fw-bold">{channelBreakdown.neither}</span>
                              </div>
                            </div>
                          </div>
                        )}

                        {failureGroups.length > 0 && (
                          <div className="mt-4 border-top pt-3">
                            <h4 className="small fw-bold mb-2 text-danger">
                              <i className="fas fa-triangle-exclamation me-1"></i>
                              Destinatari con invio fallito ({failureGroups.reduce((sum, g) => sum + g.count, 0)}) — raggruppati per motivo
                            </h4>
                            <div className="table-responsive" style={{ maxHeight: 300, overflowY: 'auto' }}>
                              <table className="table table-sm">
                                <thead><tr><th>MOTIVO ERRORE</th><th className="text-end">DESTINATARI</th><th></th></tr></thead>
                                <tbody>
                                  {failureGroups.map((g) => (
                                    <tr key={g.errorMessage}>
                                      <td style={{ maxWidth: 400 }} className="text-break small text-danger">{g.errorMessage}</td>
                                      <td className="text-end fw-bold small">{g.count}</td>
                                      <td className="text-end">
                                        <button
                                          className="btn btn-sm btn-outline-primary"
                                          disabled={retryingGroup === g.errorMessage}
                                          onClick={() => handleRetryGroup(g)}
                                        >
                                          <i className="fas fa-rotate-right me-1"></i>
                                          {retryingGroup === g.errorMessage ? 'Rimetto in coda...' : 'Rimetti in coda tutti'}
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        <div className="mt-4 border-top pt-3">
                          {campaign.status === 'draft' && (
                            <button
                              className="btn btn-success w-100 py-2 fw-semibold"
                              disabled={campaign.totalRecipients === 0 || launching}
                              onClick={handleLaunchCampaign}
                            >
                              {launching ? (
                                <><i className="fas fa-spinner fa-spin me-2"></i>Lancio in corso...</>
                              ) : (
                                <><i className="fas fa-rocket me-2"></i>Lancia Campagna</>
                              )}
                            </button>
                          )}
                          {campaign.status === 'queued' && (
                            <button
                              className="btn btn-outline-danger w-100 py-2 fw-semibold"
                              disabled={cancelling}
                              onClick={handleCancelCampaign}
                            >
                              {cancelling ? (
                                <><i className="fas fa-spinner fa-spin me-2"></i>Annullamento in corso...</>
                              ) : (
                                <><i className="fas fa-ban me-2"></i>Annulla Campagna</>
                              )}
                            </button>
                          )}
                          {campaign.totalRecipients === 0 && campaign.status === 'draft' && (
                            <div className="alert alert-warning small p-2 mt-2 mb-0">
                              <i className="fas fa-info-circle"></i> Carica un file CSV di destinatari per poter lanciare la campagna.
                            </div>
                          )}
                          {role === 'admin' && (
                            <button
                              className="btn btn-outline-danger w-100 py-2 fw-semibold mt-2"
                              onClick={() => handleDeleteCampaign(campaign.id, campaign.name)}
                            >
                              <i className="fas fa-trash me-2"></i>Elimina Campagna
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="col-lg-8">
                    {campaign.status === 'draft' && (
                      <div className="card shadow-sm mb-4">
                        <div className="card-body text-center py-4">
                          <p className="text-muted small mb-3">
                            Il caricamento destinatari (con tutte le validazioni su formato CF, email e vincoli App IO)
                            avviene solo dal wizard guidato.
                          </p>
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => handleResumeDraft(campaign.id)}
                          >
                            <i className="fas fa-edit me-1"></i> Riprendi wizard campagna
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="card shadow-sm">
                      <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center flex-wrap gap-2">
                        <h3 className="h6 mb-0 fw-bold text-dark">
                          <i className="fas fa-users me-2"></i>Destinatari Caricati ({recipientsPage?.total ?? campaign.totalRecipients})
                        </h3>
                        <div className="d-flex align-items-center flex-wrap gap-2">
                          <input
                            type="text"
                            className="form-control form-control-sm"
                            style={{ maxWidth: 260 }}
                            placeholder="Cerca per nominativo o CF..."
                            value={recipientsSearch}
                            onChange={(e) => { setRecipientsSearch(e.target.value); setRecipientsPageNum(1); }}
                          />
                          {(campaign?.totalRecipients ?? 0) > 0 && (
                            <button className="btn btn-sm btn-outline-primary py-1" onClick={handleExportDownloadReport} title="Esporta Report CSV">
                              <i className="fas fa-file-excel me-1"></i> Esporta Report Download
                            </button>
                          )}
                          <button className="btn btn-outline-secondary btn-sm border-0" onClick={() => fetchCampaignDetail(campaign.id)} title="Aggiorna esiti">
                            <i className="fas fa-sync-alt"></i>
                          </button>
                        </div>
                      </div>
                      <div className="card-body p-0">
                        {!recipientsPage || recipientsPage.items.length === 0 ? (
                          <div className="text-center py-5 text-muted">Nessun destinatario associato a questa campagna.</div>
                        ) : (
                          <>
                            <div className="table-responsive" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                              <table className="table table-striped table-hover align-middle mb-0" style={{ fontSize: '0.82rem' }}>
                                <thead className="table-light sticky-top">
                                  <tr>
                                    <th>Codice Fiscale</th>
                                    <th>Nominativo</th>
                                    <th>Contatti (Email/PEC)</th>
                                    <th>Stato Notifica</th>
                                    {campaign.channelType === 'SEND' ? (
                                      <><th>IUN</th><th>Protocollo</th><th>Stato SEND</th><th>Aggiornato il</th></>
                                    ) : campaign.channelConfig?.['protocolla'] ? (
                                      <><th>Protocollo</th><th className="text-center">Download</th></>
                                    ) : (
                                      <th className="text-center">Download</th>
                                    )}
                                  </tr>
                                </thead>
                                <tbody>
                                  {recipientsPage.items.map((r) => (
                                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => openNotificationDetail(r.id)}>
                                      <td className="fw-mono fw-bold">{r.codiceFiscale}</td>
                                      <td>{r.fullName || <span className="text-muted">N/D</span>}</td>
                                      <td>
                                        <div className="small d-flex flex-column gap-1">
                                          {r.email && <div><i className="far fa-envelope me-1"></i> {r.email}</div>}
                                          {r.pec && <div className="text-primary"><i className="fas fa-envelope-open-text me-1"></i> {r.pec}</div>}
                                        </div>
                                      </td>
                                      <td><StatusBadge status={r.status} /></td>
                                      {campaign.channelType === 'SEND' ? (
                                        <>
                                          <td className="small fw-mono">{r.iun || '—'}</td>
                                          <td className="small">{r.protocolNumber ? `${r.protocolNumber}/${r.protocolYear}` : '—'}</td>
                                          <td className="small"><SendStatusBadge status={r.sendStatus} /></td>
                                          <td className="small text-muted">{r.sendStatusUpdatedAt ? new Date(r.sendStatusUpdatedAt).toLocaleString('it-IT') : '—'}</td>
                                        </>
                                      ) : campaign.channelConfig?.['protocolla'] ? (
                                        <>
                                          <td className="small">{r.protocolNumber ? `${r.protocolNumber}/${r.protocolYear}` : '—'}</td>
                                          <td className="text-center fw-bold">
                                            {r.downloadCount ? (
                                              <span className="text-success">
                                                <i className="fas fa-arrow-down me-1"></i> {r.downloadCount}
                                              </span>
                                            ) : (
                                              <span className="text-muted">—</span>
                                            )}
                                          </td>
                                        </>
                                      ) : (
                                        <td className="text-center fw-bold">
                                          {r.downloadCount ? (
                                            <span className="text-success">
                                              <i className="fas fa-arrow-down me-1"></i> {r.downloadCount}
                                            </span>
                                          ) : (
                                            <span className="text-muted">—</span>
                                          )}
                                        </td>
                                      )}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <div className="d-flex justify-content-between align-items-center p-2 border-top">
                              <span className="text-muted small">
                                Pagina {recipientsPage.page} di {Math.max(1, Math.ceil(recipientsPage.total / recipientsPage.pageSize))}
                              </span>
                              <div className="btn-group btn-group-sm">
                                <button className="btn btn-outline-secondary" disabled={recipientsPageNum <= 1} onClick={() => setRecipientsPageNum((p) => p - 1)}>Precedente</button>
                                <button className="btn btn-outline-secondary" disabled={recipientsPageNum >= Math.ceil(recipientsPage.total / recipientsPage.pageSize)} onClick={() => setRecipientsPageNum((p) => p + 1)}>Successiva</button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="row g-4 mt-0">
                      <div className="col-md-6">
                        <div className="card shadow-sm h-100">
                          <div className="card-header bg-white py-3 border-bottom">
                            <h3 className="h6 mb-0 fw-bold text-dark">
                              <i className="fas fa-chart-pie me-2 text-primary"></i>Esito Invio
                            </h3>
                          </div>
                          <div className="card-body">
                            <ResponsiveContainer width="100%" height={220}>
                              <PieChart>
                                <Pie
                                  data={[
                                    { label: 'Inviati con successo', value: campaign.sentCount },
                                    { label: 'Falliti', value: campaign.failedCount },
                                  ]}
                                  dataKey="value"
                                  nameKey="label"
                                  cx="50%"
                                  cy="50%"
                                  outerRadius={80}
                                  label={renderPiePercentLabel}
                                  labelLine={false}
                                >
                                  <Cell fill="var(--bi-success, #198754)" />
                                  <Cell fill="var(--bi-danger, #dc3545)" />
                                </Pie>
                                <Tooltip />
                                <Legend />
                              </PieChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      </div>

                      <div className="col-md-6">
                        <div className="card shadow-sm h-100">
                          <div className="card-header bg-white py-3 border-bottom">
                            <h3 className="h6 mb-0 fw-bold text-dark">
                              <i className="fas fa-chart-pie me-2 text-primary"></i>Download per Canale
                            </h3>
                          </div>
                          <div className="card-body">
                            {downloadCombinations ? (() => {
                              // Percentuali calcolate solo sui destinatari notificati con successo
                              // (sentSuccessfully): un fallito non ha mai avuto un link da scaricare,
                              // mescolarlo nel bucket "non scaricato" renderebbe la % fuorviante su
                              // campagne con molti fallimenti (già visibili in "Esito Invio").
                              const successCombos = downloadCombinations.filter((c) => c.sentSuccessfully);
                              const anomalyCombos = downloadCombinations.filter((c) => !c.sentSuccessfully);
                              const sentCount = successCombos.reduce((sum, c) => sum + c.count, 0);
                              const notDownloaded = successCombos.find((c) => c.channels.length === 0)?.count ?? 0;
                              const downloaded = sentCount - notDownloaded;
                              const pct = (n: number) => (sentCount > 0 ? `${Math.round((n / sentCount) * 100)}%` : '0%');

                              const colorFor = (c: { channels: string[] }, i: number) => (c.channels.length === 0 ? '#adb5bd' : PIE_COLORS[i % PIE_COLORS.length]);

                              return (
                                <>
                                  <div className="d-flex justify-content-center text-center mb-3" style={{ gap: '3rem' }}>
                                    <div>
                                      <div className="h4 mb-0 text-success">{pct(downloaded)}</div>
                                      <div className="small text-muted">Scaricati ({downloaded})</div>
                                    </div>
                                    <div>
                                      <div className="h4 mb-0 text-secondary">{pct(notDownloaded)}</div>
                                      <div className="small text-muted">Non scaricati ({notDownloaded})</div>
                                    </div>
                                  </div>
                                  <ResponsiveContainer width="100%" height={220}>
                                    <PieChart>
                                      <Pie
                                        data={successCombos.map((c) => ({ label: downloadComboLabel(c.channels), value: c.count }))}
                                        dataKey="value"
                                        nameKey="label"
                                        cx="50%"
                                        cy="50%"
                                        outerRadius={90}
                                        label={renderPiePercentLabel}
                                        labelLine={false}
                                      >
                                        {successCombos.map((c, i) => (
                                          <Cell key={c.channels.join('+') || 'none'} fill={colorFor(c, i)} />
                                        ))}
                                      </Pie>
                                      <Tooltip />
                                    </PieChart>
                                  </ResponsiveContainer>
                                  <table className="table table-sm mb-0 mt-2">
                                    <tbody>
                                      {successCombos.map((c, i) => (
                                        <tr key={c.channels.join('+') || 'none'}>
                                          <td>
                                            <span
                                              className="d-inline-block me-2"
                                              style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: colorFor(c, i) }}
                                            ></span>
                                            {downloadComboLabel(c.channels)}
                                          </td>
                                          <td className="text-end fw-bold">{c.count}</td>
                                          <td className="text-end text-muted">{pct(c.count)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  {anomalyCombos.length > 0 && (
                                    <div className="alert alert-warning small mt-3 mb-0">
                                      <i className="fas fa-triangle-exclamation me-1"></i>
                                      {anomalyCombos.reduce((sum, c) => sum + c.count, 0)} destinatari non notificati con successo hanno comunque scaricato l'allegato (es. link ancora valido da un tentativo precedente):
                                      <ul className="mb-0 mt-1">
                                        {anomalyCombos.map((c) => (
                                          <li key={c.channels.join('+') || 'none'}>{downloadComboLabel(c.channels)}: {c.count}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </>
                              );
                            })() : (
                              <div className="text-center text-muted py-4">Nessun dato di download disponibile.</div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
