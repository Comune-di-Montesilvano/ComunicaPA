import React, { useState, useEffect } from 'react';

const API_BASE = 'http://localhost:8080';

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
  id_service: string;
  descrizione: string;
  api_key_primaria: string;
  api_key_secondaria: string;
  codice_catalogo: string;
  is_default: boolean;
}

const DEFAULT_IO_SERVICES: IoService[] = [
  {
    id: '1',
    nome: 'Servizio TARI',
    id_service: '01ARZ3NDEKTSN4FFFSUQFW0C5',
    descrizione: 'Notifiche e scadenze relative alla tassa sui rifiuti (TARI)',
    api_key_primaria: 'io_api_tari_primary_112233',
    api_key_secondaria: 'io_api_tari_secondary_445566',
    codice_catalogo: '081223901',
    is_default: true,
  },
  {
    id: '2',
    nome: 'Multe e Violazioni CDS',
    id_service: '02BRX9NDEKTSN4FFFSUQFW0D8',
    descrizione: 'Notifica verbali CdS e sanzioni amministrative del Comune',
    api_key_primaria: 'io_api_cds_primary_998877',
    api_key_secondaria: '',
    codice_catalogo: '081223902',
    is_default: false,
  },
];

export function App(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(localStorage.getItem('comunicapa_token'));
  const [username, setUsername] = useState<string | null>(localStorage.getItem('comunicapa_username'));
  const [role, setRole] = useState<string | null>(localStorage.getItem('comunicapa_role'));
  const [view, setView] = useState<'dashboard' | 'invio-singolo' | 'invio-massivo' | 'statistiche' | 'impostazioni' | 'campaign-detail'>('dashboard');
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);

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

  // Settings State (loaded from localStorage or defaults)
  const [settEntityName, setSettEntityName] = useState(localStorage.getItem('sett_entity_name') || 'Comune di Montesilvano');
  const [settSubtitle, setSettSubtitle] = useState(localStorage.getItem('sett_subtitle') || 'ComunicaPA Hub');
  
  const [settSmtpHost, setSettSmtpHost] = useState(localStorage.getItem('sett_smtp_host') || 'smtp.comune.montesilvano.pe.it');
  const [settSmtpPort, setSettSmtpPort] = useState(localStorage.getItem('sett_smtp_port') || '587');
  const [settSmtpUser, setSettSmtpUser] = useState(localStorage.getItem('sett_smtp_user') || 'noreply@comune.montesilvano.pe.it');
  const [settSmtpPass, setSettSmtpPass] = useState(localStorage.getItem('sett_smtp_pass') || '••••••••');
  const [settSmtpFrom, setSettSmtpFrom] = useState(localStorage.getItem('sett_smtp_from') || 'noreply@comune.montesilvano.pe.it');

  const [settPecHost, setSettPecHost] = useState(localStorage.getItem('sett_pec_host') || 'smtps.pec.comune.montesilvano.pe.it');
  const [settPecPort, setSettPecPort] = useState(localStorage.getItem('sett_pec_port') || '465');
  const [settPecUser, setSettPecUser] = useState(localStorage.getItem('sett_pec_user') || 'protocollo@pec.comune.montesilvano.pe.it');
  const [settPecPass, setSettPecPass] = useState(localStorage.getItem('sett_pec_pass') || '••••••••');
  const [settPecFrom, setSettPecFrom] = useState(localStorage.getItem('sett_pec_from') || 'protocollo@pec.comune.montesilvano.pe.it');

  // Email / PEC test
  const [smtpTestTo, setSmtpTestTo] = useState('');
  const [smtpTestStatus, setSmtpTestStatus] = useState<'idle'|'loading'|'ok'|'error'>('idle');
  const [smtpTestMsg, setSmtpTestMsg] = useState('');
  const [pecTestTo, setPecTestTo] = useState('');
  const [pecTestStatus, setPecTestStatus] = useState<'idle'|'loading'|'ok'|'error'>('idle');
  const [pecTestMsg, setPecTestMsg] = useState('');

  // App IO Settings
  const [settIoUrl, setSettIoUrl] = useState(localStorage.getItem('sett_io_url') || 'https://api.io.italia.it');
  const [ioServices, setIoServices] = useState<IoService[]>(() => {
    const saved = localStorage.getItem('sett_io_services');
    return saved ? JSON.parse(saved) : DEFAULT_IO_SERVICES;
  });

  // App IO New Service form
  const [newSvcNome, setNewSvcNome] = useState('');
  const [newSvcIdService, setNewSvcIdService] = useState('');
  const [newSvcDesc, setNewSvcDesc] = useState('');
  const [newSvcApiKeyPrimaria, setNewSvcApiKeyPrimaria] = useState('');
  const [newSvcApiKeySecondaria, setNewSvcApiKeySecondaria] = useState('');
  const [newSvcCodiceCatalogo, setNewSvcCodiceCatalogo] = useState('');
  const [newSvcIsDefault, setNewSvcIsDefault] = useState(false);
  const [showNewSvcForm, setShowNewSvcForm] = useState(false);

  const [settSendApiKey, setSettSendApiKey] = useState(localStorage.getItem('sett_send_api_key') || 'send_sec_key_montesilvano_dev_456');
  const [settSendUrl, setSettSendUrl] = useState(localStorage.getItem('sett_send_url') || 'https://api.notifichedigitali.it');

  const [settProtoProvider, setSettProtoProvider] = useState(localStorage.getItem('sett_proto_provider') || 'Maggioli');
  const [settProtoUrl, setSettProtoUrl] = useState(localStorage.getItem('sett_proto_url') || 'https://protocollo.comune.montesilvano.pe.it/api');
  const [settProtoUser, setSettProtoUser] = useState(localStorage.getItem('sett_proto_user') || 'api_user');
  const [settProtoPass, setSettProtoPass] = useState(localStorage.getItem('sett_proto_pass') || '••••••••');

  const [settPostalProvider, setSettPostalProvider] = useState(localStorage.getItem('sett_postal_provider') || 'Postel');
  const [settPostalKey, setSettPostalKey] = useState(localStorage.getItem('sett_postal_key') || 'postel_auth_token_789');
  const [settPostalUrl, setSettPostalUrl] = useState(localStorage.getItem('sett_postal_url') || 'https://gateway.postel.it/postalization');

  const [activeSettingsTab, setActiveSettingsTab] = useState<'personalizzazione' | 'smtp' | 'pec' | 'app-io' | 'send' | 'protocollo' | 'postalizzazione'>('personalizzazione');
  const [settingsSavedMessage, setSettingsSavedMessage] = useState<string | null>(null);

  // Campaign detail state
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loadingCampaignDetail, setLoadingCampaignDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

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
    const def = ioServices.find(s => s.is_default);
    if (def) {
      setSelectedAppIoServiceId(def.id_service);
      setSingleAppIoServiceId(def.id_service);
    } else if (ioServices.length > 0) {
      setSelectedAppIoServiceId(ioServices[0].id_service);
      setSingleAppIoServiceId(ioServices[0].id_service);
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
    }
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

  const fetchCampaigns = async () => {
    setLoadingCampaigns(true);
    setDashboardError(null);
    try {
      const res = await fetch(`${API_BASE}/campaigns`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
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
      const res = await fetch(`${API_BASE}/campaigns/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Impossibile caricare il dettaglio della campagna.');
      const data = await res.json();
      setCampaign(data);
    } catch (err: any) {
      setDetailError(err.message);
    } finally {
      setLoadingCampaignDetail(false);
    }
  };

  const handleCreateCampaign = async (nameVal: string, descVal: string, channelVal: string, configOverrides?: Record<string, any>) => {
    try {
      let channelConfig: Record<string, any> = configOverrides || {};
      
      if (!configOverrides) {
        if (channelVal === 'EMAIL') {
          channelConfig = { from: settSmtpFrom, smtpServer: settSmtpHost };
        } else if (channelVal === 'PEC') {
          channelConfig = { from: settPecFrom, pecServer: settPecHost };
        } else if (channelVal === 'APP_IO') {
          // Find API key associated with the selected service
          const svc = ioServices.find(s => s.id_service === selectedAppIoServiceId);
          channelConfig = {
            serviceId: selectedAppIoServiceId,
            apiKey: svc ? svc.api_key_primaria : '',
            baseUrl: settIoUrl,
          };
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
        const svc = ioServices.find(s => s.id_service === selectedAppIoServiceId);
        customConfig = {
          serviceId: selectedAppIoServiceId,
          serviceName: svc ? svc.nome : '',
          apiKey: svc ? svc.api_key_primaria : '',
          baseUrl: settIoUrl,
        };
      }

      await handleCreateCampaign(newCampaignName, newCampaignDesc, newCampaignChannel, customConfig);
      setNewCampaignName('');
      setNewCampaignDesc('');
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
        const svc = ioServices.find(s => s.id_service === singleAppIoServiceId);
        customConfig = {
          serviceId: singleAppIoServiceId,
          serviceName: svc ? svc.nome : '',
          apiKey: svc ? svc.api_key_primaria : '',
          baseUrl: settIoUrl,
        };
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

  // App IO Service Management handlers
  const handleAddIoService = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSvcNome || !newSvcIdService || !newSvcApiKeyPrimaria) {
      alert('I campi contrassegnati con asterisco sono obbligatori.');
      return;
    }

    const newSvc: IoService = {
      id: Date.now().toString(),
      nome: newSvcNome,
      id_service: newSvcIdService.toUpperCase().trim(),
      descrizione: newSvcDesc,
      api_key_primaria: newSvcApiKeyPrimaria,
      api_key_secondaria: newSvcApiKeySecondaria,
      codice_catalogo: newSvcCodiceCatalogo,
      is_default: newSvcIsDefault || ioServices.length === 0,
    };

    let updatedList = [...ioServices];
    if (newSvc.is_default) {
      updatedList = updatedList.map(s => ({ ...s, is_default: false }));
    }
    updatedList.push(newSvc);
    
    setIoServices(updatedList);
    localStorage.setItem('sett_io_services', JSON.stringify(updatedList));

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

  const handleSetDefaultIoService = (id: string) => {
    const updatedList = ioServices.map(s => ({
      ...s,
      is_default: s.id === id,
    }));
    setIoServices(updatedList);
    localStorage.setItem('sett_io_services', JSON.stringify(updatedList));
  };

  const handleDeleteIoService = (id: string) => {
    const svcToDelete = ioServices.find(s => s.id === id);
    if (!svcToDelete) return;
    if (svcToDelete.is_default && ioServices.length > 1) {
      alert('Non puoi eliminare il servizio predefinito. Imposta prima un altro servizio come predefinito.');
      return;
    }
    if (!confirm(`Sei sicuro di voler eliminare il servizio "${svcToDelete.nome}"?`)) {
      return;
    }
    const updatedList = ioServices.filter(s => s.id !== id);
    setIoServices(updatedList);
    localStorage.setItem('sett_io_services', JSON.stringify(updatedList));
  };

  // Settings Save handler
  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('sett_entity_name', settEntityName);
    localStorage.setItem('sett_subtitle', settSubtitle);
    localStorage.setItem('sett_smtp_host', settSmtpHost);
    localStorage.setItem('sett_smtp_port', settSmtpPort);
    localStorage.setItem('sett_smtp_user', settSmtpUser);
    localStorage.setItem('sett_smtp_pass', settSmtpPass);
    localStorage.setItem('sett_smtp_from', settSmtpFrom);
    localStorage.setItem('sett_pec_host', settPecHost);
    localStorage.setItem('sett_pec_port', settPecPort);
    localStorage.setItem('sett_pec_user', settPecUser);
    localStorage.setItem('sett_pec_pass', settPecPass);
    localStorage.setItem('sett_pec_from', settPecFrom);
    localStorage.setItem('sett_io_url', settIoUrl);
    localStorage.setItem('sett_io_services', JSON.stringify(ioServices));
    localStorage.setItem('sett_send_api_key', settSendApiKey);
    localStorage.setItem('sett_send_url', settSendUrl);
    localStorage.setItem('sett_proto_provider', settProtoProvider);
    localStorage.setItem('sett_proto_url', settProtoUrl);
    localStorage.setItem('sett_proto_user', settProtoUser);
    localStorage.setItem('sett_proto_pass', settProtoPass);
    localStorage.setItem('sett_postal_provider', settPostalProvider);
    localStorage.setItem('sett_postal_key', settPostalKey);
    localStorage.setItem('sett_postal_url', settPostalUrl);

    setSettingsSavedMessage('Impostazioni salvate con successo!');
    setTimeout(() => setSettingsSavedMessage(null), 3000);
  };

  const handleTestSmtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSmtpTestStatus('loading');
    setSmtpTestMsg('');
    try {
      const res = await fetch(`${API_BASE}/settings/test-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          host: settSmtpHost,
          port: Number(settSmtpPort),
          user: settSmtpUser,
          pass: settSmtpPass,
          from: settSmtpFrom,
          to: smtpTestTo,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setSmtpTestStatus('ok');
        setSmtpTestMsg('Email di test inviata con successo.');
      } else {
        setSmtpTestStatus('error');
        setSmtpTestMsg(data.message || "Errore durante l'invio.");
      }
    } catch {
      setSmtpTestStatus('error');
      setSmtpTestMsg('Errore di rete.');
    }
  };

  const handleTestPec = async (e: React.FormEvent) => {
    e.preventDefault();
    setPecTestStatus('loading');
    setPecTestMsg('');
    try {
      const res = await fetch(`${API_BASE}/settings/test-pec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          host: settPecHost,
          port: Number(settPecPort),
          user: settPecUser,
          pass: settPecPass,
          from: settPecFrom,
          to: pecTestTo,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setPecTestStatus('ok');
        setPecTestMsg('PEC di test inviata con successo.');
      } else {
        setPecTestStatus('error');
        setPecTestMsg(data.message || "Errore durante l'invio.");
      }
    } catch {
      setPecTestStatus('error');
      setPecTestMsg('Errore di rete.');
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
    fetchCampaignDetail(id);
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
      <div className="container d-flex align-items-center justify-content-center" style={{ minHeight: '100vh' }}>
        <div className="card shadow" style={{ width: '100%', maxWidth: '420px', borderRadius: '10px', overflow: 'hidden' }}>
          <div className="card-header text-center py-4" style={{ background: 'var(--ms-purple-600)', color: '#fff', borderBottom: 'none' }}>
            <div className="mb-2" style={{ fontSize: '2rem' }}>
              <i className="fas fa-building text-warning"></i>
            </div>
            <h1 className="h4 mb-1 text-white fw-bold">ComunicaPA</h1>
            <p className="small mb-0 text-white-50">Amministrazione & Gestione Invii</p>
          </div>
          <div className="card-body p-4" style={{ backgroundColor: '#fff' }}>
            <form onSubmit={handleLogin}>
              {loginError && (
                <div className="alert alert-danger p-2" role="alert" style={{ fontSize: '0.86rem' }}>
                  <i className="fas fa-exclamation-triangle me-1"></i> {loginError}
                </div>
              )}
              <div className="mb-3">
                <label className="form-label small fw-semibold text-muted" htmlFor="username">Utente (sAMAccountName)</label>
                <div className="input-group">
                  <span className="input-group-text bg-light border-end-0 text-muted"><i className="fas fa-user"></i></span>
                  <input
                    type="text"
                    id="username"
                    className="form-control bg-light border-start-0"
                    placeholder="Es: admin, operator"
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="mb-4">
                <label className="form-label small fw-semibold text-muted" htmlFor="password">Password AD/LDAP</label>
                <div className="input-group">
                  <span className="input-group-text bg-light border-end-0 text-muted"><i className="fas fa-lock"></i></span>
                  <input
                    type="password"
                    id="password"
                    className="form-control bg-light border-start-0"
                    placeholder="••••••••"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                  />
                </div>
              </div>
              <button
                type="submit"
                className="btn btn-primary w-100 py-2 fw-semibold"
                style={{ backgroundColor: 'var(--bi-primary)', border: 'none' }}
                disabled={loginLoading}
              >
                {loginLoading ? (
                  <>
                    <i className="fas fa-spinner fa-spin me-2"></i>Accesso in corso...
                  </>
                ) : (
                  'Accedi con Active Directory'
                )}
              </button>
            </form>
          </div>
          <div className="card-footer bg-light text-center py-3 border-top-0">
            <span className="small text-muted">Sviluppo locale: usa <code>admin/admin</code> o <code>operator/operator</code></span>
          </div>
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
            <i className="fas fa-building bo-brand-logo-fallback text-warning"></i>
          </span>
          <span className="bo-sidebar-brand-copy">
            <span className="bo-sidebar-brand-title">{settEntityName}</span>
            <span className="bo-sidebar-brand-subtitle">{settSubtitle}</span>
          </span>
        </div>

        <nav className="bo-nav">
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
            className={`bo-nav-item ${view === 'invio-massivo' || view === 'campaign-detail' ? 'is-active' : ''}`}
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
        </div>
      </aside>

      {/* Topbar */}
      <header className="bo-topbar">
        <h2 className="h5 mb-0 text-dark fw-bold" style={{ display: 'inline-block' }}>
          {view === 'dashboard' && 'Dashboard'}
          {view === 'invio-singolo' && 'Nuova Notifica Singola'}
          {view === 'invio-massivo' && 'Campagne di Invio Massivo'}
          {view === 'statistiche' && 'Statistiche e Andamento'}
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
                            <option key={s.id} value={s.id_service}>
                              {s.nome} {s.is_default ? '(Predefinito)' : ''}
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
              <div className="col-lg-8">
                <div className="card shadow-sm h-100">
                  <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">
                    <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-list me-2 text-primary"></i>Campagne Massive</h3>
                    <button className="btn btn-outline-secondary btn-sm border-0" onClick={fetchCampaigns}><i className="fas fa-sync-alt"></i></button>
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
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Creator Form */}
              <div className="col-lg-4">
                <div className="card shadow-sm h-100">
                  <div className="card-header bg-white py-3 border-bottom">
                    <h3 className="h6 mb-0 fw-bold text-dark"><i className="fas fa-plus-circle me-2 text-primary"></i>Nuova Campagna Massiva</h3>
                  </div>
                  <div className="card-body">
                    <form onSubmit={handleNewCampaignSubmit}>
                      <div className="mb-3">
                        <label className="form-label small fw-bold text-dark" htmlFor="cm_name">Nome della Campagna</label>
                        <input
                          type="text"
                          id="cm_name"
                          className="form-control form-control-sm"
                          placeholder="Es: TARI 2026 Montesilvano"
                          value={newCampaignName}
                          onChange={(e) => setNewCampaignName(e.target.value)}
                          required
                        />
                      </div>
                      <div className="mb-3">
                        <label className="form-label small fw-bold text-dark" htmlFor="cm_desc">Contenuto dell'Avviso</label>
                        <textarea
                          id="cm_desc"
                          className="form-control form-control-sm"
                          rows={4}
                          placeholder="Digita il testo istituzionale del messaggio..."
                          value={newCampaignDesc}
                          onChange={(e) => setNewCampaignDesc(e.target.value)}
                          required
                        ></textarea>
                      </div>
                      <div className="mb-3">
                        <label className="form-label small fw-bold text-dark" htmlFor="cm_channel">Canale di Invio</label>
                        <select
                          id="cm_channel"
                          className="form-select form-select-sm"
                          value={newCampaignChannel}
                          onChange={(e: any) => setNewCampaignChannel(e.target.value)}
                        >
                          <option value="EMAIL">EMAIL</option>
                          <option value="PEC">PEC</option>
                          <option value="APP_IO">APP IO (PagoPA)</option>
                          <option value="SEND">SEND</option>
                          <option value="POSTAL">POSTAL</option>
                        </select>
                      </div>

                      {newCampaignChannel === 'APP_IO' && (
                        <div className="mb-4">
                          <label className="form-label small fw-bold text-dark" htmlFor="cm_io_svc">Servizio App IO Associato</label>
                          <select
                            id="cm_io_svc"
                            className="form-select form-select-sm"
                            value={selectedAppIoServiceId}
                            onChange={(e) => setSelectedAppIoServiceId(e.target.value)}
                            required
                          >
                            {ioServices.map(s => (
                              <option key={s.id} value={s.id_service}>
                                {s.nome} {s.is_default ? '(Predefinito)' : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      <button
                        type="submit"
                        className="btn btn-primary w-100 py-2 fw-bold"
                        style={{ backgroundColor: 'var(--bi-primary)', border: 'none' }}
                      >
                        <i className="fas fa-plus me-2"></i> Crea Campagna
                      </button>
                    </form>
                  </div>
                </div>
              </div>
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

          {/* VIEW: IMPOSTAZIONI */}
          {view === 'impostazioni' && (
            <div>
              {settingsSavedMessage && (
                <div className="alert alert-success d-flex align-items-center gap-2 mb-3" style={{ position: 'fixed', top: '70px', right: '20px', zIndex: 2000, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                  <i className="fas fa-check-circle"></i>
                  <strong>{settingsSavedMessage}</strong>
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
                      onClick={() => setActiveSettingsTab('smtp')}
                    >
                      <i className="fas fa-envelope me-2"></i>Mail Server (SMTP)
                    </button>
                    <button
                      type="button"
                      className={`nav-link border-0 text-start bg-transparent ${activeSettingsTab === 'pec' ? 'active' : ''}`}
                      onClick={() => setActiveSettingsTab('pec')}
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
                          </div>
                        )}

                        {/* TAB: SMTP */}
                        {activeSettingsTab === 'smtp' && (
                          <div className="row g-3">
                            <div className="col-md-8">
                              <label className="form-label small fw-bold text-dark" htmlFor="smtp_host">SMTP Server Host</label>
                              <input
                                type="text"
                                id="smtp_host"
                                className="form-control form-control-sm"
                                value={settSmtpHost}
                                onChange={(e) => setSettSmtpHost(e.target.value)}
                                required
                              />
                            </div>
                            <div className="col-md-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="smtp_port">Porta</label>
                              <input
                                type="text"
                                id="smtp_port"
                                className="form-control form-control-sm"
                                value={settSmtpPort}
                                onChange={(e) => setSettSmtpPort(e.target.value)}
                                required
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="smtp_user">Nome Utente SMTP</label>
                              <input
                                type="text"
                                id="smtp_user"
                                className="form-control form-control-sm"
                                value={settSmtpUser}
                                onChange={(e) => setSettSmtpUser(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="smtp_pass">Password SMTP</label>
                              <input
                                type="password"
                                id="smtp_pass"
                                className="form-control form-control-sm"
                                value={settSmtpPass}
                                onChange={(e) => setSettSmtpPass(e.target.value)}
                              />
                            </div>
                            <div className="col-12">
                              <label className="form-label small fw-bold text-dark" htmlFor="smtp_from">Mittente E-mail Predefinito (From)</label>
                              <input
                                type="email"
                                id="smtp_from"
                                className="form-control form-control-sm"
                                value={settSmtpFrom}
                                onChange={(e) => setSettSmtpFrom(e.target.value)}
                                required
                              />
                            </div>
                            {/* Test SMTP */}
                            <div className="col-12 mt-3">
                              <div className="border rounded p-3" style={{background:'#f8f9fb'}}>
                                <h6 className="small fw-bold text-dark mb-2"><i className="fas fa-paper-plane me-1 text-primary"></i>Invia E-mail di Test</h6>
                                <form onSubmit={handleTestSmtp} className="d-flex gap-2 align-items-start flex-wrap">
                                  <input
                                    type="email"
                                    className="form-control form-control-sm"
                                    style={{maxWidth:280}}
                                    placeholder="destinatario@esempio.it"
                                    value={smtpTestTo}
                                    onChange={e => setSmtpTestTo(e.target.value)}
                                    required
                                  />
                                  <button
                                    type="submit"
                                    className="btn btn-sm btn-outline-primary"
                                    disabled={smtpTestStatus === 'loading'}
                                  >
                                    {smtpTestStatus === 'loading'
                                      ? <><i className="fas fa-spinner fa-spin me-1"></i>Invio...</>  
                                      : <><i className="fas fa-vial me-1"></i>Testa connessione</>}
                                  </button>
                                  {smtpTestStatus === 'ok' && <span className="badge bg-success align-self-center"><i className="fas fa-check me-1"></i>{smtpTestMsg}</span>}
                                  {smtpTestStatus === 'error' && <span className="badge bg-danger align-self-center"><i className="fas fa-times me-1"></i>{smtpTestMsg}</span>}
                                </form>
                              </div>
                            </div>
                          </div>
                        )}
                        {/* TAB: PEC */}
                        {activeSettingsTab === 'pec' && (
                          <div className="row g-3">
                            <div className="col-md-8">
                              <label className="form-label small fw-bold text-dark" htmlFor="pec_host">PEC Server Host</label>
                              <input
                                type="text"
                                id="pec_host"
                                className="form-control form-control-sm"
                                value={settPecHost}
                                onChange={(e) => setSettPecHost(e.target.value)}
                                required
                              />
                            </div>
                            <div className="col-md-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="pec_port">Porta</label>
                              <input
                                type="text"
                                id="pec_port"
                                className="form-control form-control-sm"
                                value={settPecPort}
                                onChange={(e) => setSettPecPort(e.target.value)}
                                required
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="pec_user">Nome Utente PEC</label>
                              <input
                                type="text"
                                id="pec_user"
                                className="form-control form-control-sm"
                                value={settPecUser}
                                onChange={(e) => setSettPecUser(e.target.value)}
                              />
                            </div>
                            <div className="col-md-6">
                              <label className="form-label small fw-semibold text-muted" htmlFor="pec_pass">Password PEC</label>
                              <input
                                type="password"
                                id="pec_pass"
                                className="form-control form-control-sm"
                                value={settPecPass}
                                onChange={(e) => setSettPecPass(e.target.value)}
                              />
                            </div>
                            <div className="col-12">
                              <label className="form-label small fw-bold text-dark" htmlFor="pec_from">Indirizzo PEC Mittente (From)</label>
                              <input
                                type="email"
                                id="pec_from"
                                className="form-control form-control-sm"
                                value={settPecFrom}
                                onChange={(e) => setSettPecFrom(e.target.value)}
                                required
                              />
                            </div>
                            {/* Test PEC */}
                            <div className="col-12 mt-3">
                              <div className="border rounded p-3" style={{background:'#f8f9fb'}}>
                                <h6 className="small fw-bold text-dark mb-2"><i className="fas fa-envelope-open-text me-1 text-success"></i>Invia PEC di Test</h6>
                                <form onSubmit={handleTestPec} className="d-flex gap-2 align-items-start flex-wrap">
                                  <input
                                    type="email"
                                    className="form-control form-control-sm"
                                    style={{maxWidth:280}}
                                    placeholder="destinatario@pec.esempio.it"
                                    value={pecTestTo}
                                    onChange={e => setPecTestTo(e.target.value)}
                                    required
                                  />
                                  <button
                                    type="submit"
                                    className="btn btn-sm btn-outline-success"
                                    disabled={pecTestStatus === 'loading'}
                                  >
                                    {pecTestStatus === 'loading'
                                      ? <><i className="fas fa-spinner fa-spin me-1"></i>Invio...</>
                                      : <><i className="fas fa-vial me-1"></i>Testa connessione</>}
                                  </button>
                                  {pecTestStatus === 'ok' && <span className="badge bg-success align-self-center"><i className="fas fa-check me-1"></i>{pecTestMsg}</span>}
                                  {pecTestStatus === 'error' && <span className="badge bg-danger align-self-center"><i className="fas fa-times me-1"></i>{pecTestMsg}</span>}
                                </form>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* TAB: APP IO (Multiple services creation & management) */}
                        {activeSettingsTab === 'app-io' && (
                          <div>
                            <div className="mb-4">
                              <label className="form-label small fw-bold text-dark" htmlFor="io_url">Endpoint API Globale App IO</label>
                              <input
                                type="text"
                                id="io_url"
                                className="form-control form-control-sm"
                                value={settIoUrl}
                                onChange={(e) => setSettIoUrl(e.target.value)}
                                required
                              />
                            </div>

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
                                        <tr key={s.id}>
                                          <td>
                                            <strong>{s.nome}</strong>
                                            {s.is_default && <span className="badge bg-success ms-2">Predefinito</span>}
                                          </td>
                                          <td className="font-monospace small">{s.id_service}</td>
                                          <td>{s.codice_catalogo || <span className="text-muted">—</span>}</td>
                                          <td className="text-end">
                                            <div className="btn-group">
                                              {!s.is_default && (
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
                        <button className="btn btn-outline-secondary btn-sm border-0" onClick={() => fetchCampaignDetail(campaign.id)} title="Aggiorna esiti">
                          <i className="fas fa-sync-alt"></i>
                        </button>
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
