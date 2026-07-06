import React, { useState, useEffect } from 'react';
import { Footer } from './components/Footer';

declare global {
  interface Window {
    __COMUNICAPA_CONFIG__?: { apiBase?: string };
  }
}

const API_BASE = window.__COMUNICAPA_CONFIG__?.apiBase ?? 'http://localhost:8080';

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

interface Notification {
  id: string;
  codiceFiscale: string;
  fullName: string | null;
  email: string | null;
  pec: string | null;
  status: 'pending' | 'queued' | 'sent' | 'failed' | 'skipped';
  createdAt: string;
  extraData?: Record<string, any>;
  campaign?: {
    name: string;
    description: string | null;
    channelType: string;
  };
}

function statusBadge(status: Notification['status']): { cls: string; label: string } {
  if (status === 'sent') return { cls: 'status-notif-received', label: 'Ricevuta' };
  if (status === 'failed' || status === 'skipped') return { cls: 'status-notif-failed', label: 'Non recapitata' };
  return { cls: 'status-notif-pending', label: 'In corso' };
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
    new Set(notifications.map((n) => n.campaign?.channelType).filter((c): c is string => !!c)),
  );

  const filteredNotifications = notifications.filter((n) => {
    if (searchText) {
      const haystack = `${n.campaign?.name || ''} ${n.campaign?.description || ''}`.toLowerCase();
      if (!haystack.includes(searchText.toLowerCase())) return false;
    }
    if (filterStatus !== 'all') {
      const bucket = n.status === 'sent' ? 'sent' : (n.status === 'failed' || n.status === 'skipped') ? 'failed' : 'pending';
      if (bucket !== filterStatus) return false;
    }
    if (filterChannel !== 'all' && n.campaign?.channelType !== filterChannel) return false;
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

  // Chiudi il menu utente cliccando fuori
  useEffect(() => {
    if (!userMenuOpen) return;
    const close = () => setUserMenuOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [userMenuOpen]);

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
      }
    }
  }, [notifications]);

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

  const handleDownloadAttachment = async (notifId: string) => {
    try {
      const res = await fetch(`${API_BASE}/citizen/notifications/${notifId}/attachment`, {
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
      a.download = `avviso_comune_${notifId.slice(0, 8)}.pdf`;
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
      <main className="container py-4 flex-grow-1" style={{ backgroundColor: 'var(--bg-1)' }}>
        
        {activeTab === 'notifications' && (
          <div className={`notif-layout ${selectedNotif ? 'has-detail' : ''}`}>

            {/* List of notifications (Left column) */}
            <div className="notif-list-col">
              <div className="card" style={{ height: '100%' }}>
                <div className="card-pad" style={{ borderBottom: '1px solid var(--border-1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--sp-3)' }}>
                  <h3 className="ms-h3" style={{ margin: 0 }}>
                    <i className="far fa-envelope" style={{ color: 'var(--bi-primary)', marginRight: 8 }} aria-hidden="true"></i>
                    Comunicazioni Ricevute
                  </h3>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={fetchNotifications} title="Aggiorna elenco">
                    <i className="fas fa-sync-alt" aria-hidden="true"></i>
                  </button>
                </div>
                <div className="card-pad" style={{ borderBottom: '1px solid var(--border-1)' }}>
                  <div className="filters-grid">
                    <div className="field">
                      <label htmlFor="search-text">Cerca</label>
                      <input
                        id="search-text"
                        type="text"
                        className="input"
                        placeholder="Nome o descrizione comunicazione"
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="search-status">Stato</label>
                      <select
                        id="search-status"
                        className="select"
                        value={filterStatus}
                        onChange={(e) => setFilterStatus(e.target.value as 'all' | 'sent' | 'pending' | 'failed')}
                      >
                        <option value="all">Tutti</option>
                        <option value="sent">Ricevute</option>
                        <option value="pending">In corso</option>
                        <option value="failed">Non recapitate</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="search-channel">Canale</label>
                      <select
                        id="search-channel"
                        className="select"
                        value={filterChannel}
                        onChange={(e) => setFilterChannel(e.target.value)}
                      >
                        <option value="all">Tutti</option>
                        {availableChannels.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="search-date-from">Dal</label>
                      <input
                        id="search-date-from"
                        type="date"
                        className="input"
                        value={filterDateFrom}
                        onChange={(e) => setFilterDateFrom(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="search-date-to">Al</label>
                      <input
                        id="search-date-to"
                        type="date"
                        className="input"
                        value={filterDateTo}
                        onChange={(e) => setFilterDateTo(e.target.value)}
                      />
                    </div>
                    {hasActiveFilters && (
                      <button type="button" className="btn btn-outline btn-sm" onClick={resetFilters}>
                        <i className="fas fa-times" aria-hidden="true"></i> Azzera
                      </button>
                    )}
                  </div>
                </div>
                <div className="card-body p-0">
                  {errorNotifications && (
                    <div className="alert alert-danger" style={{ margin: 'var(--sp-4)' }}>
                      <i className="fas fa-exclamation-triangle alert-icon" aria-hidden="true"></i>
                      <span>{errorNotifications}</span>
                    </div>
                  )}

                  {loadingNotifications && notifications.length === 0 ? (
                    <div className="notif-empty">
                      <i className="fas fa-spinner fa-spin" aria-hidden="true"></i>
                      <div>Caricamento comunicazioni...</div>
                    </div>
                  ) : notifications.length === 0 ? (
                    <div className="notif-empty">
                      <i className="far fa-folder-open" aria-hidden="true"></i>
                      <p style={{ margin: 0 }}>Non ci sono comunicazioni per questo codice fiscale.</p>
                    </div>
                  ) : filteredNotifications.length === 0 ? (
                    <div className="notif-empty">
                      <i className="fas fa-filter-circle-xmark" aria-hidden="true"></i>
                      <p style={{ margin: '0 0 var(--sp-3)' }}>Nessuna comunicazione corrisponde ai filtri.</p>
                      <button type="button" className="btn btn-outline btn-sm" onClick={resetFilters}>Azzera filtri</button>
                    </div>
                  ) : (
                    <div className="notif-list">
                      {filteredNotifications.map((n) => {
                        const isDownloaded = !!n.extraData?.['download_count'];
                        const badge = statusBadge(n.status);
                        return (
                          <button
                            key={n.id}
                            className={`notif-list-item ${selectedNotif?.id === n.id ? 'selected' : ''}`}
                            onClick={() => setSelectedNotif(n)}
                          >
                            <div className="notif-list-item-top">
                              <span className="notif-date">
                                <i className="far fa-calendar-alt" aria-hidden="true"></i> {new Date(n.createdAt).toLocaleDateString('it-IT')}
                              </span>
                              <span className={`status ${badge.cls}`}>
                                <span className="dot"></span>{badge.label}
                              </span>
                            </div>
                            <h4 className="notif-list-item-title">{n.campaign?.name || '—'}</h4>
                            <p className="notif-list-item-desc">{n.campaign?.description || ''}</p>
                            <div className="notif-list-item-meta">
                              <span>Canale: <strong>{n.campaign?.channelType || '—'}</strong></span>
                              {isDownloaded && (
                                <span className="status status-notif-received">
                                  <span className="dot"></span>Scaricato
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Notification Detail (Right column, appears only if selected) */}
            {selectedNotif && (
              <div className="notif-detail-col">
                <div className="avviso-card">
                  <div className="avviso-header">
                    <div>
                      <span className="from">Mittente</span>
                      <strong>{entityName}</strong>
                    </div>
                    <div className="notif-detail-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm notif-back-btn"
                        onClick={() => setSelectedNotif(null)}
                      >
                        <i className="fas fa-arrow-left" aria-hidden="true"></i> Torna alle comunicazioni
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm notif-close-btn"
                        onClick={() => setSelectedNotif(null)}
                        title="Chiudi dettaglio"
                      >
                        <i className="fas fa-times" aria-hidden="true"></i>
                      </button>
                    </div>
                  </div>
                  <div className="avviso-body">
                    <h3 className="ms-h3" style={{ marginBottom: 'var(--sp-3)' }}>{selectedNotif.campaign?.name || '—'}</h3>
                    <p style={{ whiteSpace: 'pre-wrap', color: 'var(--fg-2)', marginBottom: 'var(--sp-4)' }}>
                      {selectedNotif.campaign?.description || ''}
                    </p>

                    <div className="avviso-row">
                      <span className="k">Canale di invio</span>
                      <span className="v">{selectedNotif.campaign?.channelType || '—'}</span>
                    </div>
                    <div className="avviso-row">
                      <span className="k">Stato spedizione</span>
                      <span className="v">
                        <span className={`status ${statusBadge(selectedNotif.status).cls}`}>
                          <span className="dot"></span>{statusBadge(selectedNotif.status).label}
                        </span>
                      </span>
                    </div>
                    <div className="avviso-row">
                      <span className="k">Data generazione</span>
                      <span className="v">{new Date(selectedNotif.createdAt).toLocaleString('it-IT')}</span>
                    </div>
                    {!!selectedNotif.extraData?.['download_count'] && (
                      <div className="avviso-row">
                        <span className="k">Download</span>
                        <span className="v">
                          {selectedNotif.extraData['download_count']} volte — ultimo il{' '}
                          {new Date(selectedNotif.extraData['downloaded_at']).toLocaleString('it-IT')}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="avviso-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => handleDownloadAttachment(selectedNotif.id)}
                    >
                      <i className="fas fa-file-pdf" aria-hidden="true"></i> Scarica documento PDF firmato
                    </button>
                  </div>
                </div>
              </div>
            )}

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
