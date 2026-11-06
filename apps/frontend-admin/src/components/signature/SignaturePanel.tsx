import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Loader2, PenLine, Upload, UserCheck } from 'lucide-react';
import { uploadFileInChunks } from '../../chunked-upload';
import { RemoteSignModal } from './RemoteSignModal';
import type { ApiFetch, SignatureJobStatus } from './types';

interface Props {
  apiFetch: ApiFetch;
  token: string;
  adminApiBase: string;
  campaignId: string;
  /** Ultima verifica firma, già pollata da App (step 6/7). */
  status: SignatureJobStatus | null;
  /** Calcolato dal backend (GET campaigns/:id): creatore, admin o firmatario indicato. */
  canReadAttachments: boolean;
  /** Creatore della campagna o admin: può scegliere il firmatario. */
  canEditSigner: boolean;
  signerUsername: string | null;
  signerDisplayName?: string | null;
  /** Dopo un cambio firmatario riuscito: App rilegge la campagna. */
  onSignerChanged: () => void;
}

export const ATTACHMENT_RESTRICTED_MESSAGE =
  'Allegato visibile solo a chi ha creato la campagna, agli amministratori e al firmatario indicato';

const MAX_REJECTED_SHOWN = 20;

export function SignaturePanel({
  apiFetch, token, adminApiBase, campaignId, status,
  canReadAttachments, canEditSigner, signerUsername, signerDisplayName, onSignerChanged,
}: Props) {
  const [arubaEnabled, setArubaEnabled] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'danger'; text: string; rejected?: Array<{ file: string; reason: string }> } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // apiFetch di App non e' memoizzato: via ref per non rifare la fetch config a ogni render.
  const apiFetchRef = useRef(apiFetch);
  useEffect(() => { apiFetchRef.current = apiFetch; }, [apiFetch]);

  const [operators, setOperators] = useState<Array<{ username: string; displayName: string }> | null>(null);
  const [signerSaving, setSignerSaving] = useState(false);
  const [signerError, setSignerError] = useState<string | null>(null);

  useEffect(() => {
    if (!canEditSigner) return;
    apiFetchRef.current('/operators')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => setOperators(Array.isArray(list) ? list : []))
      .catch(() => setOperators([]));
  }, [canEditSigner]);

  const changeSigner = async (value: string) => {
    setSignerSaving(true);
    setSignerError(null);
    try {
      const res = await apiFetch(`/campaigns/${campaignId}/signer`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signerUsername: value || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const msg = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
        setSignerError(msg || 'Impossibile salvare il firmatario');
        return;
      }
      onSignerChanged();
    } catch (err: any) {
      setSignerError(err?.message ?? 'Impossibile salvare il firmatario');
    } finally {
      setSignerSaving(false);
    }
  };

  useEffect(() => {
    apiFetchRef.current('/remote-sign/config')
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((b) => setArubaEnabled(Boolean(b.enabled)))
      .catch(() => setArubaEnabled(false));
  }, []);

  const downloadZip = async () => {
    setBusy('Preparazione ZIP…');
    setMessage(null);
    try {
      const res = await apiFetch(`/campaigns/${campaignId}/signature/unsigned.zip`);
      const type = res.headers.get('Content-Type') ?? '';
      if (!res.ok || type.includes('application/json')) {
        const body = await res.json().catch(() => null);
        setMessage({ kind: 'danger', text: body?.error ?? body?.message ?? (res.status === 403 ? ATTACHMENT_RESTRICTED_MESSAGE : 'Download non riuscito') });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'allegati-da-firmare.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setMessage({ kind: 'danger', text: err?.message ?? 'Download non riuscito' });
    } finally {
      setBusy(null);
    }
  };

  const uploadSigned = async (file: File) => {
    setBusy('Caricamento firmati…');
    setMessage(null);
    try {
      const body = await uploadFileInChunks(
        `${adminApiBase}/campaigns/${campaignId}/signed-attachments/upload`,
        token,
        file,
        file.name,
        () => undefined,
        () => setBusy('Abbinamento file firmati…'),
      );
      if (body?.error) {
        setMessage({ kind: 'danger', text: body.error });
      } else {
        setMessage({
          kind: body.replaced > 0 ? 'success' : 'danger',
          text: `Sostituiti ${body.replaced} allegati${body.rejected.length > 0 ? `, ${body.rejected.length} file scartati` : ''}. ${body.replaced > 0 ? 'Verifica firma in corso…' : ''}`,
          rejected: body.rejected,
        });
      }
    } catch (err: any) {
      setMessage({ kind: 'danger', text: err?.message ?? 'Caricamento non riuscito' });
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const restrictedTitle = canReadAttachments ? undefined : ATTACHMENT_RESTRICTED_MESSAGE;

  const allValid = status?.status === 'done' && status.invalidCount === 0;
  const hasInvalid = status?.status === 'done' && status.invalidCount > 0;

  // Firma riuscita e verifica tutta valida: la modale ha finito il suo lavoro.
  useEffect(() => {
    if (allValid) setModalOpen(false);
  }, [allValid]);

  return (
    <div className={`alert ${allValid ? 'alert-success' : 'alert-warning'} mb-3`}>
      <div className="d-flex align-items-center gap-2">
        {!status ? (
          <>Verifica firma digitale allegati in corso...</>
        ) : status.status !== 'done' ? (
          <><Loader2 className="icon-spin" size={16} /> Verifica firma digitale in corso...</>
        ) : hasInvalid ? (
          <><AlertTriangle size={16} /> {status.invalidCount} allegato/i non firmati validamente su {status.totalRows} — firmali qui sotto o lancia comunque confermando sotto la tua responsabilità.</>
        ) : (
          <><CheckCircle2 size={16} /> Tutti gli allegati ({status.totalRows}) risultano firmati validamente.</>
        )}
      </div>

      <div className="d-flex flex-wrap align-items-center gap-2 mt-2 small">
        <UserCheck size={14} />
        {canEditSigner ? (
          <>
            <label htmlFor={`signer-${campaignId}`} className="mb-0">Firmatario:</label>
            <select
              id={`signer-${campaignId}`}
              className="form-select form-select-sm w-auto"
              value={signerUsername ?? ''}
              disabled={signerSaving || operators === null}
              onChange={(e) => void changeSigner(e.target.value)}
            >
              <option value="">Nessun firmatario</option>
              {/* Firmatario già salvato ma non più in elenco: resta selezionabile così com'è. */}
              {signerUsername && operators && !operators.some((o) => o.username === signerUsername) && (
                <option value={signerUsername}>{signerDisplayName || signerUsername}</option>
              )}
              {(operators ?? []).map((o) => (
                <option key={o.username} value={o.username}>{o.displayName || o.username}</option>
              ))}
            </select>
            {signerSaving && <Loader2 className="icon-spin" size={14} />}
            <span className="text-muted">Chi non compare nell'elenco deve accedere una volta a ComunicaPA.</span>
          </>
        ) : (
          <span>Firmatario: <strong>{signerUsername ? (signerDisplayName || signerUsername) : 'nessuno'}</strong></span>
        )}
      </div>
      {signerError && <div className="alert alert-danger mt-2 mb-0 small">{signerError}</div>}

      {hasInvalid && (
        <div className="d-flex flex-wrap gap-2 mt-2">
          {/* Bottone disabilitato = niente eventi mouse: il title va sullo span esterno. */}
          {arubaEnabled && (
            <span title={restrictedTitle}>
              <button type="button" className="btn btn-sm btn-primary" disabled={!!busy || !canReadAttachments} onClick={() => setModalOpen(true)}>
                <PenLine size={14} className="me-1" />Firma con Aruba
              </button>
            </span>
          )}
          <span title={restrictedTitle}>
            <button type="button" className="btn btn-sm btn-outline-secondary" disabled={!!busy || !canReadAttachments} onClick={downloadZip}>
              <Download size={14} className="me-1" />Scarica ZIP da firmare
            </button>
          </span>
          <span title={restrictedTitle}>
            <button type="button" className="btn btn-sm btn-outline-secondary" disabled={!!busy || !canReadAttachments} onClick={() => fileInput.current?.click()}>
              <Upload size={14} className="me-1" />Carica firmati
            </button>
          </span>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.pdf"
            className="d-none"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadSigned(f); }}
          />
          {busy && <span className="small d-flex align-items-center gap-1"><Loader2 className="icon-spin" size={14} />{busy}</span>}
        </div>
      )}

      {message && (
        <div className={`alert alert-${message.kind} mt-2 mb-0 small`}>
          {message.text}
          {message.rejected && message.rejected.length > 0 && (
            <ul className="mb-0 mt-1">
              {message.rejected.slice(0, MAX_REJECTED_SHOWN).map((r) => <li key={r.file}><code>{r.file}</code>: {r.reason}</li>)}
              {message.rejected.length > MAX_REJECTED_SHOWN && <li>e altri {message.rejected.length - MAX_REJECTED_SHOWN}</li>}
            </ul>
          )}
        </div>
      )}

      {modalOpen && (
        <RemoteSignModal
          apiFetch={apiFetch}
          mode={{ kind: 'campaign', campaignId }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
