import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, PenLine } from 'lucide-react';
import { ARUBA_USER_STORAGE_KEY } from './types';
import type { ApiFetch, RemoteSignStatus } from './types';

type Mode = { kind: 'campaign'; campaignId: string } | { kind: 'test' };

interface Props {
  apiFetch: ApiFetch;
  mode: Mode;
  onClose: () => void;
  /** Solo mode campaign: job concluso (done o failed). */
  onFinished?: (status: RemoteSignStatus) => void;
}

function readSavedUser(): string {
  try { return localStorage.getItem(ARUBA_USER_STORAGE_KEY) ?? ''; } catch { return ''; }
}
function saveUser(user: string): void {
  try { localStorage.setItem(ARUBA_USER_STORAGE_KEY, user); } catch { /* storage non disponibile */ }
}

/**
 * Credenziali firma remota Aruba: utente ricordato nel browser, password e
 * OTP MAI salvati (svuotati alla chiusura). In mode campaign avvia il job e
 * ne segue l'avanzamento; in mode test esegue la Prova firma.
 * Renderizzata in un portal su document.body: sicura anche dentro una <form>.
 */
export function RemoteSignModal({ apiFetch, mode, onClose, onFinished }: Props) {
  const [user, setUser] = useState(readSavedUser);
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [otpDomain, setOtpDomain] = useState('firma');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [progress, setProgress] = useState<RemoteSignStatus | null>(null);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => { onFinishedRef.current = onFinished; }, [onFinished]);
  // apiFetch del chiamante non e' memoizzato: via ref per non resettare il polling a ogni render.
  const apiFetchRef = useRef(apiFetch);
  useEffect(() => { apiFetchRef.current = apiFetch; }, [apiFetch]);

  useEffect(() => {
    let cancelled = false;
    apiFetchRef.current('/remote-sign/config')
      .then((res) => res.ok ? res.json() : null)
      .then((config) => { if (!cancelled && config?.otpDomain) setOtpDomain(config.otpDomain); })
      .catch(() => { /* usa il dominio predefinito */ });
    return () => { cancelled = true; };
  }, []);

  const polling = progress !== null && (progress.status === 'queued' || progress.status === 'processing');
  const campaignId = mode.kind === 'campaign' ? mode.campaignId : null;

  // Riprende un job gia' in corso (modale richiusa/riaperta o pagina ricaricata).
  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetchRef.current(`/campaigns/${campaignId}/remote-sign`);
        if (!res.ok || cancelled) return;
        const s: RemoteSignStatus = await res.json();
        if (!cancelled && (s.status === 'queued' || s.status === 'processing')) setProgress(s);
      } catch {
        // nessun job da riprendere: resta il form
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId]);

  useEffect(() => {
    if (!polling || !campaignId) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await apiFetchRef.current(`/campaigns/${campaignId}/remote-sign`);
        if (!res.ok || cancelled) return;
        const s: RemoteSignStatus = await res.json();
        if (cancelled) return;
        setProgress(s);
        if (s.status === 'done' || s.status === 'failed') {
          if (s.status === 'failed') {
            setError(s.errorMessage ?? 'Firma interrotta');
            setOtp('');
          }
          onFinishedRef.current?.(s);
        }
      } catch {
        // silenzioso: stesso principio degli altri polling di stato
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [polling, campaignId]);

  const close = () => {
    setPassword('');
    setOtp('');
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Gli eventi React risalgono anche attraverso i portal: senza questo il
    // submit raggiunge la form Impostazioni che contiene il bottone "Prova firma".
    e.stopPropagation();
    setBusy(true);
    setError(null);
    setTestResult(null);
    saveUser(user.trim());
    try {
      const path = mode.kind === 'campaign' ? `/campaigns/${mode.campaignId}/remote-sign` : '/settings/remote-sign/test';
      const res = await apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: user.trim(), password, otp: otp.trim(), otpDomain: otpDomain.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
        setError(msg || `Errore (HTTP ${res.status})`);
        return;
      }
      if (mode.kind === 'test') {
        if (body?.ok) setTestResult(`Firma valida. Firmatario: ${body.signerCn ?? 'non letto'}`);
        else setError(body?.error ?? 'Prova firma fallita');
        setOtp('');
        return;
      }
      if (body?.error) {
        setError(body.error);
        setOtp('');
        return;
      }
      setPassword('');
      setOtp('');
      setProgress({ status: 'queued', totalFiles: 0, signedCount: 0, failedCount: 0, errorKind: null, errorMessage: null, signerCn: null });
    } catch (err: any) {
      setError(err?.message ?? 'Errore di rete');
    } finally {
      setBusy(false);
    }
  };

  const finished = progress && (progress.status === 'done' || progress.status === 'failed');
  const showForm = !polling && !(finished && progress?.status === 'done');

  return createPortal(
    <div className="modal d-block" tabIndex={-1} style={{ background: 'rgba(0,0,0,0.4)' }}>
      <div className="modal-dialog">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title d-flex align-items-center gap-2"><PenLine size={18} /> {mode.kind === 'test' ? 'Prova firma remota Aruba' : 'Firma con Aruba'}</h5>
            <button type="button" className="btn-close" aria-label="Chiudi" onClick={close} disabled={polling} />
          </div>
          <div className="modal-body">
            {progress && (
              <div className="mb-3">
                {polling ? (
                  <div className="d-flex align-items-center gap-2"><Loader2 className="icon-spin" size={16} /> Firma in corso {progress.signedCount}/{progress.totalFiles || '…'}</div>
                ) : progress.status === 'done' ? (
                  <div className="alert alert-success mb-0">Firmati {progress.signedCount} file{progress.failedCount > 0 ? `, ${progress.failedCount} non firmati` : ''}{progress.signerCn ? ` — firmatario ${progress.signerCn}` : ''}. La verifica della firma è stata riavviata: chiudi per vedere l'esito.</div>
                ) : null}
              </div>
            )}
            {error && <div className="alert alert-danger">{error}</div>}
            {testResult && <div className="alert alert-success">{testResult}</div>}
            {showForm && (
              <form id="remote-sign-form" onSubmit={submit} autoComplete="off">
                <div className="mb-2">
                  <label className="form-label small fw-bold" htmlFor="rs_user">Utente firma remota</label>
                  <input id="rs_user" className="form-control form-control-sm" value={user} onChange={(e) => setUser(e.target.value)} required autoComplete="off" />
                </div>
                <div className="mb-2">
                  <label className="form-label small fw-bold" htmlFor="rs_password">Password</label>
                  <input id="rs_password" type="password" className="form-control form-control-sm" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
                </div>
                <div className="mb-2">
                  <label className="form-label small fw-bold" htmlFor="rs_otp_domain">Dominio OTP</label>
                  <input id="rs_otp_domain" className="form-control form-control-sm" value={otpDomain} onChange={(e) => setOtpDomain(e.target.value)} required maxLength={64} autoComplete="off" />
                  <div className="form-text small">Puoi modificarlo per questa firma; il valore preconfigurato resta invariato.</div>
                </div>
                <div className="mb-2">
                  <label className="form-label small fw-bold" htmlFor="rs_otp">OTP</label>
                  <input id="rs_otp" className="form-control form-control-sm" inputMode="numeric" pattern="\d{6,8}" value={otp} onChange={(e) => setOtp(e.target.value)} required autoComplete="one-time-code" />
                  <div className="form-text small">Genera l'OTP per ultimo: dura pochi secondi. Un solo OTP firma tutto il lotto.</div>
                </div>
              </form>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline-secondary" onClick={close} disabled={polling}>Chiudi</button>
            {showForm && (
              <button type="submit" form="remote-sign-form" className="btn btn-primary" disabled={busy}>
                {busy ? <Loader2 className="icon-spin" size={16} /> : null} {mode.kind === 'test' ? 'Prova firma' : 'Firma'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
