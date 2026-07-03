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
    const name = String(payload['name'] ?? '') || [given, family].filter(Boolean).join(' ');
    
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

    fetch(`${API_BASE}/auth/citizen/config`)
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

    fetch(`${API_BASE}/auth/citizen/oidc/callback`, {
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

  const fetchNotifications = async () => {
    setLoadingNotifications(true);
    setErrorNotifications(null);
    try {
      const res = await fetch(`${API_BASE}/citizen/notifications`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
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
      const res = await fetch(`${API_BASE}/auth/citizen/login`, {
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

  const handleLogout = () => {
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

  const handleOidcLogin = () => {
    setLoginError(null);
    window.location.href = `${API_BASE}/auth/citizen/oidc/start`;
  };

  const handleDownloadAttachment = async (notifId: string) => {
    try {
      const res = await fetch(`${API_BASE}/citizen/notifications/${notifId}/attachment`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
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
                  <button type="button" className="danger" onClick={handleLogout}>
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
          <div className="row g-4">
            
            {/* List of notifications (Left column) */}
            <div className={selectedNotif ? 'col-lg-6' : 'col-12'}>
              <div className="card shadow-sm h-100 bg-white" style={{ borderRadius: '8px', border: '1px solid var(--border-1)' }}>
                <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">
                  <h3 className="h6 mb-0 fw-bold text-dark"><i className="far fa-envelope me-2 text-primary"></i>Comunicazioni Ricevute</h3>
                  <button className="btn btn-outline-secondary btn-sm border-0" onClick={fetchNotifications} title="Aggiorna elenco">
                    <i className="fas fa-sync-alt"></i>
                  </button>
                </div>
                <div className="card-body p-0">
                  {errorNotifications && (
                    <div className="alert alert-danger m-3"><i className="fas fa-exclamation-triangle"></i> {errorNotifications}</div>
                  )}

                  {loadingNotifications && notifications.length === 0 ? (
                    <div className="text-center py-5">
                      <i className="fas fa-spinner fa-spin fa-2x text-primary mb-2"></i>
                      <div>Caricamento comunicazioni...</div>
                    </div>
                  ) : notifications.length === 0 ? (
                    <div className="text-center py-5 text-muted">
                      <i className="far fa-folder-open fa-3x mb-3 text-muted" style={{ opacity: 0.3 }}></i>
                      <p className="mb-0">Non ci sono comunicazioni per questo codice fiscale.</p>
                    </div>
                  ) : (
                    <div className="list-group list-group-flush">
                      {notifications.map((n) => {
                        const isDownloaded = !!n.extraData?.['download_count'];
                        return (
                          <button
                            key={n.id}
                            className={`list-group-item list-group-item-action p-3 text-start border-bottom ${
                              selectedNotif?.id === n.id ? 'bg-light fw-bold border-start border-primary border-3' : ''
                            }`}
                            onClick={() => setSelectedNotif(n)}
                          >
                            <div className="d-flex justify-content-between align-items-start mb-2">
                              <span className="small text-muted">
                                <i className="far fa-calendar-alt me-1"></i> {new Date(n.createdAt).toLocaleDateString('it-IT')}
                              </span>
                              <span className={`badge ${isDownloaded ? 'bg-success' : 'bg-primary'}`}>
                                {isDownloaded ? 'SCARICATO ✓' : 'RICEVUTO'}
                              </span>
                            </div>
                            <h4 className="h6 mb-1 text-dark fw-bold">{n.campaign?.name || '—'}</h4>
                            <p className="small text-muted mb-2 text-truncate">{n.campaign?.description || ''}</p>
                            <div className="d-flex justify-content-between align-items-center mt-2" style={{ fontSize: '0.8rem' }}>
                              <span>Canale: <strong>{n.campaign?.channelType || '—'}</strong></span>
                              {n.email && <span><i className="far fa-envelope"></i> {n.email}</span>}
                              {n.pec && <span><i className="fas fa-envelope-open-text text-primary"></i> {n.pec}</span>}
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
              <div className="col-lg-6">
                <div className="card shadow-sm h-100 bg-white" style={{ borderRadius: '8px', border: '1px solid var(--border-1)' }}>
                  <div className="card-header bg-white py-3 border-bottom d-flex justify-content-between align-items-center">
                    <h3 className="h6 mb-0 fw-bold text-dark"><i className="far fa-envelope-open me-2 text-primary"></i>Dettaglio Avviso</h3>
                    <button className="btn btn-outline-secondary btn-sm border-0" onClick={() => setSelectedNotif(null)} title="Chiudi dettaglio">
                      <i className="fas fa-times"></i>
                    </button>
                  </div>
                  <div className="card-body">
                    <div className="mb-4">
                      <span className="small text-muted">Mittente:</span>
                      <h4 className="h6 text-navy fw-bold" style={{ color: 'var(--bi-navy)' }}>{entityName}</h4>
                      <div className="small text-muted">Generato il: {new Date(selectedNotif.createdAt).toLocaleString('it-IT')}</div>
                    </div>

                    <div className="mb-4 border-bottom pb-3">
                      <h5 className="h5 fw-bold text-dark mb-2">{selectedNotif.campaign?.name || '—'}</h5>
                      <div className="p-3 bg-light rounded" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5, fontSize: '0.95rem' }}>
                        {selectedNotif.campaign?.description || ''}
                      </div>
                    </div>

                    {/* Meta information */}
                    <div className="row g-3 mb-4">
                      <div className="col-sm-6">
                        <span className="small text-muted block">Canale di Invio</span>
                        <div className="fw-bold">{selectedNotif.campaign?.channelType || '—'}</div>
                      </div>
                      <div className="col-sm-6">
                        <span className="small text-muted block">Stato Spedizione</span>
                        <div>
                          <span className={`badge ${
                            selectedNotif.status === 'sent' ? 'bg-success' : 'bg-danger'
                          }`}>
                            {selectedNotif.status.toUpperCase()}
                          </span>
                        </div>
                      </div>
                      {selectedNotif.extraData?.['download_count'] && (
                        <div className="col-sm-12">
                          <div className="alert alert-success p-2 small mb-0 d-flex align-items-center gap-2">
                            <i className="fas fa-check-circle"></i>
                            <span>
                              Documento scaricato <strong>{selectedNotif.extraData['download_count']}</strong> volte. Ultimo download: <strong>{new Date(selectedNotif.extraData['downloaded_at']).toLocaleString('it-IT')}</strong>
                            </span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* PDF Attachment Download button */}
                    <div className="border-top pt-4">
                      <button
                        className="btn btn-primary w-100 py-3 fw-semibold d-flex align-items-center justify-content-center gap-2"
                        onClick={() => handleDownloadAttachment(selectedNotif.id)}
                        style={{ backgroundColor: 'var(--bi-primary)', border: 'none' }}
                      >
                        <i className="fas fa-file-pdf" style={{ fontSize: '1.2rem' }}></i>
                        Scarica Documento PDF Firmato / Protocollo
                      </button>
                      <p className="text-muted small text-center mt-2 mb-0">
                        Il download genera un documento PDF provvisto di segnatura di protocollo digitale.
                      </p>
                    </div>

                  </div>
                </div>
              </div>
            )}

          </div>
        )}

        {activeTab === 'profile' && (
          <div className="card shadow-sm bg-white mx-auto" style={{ maxWidth: '600px', borderRadius: '8px', border: '1px solid var(--border-1)' }}>
            <div className="card-header bg-white py-3 border-bottom">
              <h3 className="h6 mb-0 fw-bold text-dark"><i className="far fa-user me-2 text-primary"></i>Profilo Cittadino Certificato</h3>
            </div>
            <div className="card-body">
              <div className="text-center mb-4">
                <span className="user-initials-avatar" style={{ width: '64px', height: '64px', fontSize: '1.6rem', background: 'var(--bi-primary-a8)', color: 'var(--bi-primary)' }}>
                  {name?.slice(0, 2).toUpperCase()}
                </span>
                <h4 className="h5 fw-bold text-dark mt-3 mb-1">{name}</h4>
                <span className="badge bg-success">Identità Certificata via {provider}</span>
              </div>

              <div className="list-group list-group-flush border-top border-bottom mb-4">
                <div className="list-group-item d-flex justify-content-between align-items-center py-3">
                  <span className="text-muted">Codice Fiscale</span>
                  <strong className="fw-mono">{cf}</strong>
                </div>
                <div className="list-group-item d-flex justify-content-between align-items-center py-3">
                  <span className="text-muted">Metodo di accesso</span>
                  <span className="fw-bold text-primary">
                    {authMode === 'mock' ? 'Simulatore (sviluppo)' : `${provider} (OIDC)`}
                  </span>
                </div>
              </div>

              <p className="small text-muted text-center mb-0">
                Questa è un'area ad alto livello di sicurezza. Le sessioni scadono automaticamente dopo 8 ore.
              </p>
            </div>
          </div>
        )}

      </main>

      <Footer entityName={entityName} logoUrl={brandLogoUrl} version={appVersion} />
    </div>
  );
}
