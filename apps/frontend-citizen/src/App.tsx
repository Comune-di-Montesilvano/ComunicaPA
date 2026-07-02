import React, { useState, useEffect } from 'react';

declare global {
  interface Window {
    __COMUNICAPA_CONFIG__?: { apiBase?: string };
  }
}

const API_BASE = window.__COMUNICAPA_CONFIG__?.apiBase ?? 'http://localhost:8080';

interface Notification {
  id: string;
  codiceFiscale: string;
  fullName: string | null;
  email: string | null;
  pec: string | null;
  status: 'pending' | 'queued' | 'sent' | 'failed' | 'skipped';
  createdAt: string;
  extraData?: Record<string, any>;
  campaign: {
    name: string;
    description: string | null;
    channelType: string;
  };
}

export function App(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(localStorage.getItem('comunicapa_citizen_token'));
  const [cf, setCf] = useState<string | null>(localStorage.getItem('comunicapa_citizen_cf'));
  const [name, setName] = useState<string | null>(localStorage.getItem('comunicapa_citizen_name'));
  const [entityName, setEntityName] = useState('Comune di Montesilvano');

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
      .then((b: { name?: string; faviconUrl?: string | null }) => {
        if (b.name) {
          setEntityName(b.name);
          document.title = `${b.name} — ComunicaPA`;
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

      setToken(data.access_token);
      setCf(targetCf.toUpperCase());
      setName(targetName);
      setSelectedNotif(null);
    } catch (err: any) {
      setLoginError(err.message || 'Errore durante la simulazione SPID/CIE');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('comunicapa_citizen_token');
    localStorage.removeItem('comunicapa_citizen_cf');
    localStorage.removeItem('comunicapa_citizen_name');
    setToken(null);
    setCf(null);
    setName(null);
    setSelectedNotif(null);
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
      <div style={{ background: '#f0f4f8', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        {/* SPID Identity Header */}
        <header style={{ backgroundColor: '#003366', color: '#fff', padding: '10px 0', borderBottom: '4px solid #C9A13B' }}>
          <div className="container d-flex align-items-center justify-content-between">
            <span className="fw-bold" style={{ letterSpacing: '0.05em', fontSize: '0.9rem' }}>
              <span className="gov-dot"></span>MINISTERO DELL'INTERNO
            </span>
            <span className="small opacity-75">Accesso unico Pubblica Amministrazione</span>
          </div>
        </header>

        <main className="container my-5 flex-grow-1 d-flex align-items-center justify-content-center">
          <div className="card shadow-sm border-0" style={{ maxWidth: '600px', width: '100%', borderRadius: '12px', overflow: 'hidden' }}>
            <div className="card-body p-4 bg-white">
              <div className="text-center mb-4">
                <h1 className="h3 fw-bold text-navy" style={{ color: 'var(--bi-navy)' }}>Accedi all'area riservata</h1>
                <p className="text-muted small">Consulta lo storico delle notifiche e degli avvisi inviati dal {entityName}.</p>
              </div>

              {loginError && (
                <div className="alert alert-danger p-2 text-center small" role="alert">
                  <i className="fas fa-exclamation-circle me-1"></i> {loginError}
                </div>
              )}

              {/* Citizen test selector */}
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

              {/* Identity Providers Buttons */}
              <div className="border-top pt-4">
                <h3 className="h6 text-muted fw-bold mb-3 text-center">SELEZIONA LA TUA IDENTITÀ DIGITALE</h3>
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
            </div>
          </div>
        </main>

        <footer className="text-center py-4 small text-muted">
          ComunicaPA Hub Cittadino · Ministero per l'Innovazione Tecnologica e la Transizione Digitale
        </footer>
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
            <span>Accesso certificato tramite <strong>SPID/CIE</strong></span>
          </div>
        </div>
      </div>

      {/* Institutional Brand Header */}
      <header className="inst-header">
        <div className="container">
          <a className="inst-brand" href="#" onClick={(e) => { e.preventDefault(); setSelectedNotif(null); }}>
            <i className="fas fa-building stemma text-navy mb-0" style={{ fontSize: '2.4rem', color: 'var(--bi-navy)' }}></i>
            <div>
              <div className="eyebrow">Sportello Digitale</div>
              <div className="title">{entityName}</div>
              <div className="sub">ComunicaPA — Notifiche & Comunicazioni Istituzionali</div>
            </div>
          </a>
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
          <div className="d-flex align-items-center gap-3">
            <span className="small text-muted d-none d-md-inline">
              CF: <strong>{cf}</strong>
            </span>
            <button className="btn btn-outline-danger btn-sm border-0" onClick={handleLogout}>
              <i className="fas fa-sign-out-alt"></i> Esci
            </button>
          </div>
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
                            <h4 className="h6 mb-1 text-dark fw-bold">{n.campaign.name}</h4>
                            <p className="small text-muted mb-2 text-truncate">{n.campaign.description}</p>
                            <div className="d-flex justify-content-between align-items-center mt-2" style={{ fontSize: '0.8rem' }}>
                              <span>Canale: <strong>{n.campaign.channelType}</strong></span>
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
                      <h5 className="h5 fw-bold text-dark mb-2">{selectedNotif.campaign.name}</h5>
                      <div className="p-3 bg-light rounded" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5, fontSize: '0.95rem' }}>
                        {selectedNotif.campaign.description}
                      </div>
                    </div>

                    {/* Meta information */}
                    <div className="row g-3 mb-4">
                      <div className="col-sm-6">
                        <span className="small text-muted block">Canale di Invio</span>
                        <div className="fw-bold">{selectedNotif.campaign.channelType}</div>
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
                <span className="badge bg-success">Identità Certificata via SPID</span>
              </div>

              <div className="list-group list-group-flush border-top border-bottom mb-4">
                <div className="list-group-item d-flex justify-content-between align-items-center py-3">
                  <span className="text-muted">Codice Fiscale</span>
                  <strong className="fw-mono">{cf}</strong>
                </div>
                <div className="list-group-item d-flex justify-content-between align-items-center py-3">
                  <span className="text-muted">Simulatore di Login</span>
                  <span className="fw-bold text-primary">Federazione OIDC Attiva</span>
                </div>
              </div>

              <p className="small text-muted text-center mb-0">
                Questa è un'area ad alto livello di sicurezza. Le sessioni scadono automaticamente dopo 8 ore.
              </p>
            </div>
          </div>
        )}

      </main>

      {/* Footer */}
      <footer className="it-footer bg-light py-4 border-top mt-auto" style={{ fontSize: '0.86rem' }}>
        <div className="container d-flex flex-column flex-md-row align-items-center justify-content-between gap-3 text-muted">
          <div>
            <strong>{entityName}</strong> · Piazza Diaz 1 · Montesilvano (PE)
          </div>
          <div className="d-flex gap-3">
            <a href="#" className="text-muted text-decoration-none">Privacy Policy</a>
            <a href="#" className="text-muted text-decoration-none">Accessibilità</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
