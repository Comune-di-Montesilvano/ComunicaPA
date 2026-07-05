import React, { useState, useEffect } from 'react';
import MDEditor from '@uiw/react-md-editor';
import { TemplateEditor } from './components/TemplateEditor';

declare global {
  interface Window {
    __COMUNICAPA_CONFIG__?: { apiBase?: string };
  }
}

const API_BASE = window.__COMUNICAPA_CONFIG__?.apiBase ?? 'http://localhost:8080';

// Tiptap's editor.getHTML() always returns a non-empty shell (e.g. '<p></p>')
// even when the user has deleted all content, so a plain truthiness check on
// the HTML string is not enough to detect an "empty" body.
function isWizBodyEmpty(html: string): boolean {
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
  return text.length === 0;
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
  status: 'draft' | 'queued' | 'running' | 'completed' | 'failed';
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

export function App(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(localStorage.getItem('comunicapa_token'));
  const [username, setUsername] = useState<string | null>(localStorage.getItem('comunicapa_username'));
  const [role, setRole] = useState<string | null>(localStorage.getItem('comunicapa_role'));
  const [view, setView] = useState<'dashboard' | 'invio-singolo' | 'invio-massivo' | 'invio-massivo-wizard' | 'statistiche' | 'notifiche-ricerca' | 'template-dashboard' | 'impostazioni' | 'campaign-detail'>('dashboard');
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [editingTemplate, setEditingTemplate] = useState<Partial<TemplateItem> & { type: 'MAIL' | 'APP_IO' } | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [isLdapMock, setIsLdapMock] = useState<boolean>(false);
  const [brandLogoUrl, setBrandLogoUrl] = useState<string | null>(null);
  const [brandName, setBrandName] = useState<string>('ComunicaPA');
  const [brandSubtitle, setBrandSubtitle] = useState<string>('Amministrazione & Gestione Invii');

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
      const res = await fetch(`${API_BASE}/notifications-search?${params.toString()}`, {
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

  useEffect(() => {
    if (view === 'notifiche-ricerca' && token) {
      runNotificationSearch(1);
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

  // New campaign state (in Invio Massivo)
  const [newCampaignName, setNewCampaignName] = useState('');
  const [newCampaignDesc, setNewCampaignDesc] = useState('');
  const [newCampaignSubject, setNewCampaignSubject] = useState('');
  const [newCampaignBody, setNewCampaignBody] = useState('');
  const [newCampaignChannel, setNewCampaignChannel] = useState<'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL'>('EMAIL');
  const [selectedAppIoServiceId, setSelectedAppIoServiceId] = useState('');

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
    allegato1: '',
  });
  const [wizValidationErrors, setWizValidationErrors] = useState<Array<{ row: number; field: string; val: string; err: string }>>([]);
  const [wizValidationWarnings, setWizValidationWarnings] = useState<Array<{ row: number; field: string; val: string; warn: string }>>([]);
  const [wizValidRows, setWizValidRows] = useState<Record<string, string>[]>([]);
  const [wizSubject, setWizSubject] = useState('');
  const [wizBody, setWizBody] = useState('');
  const [wizPreviewIndex, setWizPreviewIndex] = useState(0);
  const [wizSending, setWizSending] = useState(false);
  const [wizMailConfigId, setWizMailConfigId] = useState('');
  const [wizAppIoMode, setWizAppIoMode] = useState<'none' | 'parallel' | 'exclusive'>('parallel');
  const [wizBlockedChannels, setWizBlockedChannels] = useState<string[]>([]);
  const [wizCampaignId, setWizCampaignId] = useState<string | null>(null);
  const [wizDraftSaving, setWizDraftSaving] = useState(false);

  const getWizRowFullName = (row: Record<string, string>) => {
    if (!row) return '';
    const fn1 = row[wizMapping.full_name] || '';
    const fn2 = wizMapping.full_name_2 ? (row[wizMapping.full_name_2] || '') : '';
    return [fn1, fn2].filter(Boolean).join(' ');
  };

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

  const [settSendApiKey, setSettSendApiKey] = useState('');
  const [settSendUrl, setSettSendUrl] = useState('https://api.notifichedigitali.it');
  const [settRetentionDays, setSettRetentionDays] = useState('90');

  const [settOidcIssuer, setSettOidcIssuer] = useState('');
  const [settOidcAudience, setSettOidcAudience] = useState('');
  const [settOidcJwksUri, setSettOidcJwksUri] = useState('');
  const [settOidcClientId, setSettOidcClientId] = useState('');
  const [settOidcClientSecret, setSettOidcClientSecret] = useState('');
  const [settOidcLogoutUrl, setSettOidcLogoutUrl] = useState('');
  const [settCitizenPublicUrl, setSettCitizenPublicUrl] = useState('');

  const [settProtoProvider, setSettProtoProvider] = useState(localStorage.getItem('sett_proto_provider') || 'Maggioli');
  const [settProtoUrl, setSettProtoUrl] = useState(localStorage.getItem('sett_proto_url') || 'https://protocollo.comune.montesilvano.pe.it/api');
  const [settProtoUser, setSettProtoUser] = useState(localStorage.getItem('sett_proto_user') || 'api_user');
  const [settProtoPass, setSettProtoPass] = useState(localStorage.getItem('sett_proto_pass') || '••••••••');

  const [settPostalProvider, setSettPostalProvider] = useState(localStorage.getItem('sett_postal_provider') || 'Postel');
  const [settPostalKey, setSettPostalKey] = useState(localStorage.getItem('sett_postal_key') || '');
  const [settPostalUrl, setSettPostalUrl] = useState(localStorage.getItem('sett_postal_url') || 'https://gateway.postel.it/postalization');

  const [activeSettingsTab, setActiveSettingsTab] = useState<'personalizzazione' | 'smtp' | 'pec' | 'app-io' | 'send' | 'protocollo' | 'postalizzazione' | 'oidc' | 'motori'>('personalizzazione');
  const [engines, setEngines] = useState<any[]>([]);
  const [loadingEngines, setLoadingEngines] = useState(false);
  const [enginesError, setEnginesError] = useState<string | null>(null);
  const [engineJobsChannel, setEngineJobsChannel] = useState<string | null>(null);
  const [engineJobs, setEngineJobs] = useState<Array<{ jobId: string; campaignId: string; recipientId: string; failedReason?: string; attemptsMade: number }>>([]);
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
  const [campaignFailures, setCampaignFailures] = useState<Array<{ recipientId: string; codiceFiscale: string; fullName: string | null; errorMessage: string | null; attemptNumber: number; lastAttemptAt: string }>>([]);
  const [retryBusyId, setRetryBusyId] = useState<string | null>(null);

  // CSV Mapper state
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({
    codice_fiscale: '',
    full_name: '',
    email: '',
    pec: '',
  });
  const [csvError, setCsvError] = useState<string | null>(null);
  const [uploadingCsv, setUploadingCsv] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);

  // Pre-select default App IO service id for forms
  useEffect(() => {
    const def = ioServices.find(s => s.isDefault);
    if (def) {
      setSelectedAppIoServiceId(def.id);
      setSingleAppIoServiceId(def.id);
    } else if (ioServices.length > 0) {
      setSelectedAppIoServiceId(ioServices[0].id);
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

  useEffect(() => {
    if (token) {
      fetchCampaigns();
      fetchMailConfigs();
      fetchIoServices();
    }
  }, [token]);

  useEffect(() => { if (token) fetchTemplates(); }, [token]);

  // Carica le impostazioni persistite dal backend al login
  useEffect(() => {
    if (!token) return;
    fetch(`${API_BASE}/settings`, { headers: { Authorization: `Bearer ${token}` } })
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
        setSettSendApiKey(String(s['send.apiKey'] ?? ''));
        setSettSendUrl(String(s['send.baseUrl'] ?? ''));
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
      const res = await fetch(`${API_BASE}/auth/login`, {
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
    const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
    if (res.status === 401) {
      handleLogout();
      throw new ApiAuthError();
    }
    return res;
  };

  const fetchCampaigns = async () => {
    setLoadingCampaigns(true);
    setDashboardError(null);
    try {
      const res = await fetch(`${API_BASE}/campaigns`, {
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

  const fetchCampaignFailures = async (campaignId: string) => {
    try {
      const res = await apiFetch(`/campaigns/${campaignId}/failures`);
      if (res.ok) setCampaignFailures(await res.json());
    } catch (err) {
      if (err instanceof ApiAuthError) return;
      throw err;
    }
  };

  const handleRetryRecipient = async (campaignId: string, recipientId: string) => {
    setRetryBusyId(recipientId);
    try {
      await fetch(`${API_BASE}/campaigns/${campaignId}/recipients/${recipientId}/retry`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchCampaignFailures(campaignId);
    } finally {
      setRetryBusyId(null);
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
        } else if (channelVal === 'APP_IO') {
          channelConfig = { ioServiceId: selectedAppIoServiceId };
        } else if (channelVal === 'SEND') {
          channelConfig = { apiKey: settSendApiKey, baseUrl: settSendUrl };
        }
      }

      const res = await fetch(`${API_BASE}/campaigns`, {
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

  const handleNewCampaignSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoadingCampaigns(true);
    try {
      let customConfig: Record<string, any> | undefined = undefined;
      
      if (newCampaignChannel === 'APP_IO') {
        customConfig = { ioServiceId: selectedAppIoServiceId };
      } else if (newCampaignChannel === 'EMAIL' || newCampaignChannel === 'PEC') {
        customConfig = {
          subject: newCampaignSubject,
          body: newCampaignBody,
        };
        // Bundle default App IO service configuration for co-delivery if available
        const defaultSvc = ioServices.find(s => s.isDefault) || ioServices[0];
        if (defaultSvc) {
          customConfig.appIo = { ioServiceId: defaultSvc.id };
        }
      }

      await handleCreateCampaign(newCampaignName, newCampaignDesc, newCampaignChannel, customConfig);
      setNewCampaignName('');
      setNewCampaignDesc('');
      setNewCampaignSubject('');
      setNewCampaignBody('');
      fetchCampaigns();
      alert('Campagna creata correttamente in stato bozza!');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoadingCampaigns(false);
    }
  };

  // Single Send handler
  const handleSingleSendSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!singleCf) {
      alert('Il Codice Fiscale è obbligatorio.');
      return;
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

      const uploadRes = await fetch(`${API_BASE}/campaigns/${campaignObj.id}/recipients/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });

      if (!uploadRes.ok) {
        throw new Error('Impossibile associare il destinatario.');
      }

      const launchRes = await fetch(`${API_BASE}/campaigns/${campaignObj.id}/launch`, {
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
    await fetch(`${API_BASE}/io-services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
  };

  const handleSetDefaultIoService = async (id: string) => {
    await fetch(`${API_BASE}/io-services/${id}/default`, {
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
    const res = await fetch(`${API_BASE}/io-services/${id}`, {
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
      const res = await fetch(`${API_BASE}/io-services/${id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ codiceFiscale: ioTestCf.toUpperCase().trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Test fallito');
      setIoTestMsg({ id, text: data.message, error: false });
    } catch (err: any) {
      setIoTestMsg({ id, text: err.message, error: true });
    } finally {
      setIoTestBusyId(null);
    }
  };

  // Settings Save handler
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    // Canali non ancora migrati al backend: restano su localStorage
    // (App IO ora persistito lato server via /io-services, niente più localStorage)
    localStorage.setItem('sett_proto_provider', settProtoProvider);
    localStorage.setItem('sett_proto_url', settProtoUrl);
    localStorage.setItem('sett_proto_user', settProtoUser);
    localStorage.setItem('sett_proto_pass', settProtoPass);
    localStorage.setItem('sett_postal_provider', settPostalProvider);
    localStorage.setItem('sett_postal_key', settPostalKey);
    localStorage.setItem('sett_postal_url', settPostalUrl);

    try {
      const res = await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            'brand.name': settEntityName,
            'brand.subtitle': settSubtitle,
            'brand.logo': settLogoValue,
            'brand.favicon': settFaviconValue,
            // SMTP and PEC are saved via their own endpoints; App IO via /io-services
            'send.apiKey': settSendApiKey,
            'send.baseUrl': settSendUrl,
            'retention.maxDays': Number(settRetentionDays) || 90,
            'oidc.issuer': settOidcIssuer,
            'oidc.audience': settOidcAudience,
            'oidc.jwksUri': settOidcJwksUri,
            'oidc.clientId': settOidcClientId,
            'oidc.clientSecret': settOidcClientSecret,
            'oidc.logoutUrl': settOidcLogoutUrl,
          },
        }),
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

  const fetchEngines = async () => {
    if (!token) return;
    setLoadingEngines(true);
    setEnginesError(null);
    try {
      const res = await fetch(`${API_BASE}/engines`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEngines(data.engines || []);
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
      const res = await fetch(`${API_BASE}/engines/${channel.toLowerCase()}/${action}`, {
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
    const res = await fetch(`${API_BASE}/engines/${channel.toLowerCase()}/jobs?status=failed&limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    setEngineJobs(data.jobs || []);
  };

  const handleUploadBranding = async (kind: 'logo' | 'favicon', file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_BASE}/settings/branding/${kind}`, {
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
      const res = await fetch(`${API_BASE}/mail-configs`, {
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
    const res = await fetch(`${API_BASE}/templates`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    setTemplates(data.templates || []);
  };

  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTemplate) return;
    const method = editingTemplate.id ? 'PUT' : 'POST';
    const url = editingTemplate.id ? `${API_BASE}/templates/${editingTemplate.id}` : `${API_BASE}/templates`;
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
    await fetch(`${API_BASE}/templates/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    fetchTemplates();
  };

  const fetchIoServices = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/io-services`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        setIoServices(data.configs || []);
      }
    } catch (err) {
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
      const url = isEdit ? `${API_BASE}/mail-configs/${editingMailConfig.id}` : `${API_BASE}/mail-configs`;
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
      const res = await fetch(`${API_BASE}/mail-configs/${id}`, {
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
      const res = await fetch(`${API_BASE}/mail-configs/${id}/active`, {
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
      const res = await fetch(`${API_BASE}/mail-configs/${id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to: mailConfigTestTo }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Errore invio email test');
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


  const handleExportDownloadReport = () => {
    if (!campaign || !campaign.recipients || campaign.recipients.length === 0) {
      alert('Nessun destinatario da esportare');
      return;
    }

    const headers = ['Codice Fiscale', 'Nominativo', 'Email', 'PEC', 'Stato Invio', 'Download Effettuati', 'Data Ultimo Download'];
    const rows = campaign.recipients.map(r => {
      const downloadCount = r.extraData?.['download_count'] ?? 0;
      const downloadedAt = r.extraData?.['downloaded_at'] 
        ? new Date(r.extraData['downloaded_at']).toLocaleString('it-IT')
        : '';
      return [
        r.codiceFiscale,
        r.fullName || '',
        r.email || '',
        r.pec || '',
        r.status,
        downloadCount,
        downloadedAt
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `report_download_campagna_${campaign.id.slice(0, 8)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
        allegato1: '',
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
        else if (hLower === 'allegato1' || hLower === 'documento' || hLower === 'avviso' || hLower === 'pdf') newMapping.allegato1 = h;
      });
      setWizMapping(newMapping);
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

    const cfField = wizMapping.codice_fiscale;
    const emailField = wizMapping.email;
    const pecField = wizMapping.pec;

    const isEmailMandatory = wizChannel === 'EMAIL';
    const isPecMandatory = wizChannel === 'PEC';
    const isCfMandatory = wizChannel === 'APP_IO' || wizChannel === 'SEND';

    wizCsvRows.forEach((row, idx) => {
      let isRowValid = true;
      const rowNum = idx + 1;

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
        if (!isCf && !isPiva) {
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
    link.setAttribute('download', `errori_validazione_${wizCsvFile?.name || 'campagna'}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const prefillWizardFrom = (source: {
    name: string;
    description: string | null;
    channelType: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL';
    channelConfig: Record<string, any>;
  }, opts: { isDuplicate: boolean }) => {
    setWizCampaignId(null);
    setWizName(opts.isDuplicate ? `${source.name} (Copia)` : source.name);
    setWizDesc(source.description || '');
    setWizChannel(source.channelType);
    setWizSubject(source.channelConfig?.subject || '');
    setWizBody(source.channelConfig?.body || '');
    setWizMailConfigId(source.channelConfig?.mailConfigId || '');
    setWizAppIoServiceId(
      source.channelConfig?.appIo?.ioServiceId ||
      source.channelConfig?.serviceId ||
      source.channelConfig?.ioServiceId ||
      ''
    );
    setWizAppIoMode(source.channelConfig?.appIo?.mode || (source.channelConfig?.appIo ? 'parallel' : 'none'));
    setWizBlockedChannels(source.channelConfig?.blockedChannels || []);
    // Il CSV NON viene precaricato: l'utente ricarica un file al passo 2.
    setWizCsvFile(null);
    setWizCsvHeaders([]);
    setWizCsvRows([]);
    setWizValidRows([]);
    setWizStep(1);
    setView('invio-massivo-wizard');
  };

  const handleDuplicateCampaign = async (campaignId: string) => {
    const res = await fetch(`${API_BASE}/campaigns/${campaignId}/duplicate-source`, {
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
    const res = await fetch(`${API_BASE}/campaigns/${campaignId}/duplicate-source`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      alert('Impossibile leggere i dati della bozza.');
      return;
    }
    const source = await res.json();
    prefillWizardFrom(source, { isDuplicate: false });
    setWizCampaignId(campaignId);
  };

  const buildWizChannelConfigDraft = (): Record<string, any> => {
    const cfg: Record<string, any> = { subject: wizSubject, body: wizBody, mailConfigId: wizMailConfigId };
    if (wizChannel === 'APP_IO') {
      cfg.ioServiceId = wizAppIoServiceId;
    }
    if (wizAppIoMode !== 'none' && wizAppIoServiceId) {
      cfg.appIo = { mode: wizAppIoMode, ioServiceId: wizAppIoServiceId };
    }
    if (wizBlockedChannels.length > 0) cfg.blockedChannels = wizBlockedChannels;
    return cfg;
  };

  const handleSaveWizardDraft = async () => {
    if (!wizName) {
      alert('Inserisci almeno il nome della campagna prima di salvare la bozza.');
      return;
    }
    setWizDraftSaving(true);
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
        channelConfig = { ioServiceId: svc ? svc.id : '' };
      } else if (wizChannel === 'EMAIL' || wizChannel === 'PEC') {
        const activeCfg = mailConfigs.find(c => c.id === wizMailConfigId);
        channelConfig = {
          subject: wizSubject,
          body: wizBody,
          allegatoKey: wizMapping.allegato1,
          mailConfigId: wizMailConfigId,
          from: activeCfg?.fromAddress || '',
        };

        if (wizAppIoMode !== 'none') {
          const defaultSvc = ioServices.find(s => s.id === wizAppIoServiceId) || ioServices.find(s => s.isDefault) || ioServices[0];
          if (defaultSvc) {
            channelConfig.appIo = {
              mode: wizAppIoMode,
              ioServiceId: defaultSvc.id,
            };
          }
        }
      } else if (wizChannel === 'SEND') {
        channelConfig = { apiKey: settSendApiKey, baseUrl: settSendUrl };
      }

      if (wizBlockedChannels.length > 0) {
        channelConfig.blockedChannels = wizBlockedChannels;
      }

      let campaignObj: { id: string };
      if (wizCampaignId) {
        const patchRes = await fetch(`${API_BASE}/campaigns/${wizCampaignId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: wizName, description: wizDesc || wizSubject || wizName, channelConfig }),
        });
        if (!patchRes.ok) throw new Error('Errore durante l\'aggiornamento della bozza');
        campaignObj = { id: wizCampaignId };
      } else {
        const res = await fetch(`${API_BASE}/campaigns`, {
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
      const formData = new FormData();
      formData.append('file', blob, 'normalized_recipients.csv');

      const uploadRes = await fetch(`${API_BASE}/campaigns/${campaignObj.id}/recipients/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });

      if (!uploadRes.ok) {
        throw new Error('Errore durante il caricamento dei destinatari.');
      }

      // Caricamento allegati PDF personalizzati
      let discardCount = 0;
      if (wizPdfFiles && wizPdfFiles.length > 0) {
        const attachFormData = new FormData();
        wizPdfFiles.forEach(file => {
          attachFormData.append('files', file);
        });
        const attachRes = await fetch(`${API_BASE}/campaigns/${campaignObj.id}/attachments`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: attachFormData,
        });
        if (!attachRes.ok) {
          throw new Error('Errore durante il caricamento dei file PDF/ZIP degli allegati.');
        }
        const attachData = await attachRes.json() as { uploaded: number; discarded?: number };
        discardCount = attachData.discarded || 0;
      }

      const launchRes = await fetch(`${API_BASE}/campaigns/${campaignObj.id}/launch`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!launchRes.ok) {
        throw new Error('Errore durante il lancio della campagna.');
      }

      setWizStep(1);
      setWizCampaignId(null);
      setWizName('');
      setWizDesc('');
      setWizSubject('');
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
        allegato1: '',
      });
      setWizValidationErrors([]);
      setWizValidationWarnings([]);
      setWizValidRows([]);
      setWizMailConfigId('');
      setWizAppIoMode('parallel');
      setWizBlockedChannels([]);

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
    }
  };

  const handleCampaignClick = (id: string) => {
    setSelectedCampaignId(id);
    setView('campaign-detail');
    setCampaign(null);
    setCsvFile(null);
    setCsvHeaders([]);
    setCsvRows([]);
    setUploadSuccess(false);
    setCsvError(null);
    setCampaignFailures([]);
    fetchCampaignDetail(id);
    fetchCampaignFailures(id);
  };

  const handleLaunchCampaign = async () => {
    if (!campaign) return;
    if (!confirm(`Sei sicuro di voler lanciare la campagna "${campaign.name}"? L'invio ai destinatari avverrà asincronamente.`)) {
      return;
    }
    setLaunching(true);
    try {
      const res = await fetch(`${API_BASE}/campaigns/${campaign.id}/launch`, {
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

  // Helper to parse CSV
  const handleCsvChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCsvError(null);
    setUploadSuccess(false);
    const file = e.target.files?.[0];
    if (!file) return;

    setCsvFile(file);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
      if (lines.length === 0) {
        setCsvError('Il file CSV è vuoto.');
        return;
      }

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

      const headers = parseCsvLine(lines[0]);
      setCsvHeaders(headers);

      const rows = lines.slice(1).map(line => parseCsvLine(line));
      setCsvRows(rows);

      const newMapping = {
        codice_fiscale: '',
        full_name: '',
        email: '',
        pec: '',
      };
      headers.forEach(h => {
        const hLower = h.toLowerCase().replace(/[\s_-]/g, '');
        if (hLower.includes('cf') || hLower.includes('codicefiscale') || hLower.includes('fiscale')) {
          newMapping.codice_fiscale = h;
        } else if (hLower.includes('nome') || hLower.includes('cognome') || hLower.includes('fullname') || hLower.includes('nominativo')) {
          newMapping.full_name = h;
        } else if (hLower.includes('pec')) {
          newMapping.pec = h;
        } else if (hLower.includes('mail') || hLower.includes('email')) {
          newMapping.email = h;
        }
      });
      setMapping(newMapping);
    };
    reader.readAsText(file);
  };

  const handleMappingChange = (field: string, header: string) => {
    setMapping(prev => ({ ...prev, [field]: header }));
  };

  const handleUploadMappedCsv = async () => {
    if (!campaign || !csvFile || !mapping.codice_fiscale) {
      setCsvError('Devi mappare almeno il campo Codice Fiscale.');
      return;
    }

    setUploadingCsv(true);
    setCsvError(null);

    try {
      let csvContent = 'codice_fiscale,full_name,email,pec';
      const extraHeaders = csvHeaders.filter(h => 
        h !== mapping.codice_fiscale && 
        h !== mapping.full_name && 
        h !== mapping.email && 
        h !== mapping.pec
      );
      
      if (extraHeaders.length > 0) {
        csvContent += ',' + extraHeaders.join(',');
      }
      csvContent += '\n';

      csvRows.forEach(row => {
        const cfIndex = csvHeaders.indexOf(mapping.codice_fiscale);
        const nameIndex = csvHeaders.indexOf(mapping.full_name);
        const emailIndex = csvHeaders.indexOf(mapping.email);
        const pecIndex = csvHeaders.indexOf(mapping.pec);

        const cf = cfIndex !== -1 ? row[cfIndex] || '' : '';
        const name = nameIndex !== -1 ? row[nameIndex] || '' : '';
        const email = emailIndex !== -1 ? row[emailIndex] || '' : '';
        const pec = pecIndex !== -1 ? row[pecIndex] || '' : '';

        if (!cf.trim()) return;

        let line = `"${cf.replace(/"/g, '""')}","${name.replace(/"/g, '""')}","${email.replace(/"/g, '""')}","${pec.replace(/"/g, '""')}"`;
        extraHeaders.forEach(eh => {
          const idx = csvHeaders.indexOf(eh);
          const val = idx !== -1 ? row[idx] || '' : '';
          line += `,"${val.replace(/"/g, '""')}"`;
        });
        csvContent += line + '\n';
      });

      const blob = new Blob([csvContent], { type: 'text/csv' });
      const formData = new FormData();
      formData.append('file', blob, 'mapped_recipients.csv');

      const res = await fetch(`${API_BASE}/campaigns/${campaign.id}/recipients/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Errore durante il caricamento del CSV');
      }

      setUploadSuccess(true);
      setCsvFile(null);
      setCsvHeaders([]);
      setCsvRows([]);
      fetchCampaignDetail(campaign.id);
    } catch (err: any) {
      setCsvError(err.message);
    } finally {
      setUploadingCsv(false);
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
                                  <td>{c.channelType}</td>
                                  <td>
                                    <span className={`badge ${c.status === 'completed' ? 'bg-success' : 'bg-secondary'}`}>
                                      {c.status.toUpperCase()}
                                    </span>
                                  </td>
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
                      <button className="btn btn-sm btn-primary" onClick={() => { setWizCampaignId(null); setWizStep(1); setView('invio-massivo-wizard'); }}>
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
                                  <span className="badge bg-light text-dark border">
                                    {c.channelType}
                                    {c.channelConfig?.['serviceName'] && ` (${c.channelConfig['serviceName']})`}
                                  </span>
                                </td>
                                <td className="text-center fw-bold">{c.totalRecipients}</td>
                                <td className="text-center">
                                  <span className={`badge ${
                                    c.status === 'completed' ? 'bg-success' :
                                    c.status === 'draft' ? 'bg-secondary' : 'bg-warning text-dark'
                                  }`}>
                                    {c.status.toUpperCase()}
                                  </span>
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
                      }}
                    >
                      <option value="EMAIL">EMAIL</option>
                      <option value="PEC">PEC (Posta Elettronica Certificata)</option>
                      <option value="APP_IO">APP IO (PagoPA)</option>
                      <option value="SEND">SEND</option>
                      <option value="POSTAL">POSTAL</option>
                    </select>
                  </div>

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
                            setWizMapping({ codice_fiscale: '', full_name: '', full_name_2: '', email: '', pec: '', allegato1: '' });
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
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
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
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
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
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
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
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
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
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>

                    <div className="col-md-6">
                      <label className="form-label small fw-semibold text-muted">Campo Speciale Allegato (es: Tassa, Ruolo)</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizMapping.allegato1}
                        onChange={e => handleWizMappingChange('allegato1', e.target.value)}
                      >
                        <option value="">-- Seleziona Colonna Speciale --</option>
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  </div>

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
                    <h4 className="h6 fw-bold text-dark mb-3">Passo 4: Scrittura Template & Jolly Fields</h4>
                    
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Oggetto della Comunicazione (Template)</label>
                      <input
                        type="text"
                        className="form-control form-control-sm"
                        placeholder="Es: Avviso Scadenza TARI 2026 - %nominativo%"
                        value={wizSubject}
                        onChange={e => setWizSubject(e.target.value)}
                        required
                      />
                    </div>

                    <div className="mb-3">
                      <label className="form-label small fw-bold">Corpo del Messaggio (Template)</label>
                      <TemplateEditor
                        value={wizBody}
                        onChange={setWizBody}
                        placeholders={[
                          { label: 'Link Allegato', token: '%allegato1%' },
                          { label: 'Nominativo', token: '%nominativo%' },
                          { label: 'Codice Fiscale', token: '%codice_fiscale%' },
                          ...wizCsvHeaders
                            .filter(h => h !== wizMapping.codice_fiscale && h !== wizMapping.full_name && h !== wizMapping.email && h !== wizMapping.pec)
                            .map(h => ({ label: `Colonna: ${h}`, token: `%${h}%` })),
                        ]}
                      />
                    </div>

                    <div className="mt-4 pt-3 border-top d-flex justify-content-between">
                      <button className="btn btn-outline-secondary" onClick={() => setWizStep(3)}>
                        <i className="fas fa-arrow-left me-1"></i> Indietro
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => setWizStep(5)}
                        disabled={!wizSubject || isWizBodyEmpty(wizBody)}
                      >
                        Riepilogo <i className="fas fa-arrow-right ms-1"></i>
                      </button>
                    </div>
                  </div>

                  {/* Right Column: Live Preview with Paging */}
                  <div className="col-lg-6">
                    <h4 className="h6 fw-bold text-dark mb-2">Anteprima Live Destinatari ({wizValidRows.length} totali)</h4>
                    <p className="small text-muted mb-3">Sfoglia i record validi del CSV per vedere come verranno risolti i parametri Jolly.</p>
                    
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
                          <strong>Oggetto:</strong> {wizSubject.replace(/%([^%()]+)%/gi, (match, key) => {
                            const k = key.toLowerCase().trim();
                            if (k === 'nominativo' || k === 'full_name') return getWizRowFullName(wizValidRows[wizPreviewIndex]);
                            if (k === 'codice_fiscale' || k === 'cf') return wizValidRows[wizPreviewIndex][wizMapping.codice_fiscale] || '';
                            return wizValidRows[wizPreviewIndex][key] || match;
                          })}
                        </div>
                        <div className="bg-white border rounded overflow-hidden">
                          <div style={{ backgroundColor: '#0066cc', padding: '16px', color: 'white', fontWeight: 'bold' }}>
                            {settEntityName}
                          </div>
                          <div
                            style={{ padding: '20px', fontSize: '0.9rem', color: '#333', lineHeight: '1.5', minHeight: '150px' }}
                            dangerouslySetInnerHTML={{
                              __html: wizBody
                                .replace(/%allegato1%/g, 'http://localhost:3001/?notificationId=TEST-UUID-SIMULAZIONE')
                                .replace(/%parametro\d+\(mappato"([^"]+)"\)%/gi, (match, key) => escapeHtml(wizValidRows[wizPreviewIndex][key] || ''))
                                .replace(/%([^%()]+)%/gi, (match, key) => {
                                  const k = key.toLowerCase().trim();
                                  if (k === 'nominativo' || k === 'full_name') return escapeHtml(getWizRowFullName(wizValidRows[wizPreviewIndex]));
                                  if (k === 'codice_fiscale' || k === 'cf') return escapeHtml(wizValidRows[wizPreviewIndex][wizMapping.codice_fiscale] || '');
                                  return wizValidRows[wizPreviewIndex][key] ? escapeHtml(wizValidRows[wizPreviewIndex][key]) : match;
                                }),
                            }}
                          />
                          <div style={{ backgroundColor: '#f8f9fa', padding: '12px', fontSize: '0.72rem', color: '#666', textAlign: 'center', borderTop: '1px solid #edf2f7' }}>
                            Messaggio istituzionale inviato automaticamente per conto di {settEntityName}.
                          </div>
                        </div>
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
                        Seleziona o trascina qui i file PDF degli avvisi individuali (es. estratti dal desktop).
                        Il nome del file PDF deve corrispondere a quello indicato nella colonna mappata del CSV.
                      </p>
                      <input
                        type="file"
                        accept=".pdf"
                        multiple
                        className="form-control form-control-sm"
                        onChange={e => setWizPdfFiles(Array.from(e.target.files || []))}
                      />
                      <div className="form-text small text-muted">Puoi selezionare e caricare più file PDF contemporaneamente.</div>
                      {wizPdfFiles.length > 0 && (
                        <div className="badge bg-primary mt-2 p-2 w-100 text-start">
                          <i className="fas fa-file-pdf me-1"></i> {wizPdfFiles.length} allegati PDF pronti per il caricamento
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-top d-flex justify-content-between">
                    <button className="btn btn-outline-secondary" onClick={() => setWizStep(4)}>
                      <i className="fas fa-arrow-left me-1"></i> Indietro
                    </button>
                    <button
                      className="btn btn-success"
                      onClick={handleWizLaunch}
                      disabled={wizSending}
                    >
                      {wizSending ? (
                        <><i className="fas fa-spinner fa-spin me-1"></i>Spedizione in corso...</>
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
              <div className="row g-3 mb-4">
                <div className="col-md-6 col-lg-3">
                  <div className="card shadow-sm text-center p-3">
                    <span className="text-muted small">Notifiche Totali</span>
                    <h3 className="h2 mb-0 fw-bold text-primary">
                      {campaigns.reduce((acc, c) => acc + c.totalRecipients, 0)}
                    </h3>
                  </div>
                </div>
                <div className="col-md-6 col-lg-3">
                  <div className="card shadow-sm text-center p-3">
                    <span className="text-muted small">Invii Avvenuti (Successo)</span>
                    <h3 className="h2 mb-0 fw-bold text-success">
                      {campaigns.reduce((acc, c) => acc + c.sentCount, 0)}
                    </h3>
                  </div>
                </div>
                <div className="col-md-6 col-lg-3">
                  <div className="card shadow-sm text-center p-3">
                    <span className="text-muted small">Fallimenti totali</span>
                    <h3 className="h2 mb-0 fw-bold text-danger">
                      {campaigns.reduce((acc, c) => acc + c.failedCount, 0)}
                    </h3>
                  </div>
                </div>
                <div className="col-md-6 col-lg-3">
                  <div className="card shadow-sm text-center p-3">
                    <span className="text-muted small">Percentuale Successo</span>
                    <h3 className="h2 mb-0 fw-bold text-warning">
                      {(() => {
                        const tot = campaigns.reduce((acc, c) => acc + c.totalRecipients, 0);
                        const ok = campaigns.reduce((acc, c) => acc + c.sentCount, 0);
                        return tot > 0 ? `${((ok / tot) * 100).toFixed(1)}%` : '0%';
                      })()}
                    </h3>
                  </div>
                </div>
              </div>

              <div className="row g-3">
                <div className="col-md-8">
                  <div className="card shadow-sm">
                    <div className="card-header bg-white py-3 border-bottom">
                      <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-chart-line me-2 text-primary"></i>Andamento Invii Mensili</h3>
                    </div>
                    <div className="card-body text-center p-4">
                      <svg viewBox="0 0 500 200" style={{ width: '100%', height: '240px', background: '#f8fafc', borderRadius: '6px' }}>
                        <line x1="40" y1="30" x2="480" y2="30" stroke="#e2e8f0" strokeDasharray="3" />
                        <line x1="40" y1="80" x2="480" y2="80" stroke="#e2e8f0" strokeDasharray="3" />
                        <line x1="40" y1="130" x2="480" y2="130" stroke="#e2e8f0" strokeDasharray="3" />
                        <line x1="40" y1="170" x2="480" y2="170" stroke="#cbd5e1" strokeWidth="2" />
                        
                        <rect x="70" y="90" width="30" height="80" rx="3" fill="var(--bi-primary)" opacity="0.85" />
                        <rect x="150" y="60" width="30" height="110" rx="3" fill="var(--bi-primary)" opacity="0.85" />
                        <rect x="230" y="40" width="30" height="130" rx="3" fill="var(--bi-primary)" opacity="0.85" />
                        <rect x="310" y="80" width="30" height="90" rx="3" fill="var(--bi-primary)" opacity="0.85" />
                        <rect x="390" y="50" width="30" height="120" rx="3" fill="var(--bi-primary)" opacity="0.85" />
                        
                        <text x="85" y="185" textAnchor="middle" fontSize="10" fill="#64748b" fontFamily="sans-serif">Gen</text>
                        <text x="165" y="185" textAnchor="middle" fontSize="10" fill="#64748b" fontFamily="sans-serif">Feb</text>
                        <text x="245" y="185" textAnchor="middle" fontSize="10" fill="#64748b" fontFamily="sans-serif">Mar</text>
                        <text x="325" y="185" textAnchor="middle" fontSize="10" fill="#64748b" fontFamily="sans-serif">Apr</text>
                        <text x="405" y="185" textAnchor="middle" fontSize="10" fill="#64748b" fontFamily="sans-serif">Mag</text>

                        <text x="85" y="80" textAnchor="middle" fontSize="9" fill="#0f172a" fontWeight="bold" fontFamily="sans-serif">8k</text>
                        <text x="165" y="50" textAnchor="middle" fontSize="9" fill="#0f172a" fontWeight="bold" fontFamily="sans-serif">11k</text>
                        <text x="245" y="30" textAnchor="middle" fontSize="9" fill="#0f172a" fontWeight="bold" fontFamily="sans-serif">13k</text>
                        <text x="325" y="70" textAnchor="middle" fontSize="9" fill="#0f172a" fontWeight="bold" fontFamily="sans-serif">9k</text>
                        <text x="405" y="40" textAnchor="middle" fontSize="9" fill="#0f172a" fontWeight="bold" fontFamily="sans-serif">12k</text>
                      </svg>
                    </div>
                  </div>
                </div>

                <div className="col-md-4">
                  <div className="card shadow-sm">
                    <div className="card-header bg-white py-3 border-bottom">
                      <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-chart-pie me-2 text-primary"></i>Ripartizione per Canale</h3>
                    </div>
                    <div className="card-body text-center p-4">
                      <svg width="100%" height="240" viewBox="0 0 200 200">
                        <circle cx="100" cy="100" r="60" fill="transparent" stroke="#f1f5f9" strokeWidth="25" />
                        
                        <circle cx="100" cy="100" r="60" fill="transparent" stroke="var(--bi-primary)" strokeWidth="25"
                                strokeDasharray="170 207" strokeDashoffset="94" />
                                
                        <circle cx="100" cy="100" r="60" fill="transparent" stroke="var(--ms-purple-600)" strokeWidth="25"
                                strokeDasharray="113 264" strokeDashoffset="-76" />
                                
                        <circle cx="100" cy="100" r="60" fill="transparent" stroke="var(--ms-gold-500)" strokeWidth="25"
                                strokeDasharray="56 321" strokeDashoffset="-189" />

                        <circle cx="100" cy="100" r="60" fill="transparent" stroke="var(--ms-green-600)" strokeWidth="25"
                                strokeDasharray="38 339" strokeDashoffset="-245" />

                        <text x="100" y="98" textAnchor="middle" fontSize="12" fontWeight="bold" fill="#0f172a" fontFamily="sans-serif">CANALI</text>
                        <text x="100" y="115" textAnchor="middle" fontSize="9" fill="#64748b" fontFamily="sans-serif">Hub Invio</text>
                      </svg>
                      
                      <div className="d-flex flex-wrap justify-content-center gap-3 mt-2" style={{ fontSize: '0.8rem' }}>
                        <div><i className="fas fa-circle text-primary"></i> EMAIL (45%)</div>
                        <div><i className="fas fa-circle text-purple" style={{ color: 'var(--ms-purple-600)' }}></i> PEC (30%)</div>
                        <div><i className="fas fa-circle text-warning"></i> APP IO (15%)</div>
                        <div><i className="fas fa-circle text-success"></i> SEND (10%)</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
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
                        <tr key={r.recipientId}>
                          <td className="font-monospace small">{r.codiceFiscale}</td>
                          <td className="small">{r.fullName || '—'}</td>
                          <td className="small">{r.campaignName}</td>
                          <td className="small">{r.channelType}</td>
                          <td><span className="badge bg-light text-dark border">{r.status}</span></td>
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
                          <td><span className="badge bg-light text-dark border">{t.type}</span></td>
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
                        placeholders={[
                          { label: 'Nominativo', token: '%nominativo%' },
                          { label: 'Codice Fiscale', token: '%codice_fiscale%' },
                        ]}
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
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'send' ? 'active' : ''}`}
                      onClick={() => setActiveSettingsTab('send')}
                    >
                      <i className="fas fa-paper-plane me-2"></i>SEND (Digitale)
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
                        {activeSettingsTab === 'send' && 'Integrazione SEND (Digital Delivery)'}
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

                        {/* TAB: APP IO (Multiple services creation & management) */}
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

                        {/* TAB: SEND */}
                        {activeSettingsTab === 'send' && (
                          <div>
                            <div className="mb-3">
                              <label className="form-label small fw-bold text-dark" htmlFor="send_api">Chiave API Privata SEND</label>
                              <input
                                type="text"
                                id="send_api"
                                className="form-control form-control-sm"
                                value={settSendApiKey}
                                onChange={(e) => setSettSendApiKey(e.target.value)}
                                required
                              />
                            </div>
                            <div className="mb-3">
                              <label className="form-label small fw-semibold text-muted" htmlFor="send_url">Endpoint API SEND Notifiche Digitali</label>
                              <input
                                type="text"
                                id="send_url"
                                className="form-control form-control-sm"
                                value={settSendUrl}
                                onChange={(e) => setSettSendUrl(e.target.value)}
                                required
                              />
                            </div>
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
                                <option value="Maggioli">Maggioli (ApriPA)</option>
                                <option value="Saga">Saga (Siger)</option>
                                <option value="Halley">Halley Protocollo</option>
                                <option value="Custom">Strategia Custom (Plugin)</option>
                              </select>
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-bold text-dark" htmlFor="proto_url">Endpoint Webservice</label>
                              <input
                                type="text"
                                id="proto_url"
                                className="form-control form-control-sm"
                                value={settProtoUrl}
                                onChange={(e) => setSettProtoUrl(e.target.value)}
                                required
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_user">User ID</label>
                              <input
                                type="text"
                                id="proto_user"
                                className="form-control form-control-sm"
                                value={settProtoUser}
                                onChange={(e) => setSettProtoUser(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="proto_pass">Chiave/Password</label>
                              <input
                                type="password"
                                id="proto_pass"
                                className="form-control form-control-sm"
                                value={settProtoPass}
                                onChange={(e) => setSettProtoPass(e.target.value)}
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
                                required
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
                                required
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
                                };
                                const channelIcon: Record<string, string> = {
                                  EMAIL: 'fa-envelope',
                                  PEC: 'fa-envelope-open-text',
                                  APP_IO: 'fa-mobile-alt',
                                  SEND: 'fa-paper-plane',
                                  POSTAL: 'fa-mail-bulk',
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
                                              <thead><tr><th>Job</th><th>Campagna</th><th>Destinatario</th><th>Tentativi</th><th>Motivo</th></tr></thead>
                                              <tbody>
                                                {engineJobs.map(j => (
                                                  <tr key={j.jobId}>
                                                    <td className="font-monospace small">{j.jobId}</td>
                                                    <td className="font-monospace small">{j.campaignId}</td>
                                                    <td className="font-monospace small">{j.recipientId}</td>
                                                    <td>{j.attemptsMade}</td>
                                                    <td className="small text-danger">{j.failedReason || '—'}</td>
                                                  </tr>
                                                ))}
                                                {engineJobs.length === 0 && <tr><td colSpan={5} className="text-center text-muted">Nessun job fallito</td></tr>}
                                              </tbody>
                                            </table>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
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
                            <span className="badge bg-light text-dark border">
                              <i className="fas fa-paper-plane me-1"></i> {campaign.channelType}
                              {campaign.channelConfig?.['serviceName'] && ` (${campaign.channelConfig['serviceName']})`}
                            </span>
                          </div>
                        </div>
                        <div className="mb-3">
                          <label className="text-muted small fw-semibold block">Stato</label>
                          <div>
                            <span className={`badge ${
                              campaign.status === 'draft' ? 'bg-secondary' :
                              campaign.status === 'queued' ? 'bg-info text-dark' :
                              campaign.status === 'running' ? 'bg-warning text-dark' :
                              campaign.status === 'completed' ? 'bg-success' : 'bg-danger'
                            }`}>
                              {campaign.status.toUpperCase()}
                            </span>
                          </div>
                        </div>
                        <div className="mb-3">
                          <label className="text-muted small fw-semibold block">Testo Messaggio</label>
                          <div className="p-2 bg-light border rounded small" style={{ whiteSpace: 'pre-wrap' }}>
                            {campaign.description}
                          </div>
                        </div>

                        {(campaign.status === 'running' || campaign.status === 'completed' || campaign.status === 'queued') && (
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

                        {campaignFailures.length > 0 && (
                          <div className="mt-4 border-top pt-3">
                            <h4 className="small fw-bold mb-2 text-danger">
                              <i className="fas fa-triangle-exclamation me-1"></i>
                              Destinatari con invio fallito ({campaignFailures.length})
                            </h4>
                            <div className="table-responsive" style={{ maxHeight: 300, overflowY: 'auto' }}>
                              <table className="table table-sm">
                                <thead><tr><th>CF</th><th>Nome</th><th>Tentativi</th><th>Motivo</th><th></th></tr></thead>
                                <tbody>
                                  {campaignFailures.map(f => (
                                    <tr key={f.recipientId}>
                                      <td className="font-monospace small">{f.codiceFiscale}</td>
                                      <td className="small">{f.fullName || '—'}</td>
                                      <td className="small">{f.attemptNumber}</td>
                                      <td className="small text-danger">{f.errorMessage || '—'}</td>
                                      <td>
                                        <button
                                          className="btn btn-sm btn-outline-primary"
                                          disabled={retryBusyId === f.recipientId}
                                          onClick={() => handleRetryRecipient(campaign.id, f.recipientId)}
                                        >
                                          <i className="fas fa-rotate-right me-1"></i>Rimetti in coda
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
                          {campaign.totalRecipients === 0 && campaign.status === 'draft' && (
                            <div className="alert alert-warning small p-2 mt-2 mb-0">
                              <i className="fas fa-info-circle"></i> Carica un file CSV di destinatari per poter lanciare la campagna.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="col-lg-8">
                    {campaign.status === 'draft' && (
                      <div className="card shadow-sm mb-4">
                        <div className="card-header bg-white py-3 border-bottom">
                          <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-file-csv me-2"></i>Importatore & Mappatore Visuale CSV</h3>
                        </div>
                        <div className="card-body">
                          {uploadSuccess && (
                            <div className="alert alert-success"><i className="fas fa-check-circle me-1"></i> Destinatari caricati con successo nel database!</div>
                          )}
                          {csvError && (
                            <div className="alert alert-danger"><i className="fas fa-exclamation-triangle"></i> {csvError}</div>
                          )}

                          <div className="mb-3">
                            <label className="form-label small fw-semibold text-muted">Seleziona File CSV</label>
                            <input
                              type="file"
                              accept=".csv"
                              className="form-control"
                              onChange={handleCsvChange}
                            />
                          </div>

                          {csvHeaders.length > 0 && (
                            <div className="mt-4 border-top pt-3">
                              <h4 className="h6 fw-bold text-dark mb-3"><i className="fas fa-route text-primary me-2"></i>Associazione Colonne (Mapping)</h4>
                              
                              <div className="row g-3 mb-4">
                                <div className="col-md-6">
                                  <label className="form-label small fw-bold text-dark">1. Codice Fiscale <span className="text-danger">*</span></label>
                                  <select
                                    className="form-select form-select-sm border-primary"
                                    value={mapping.codice_fiscale}
                                    onChange={(e) => handleMappingChange('codice_fiscale', e.target.value)}
                                    required
                                  >
                                    <option value="">-- Seleziona Colonna CF --</option>
                                    {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                                  </select>
                                </div>
                                <div className="col-md-6">
                                  <label className="form-label small fw-semibold text-muted">2. Nome Completo (Opzionale)</label>
                                  <select
                                    className="form-select form-select-sm"
                                    value={mapping.full_name}
                                    onChange={(e) => handleMappingChange('full_name', e.target.value)}
                                  >
                                    <option value="">-- Nessuna Associazione --</option>
                                    {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                                  </select>
                                </div>
                                <div className="col-md-6">
                                  <label className="form-label small fw-semibold text-muted">3. Indirizzo Email (Opzionale)</label>
                                  <select
                                    className="form-select form-select-sm"
                                    value={mapping.email}
                                    onChange={(e) => handleMappingChange('email', e.target.value)}
                                  >
                                    <option value="">-- Nessuna Associazione --</option>
                                    {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                                  </select>
                                </div>
                                <div className="col-md-6">
                                  <label className="form-label small fw-semibold text-muted">4. Indirizzo PEC (Opzionale)</label>
                                  <select
                                    className="form-select form-select-sm"
                                    value={mapping.pec}
                                    onChange={(e) => handleMappingChange('pec', e.target.value)}
                                  >
                                    <option value="">-- Nessuna Associazione --</option>
                                    {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                                  </select>
                                </div>
                              </div>

                              {csvRows.length > 0 && (
                                <div className="p-3 bg-light rounded border mb-4">
                                  <h5 className="small fw-bold mb-2">Anteprima Mappatura (Riga 1)</h5>
                                  <div className="row g-2 text-muted" style={{ fontSize: '0.82rem' }}>
                                    <div className="col-6"><strong>Codice Fiscale:</strong> {csvRows[0][csvHeaders.indexOf(mapping.codice_fiscale)] || <span className="text-danger">Mancante</span>}</div>
                                    <div className="col-6"><strong>Nome Completo:</strong> {csvRows[0][csvHeaders.indexOf(mapping.full_name)] || 'N/A'}</div>
                                    <div className="col-6"><strong>Email:</strong> {csvRows[0][csvHeaders.indexOf(mapping.email)] || 'N/A'}</div>
                                    <div className="col-6"><strong>PEC:</strong> {csvRows[0][csvHeaders.indexOf(mapping.pec)] || 'N/A'}</div>
                                  </div>
                                </div>
                              )}

                              <button
                                type="button"
                                className="btn btn-primary w-100"
                                onClick={handleUploadMappedCsv}
                                disabled={uploadingCsv || !mapping.codice_fiscale}
                                style={{ backgroundColor: 'var(--bi-primary)', border: 'none' }}
                              >
                                {uploadingCsv ? (
                                  <><i className="fas fa-spinner fa-spin me-2"></i>Normalizzazione ed Invio in corso...</>
                                ) : (
                                  <><i className="fas fa-file-import me-2"></i>Normalizza, Mappa e Carica Destinatari</>
                                )}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="card shadow-sm">
                      <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">
                        <h3 className="h6 mb-0 fw-bold text-dark">
                          <i className="fas fa-users me-2"></i>Destinatari Caricati ({campaign.totalRecipients})
                        </h3>
                        <div className="d-flex align-items-center">
                          {campaign.recipients && campaign.recipients.length > 0 && (
                            <button className="btn btn-sm btn-outline-primary me-2 py-1" onClick={handleExportDownloadReport} title="Esporta Report CSV">
                              <i className="fas fa-file-excel me-1"></i> Esporta Report Download
                            </button>
                          )}
                          <button className="btn btn-outline-secondary btn-sm border-0" onClick={() => fetchCampaignDetail(campaign.id)} title="Aggiorna esiti">
                            <i className="fas fa-sync-alt"></i>
                          </button>
                        </div>
                      </div>
                      <div className="card-body p-0">
                        {!campaign.recipients || campaign.recipients.length === 0 ? (
                          <div className="text-center py-5 text-muted">Nessun destinatario associato a questa campagna.</div>
                        ) : (
                          <div className="table-responsive" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                            <table className="table table-striped table-hover align-middle mb-0" style={{ fontSize: '0.82rem' }}>
                              <thead className="table-light sticky-top">
                                <tr>
                                  <th>Codice Fiscale</th>
                                  <th>Nominativo</th>
                                  <th>Contatti (Email/PEC)</th>
                                  <th>Stato Notifica</th>
                                  <th className="text-center">Download</th>
                                </tr>
                              </thead>
                              <tbody>
                                {campaign.recipients.map((r) => (
                                  <tr key={r.id}>
                                    <td className="fw-mono fw-bold">{r.codiceFiscale}</td>
                                    <td>{r.fullName || <span className="text-muted">N/D</span>}</td>
                                    <td>
                                      <div className="small">
                                        {r.email && <div><i className="far fa-envelope me-1"></i> {r.email}</div>}
                                        {r.pec && <div className="text-primary"><i className="fas fa-envelope-open-text me-1"></i> {r.pec}</div>}
                                      </div>
                                    </td>
                                    <td>
                                      <span className={`badge ${
                                        r.status === 'pending' ? 'bg-secondary' :
                                        r.status === 'queued' ? 'bg-info text-dark' :
                                        r.status === 'sent' ? 'bg-success' :
                                        r.status === 'failed' ? 'bg-danger' : 'bg-warning text-dark'
                                      }`}>
                                        {r.status.toUpperCase()}
                                      </span>
                                    </td>
                                    <td className="text-center fw-bold">
                                      {r.extraData?.['download_count'] ? (
                                        <span className="text-success" title={`Scaricato il ${new Date(r.extraData['downloaded_at']).toLocaleDateString('it-IT')}`}>
                                          <i className="fas fa-arrow-down me-1"></i> {r.extraData['download_count']}
                                        </span>
                                      ) : (
                                        <span className="text-muted">—</span>
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
              ) : null}
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
