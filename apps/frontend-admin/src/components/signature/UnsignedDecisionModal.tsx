import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, PenLine } from 'lucide-react';
import { RemoteSignModal } from './RemoteSignModal';
import { InvalidFilesList } from './InvalidFilesList';
import { invalidRecipientsText } from './invalidSignature';
import type { ApiFetch, RemoteSignStatus, SignatureJobStatus } from './types';

export type UnsignedDecision = 'continue' | 'cancel';

interface Props {
  apiFetch: ApiFetch;
  campaignId: string;
  /** Esito della verifica firma che ha aperto la modale (conteggi + file non validi). */
  status: SignatureJobStatus;
  arubaEnabled: boolean;
  /** Obbligo di firma attivo (Impostazioni → SEND): niente "Invia comunque". */
  signatureRequired?: boolean;
  onDecision: (d: UnsignedDecision) => void;
}

/**
 * Invio Manuale SEND con allegato non firmato validamente: firma con Aruba
 * (e l'invio riprende da solo se la nuova verifica è tutta valida), invia
 * comunque sotto la responsabilità dell'operatore, o annulla.
 */
export function UnsignedDecisionModal({ apiFetch, campaignId, status, arubaEnabled, signatureRequired = false, onDecision }: Props) {
  const [signing, setSigning] = useState(false);
  const [waitingVerification, setWaitingVerification] = useState(false);
  const [verification, setVerification] = useState<SignatureJobStatus>(status);
  const [note, setNote] = useState<string | null>(null);

  // apiFetch di App non è memoizzato (cambia a ogni render): in ref, altrimenti
  // il polling verrebbe resettato a ogni re-render di App.
  const apiFetchRef = useRef(apiFetch);
  useEffect(() => { apiFetchRef.current = apiFetch; }, [apiFetch]);
  const onDecisionRef = useRef(onDecision);
  useEffect(() => { onDecisionRef.current = onDecision; }, [onDecision]);

  useEffect(() => {
    if (!waitingVerification) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await apiFetchRef.current(`/campaigns/${campaignId}/signature-verification`);
        if (!res.ok || cancelled) return;
        const s: SignatureJobStatus = await res.json();
        if (cancelled) return;
        if (s.status === 'failed') {
          setWaitingVerification(false);
          setNote(signatureRequired ? 'Verifica firma non riuscita: riprova.' : 'Verifica firma non riuscita: riprova o invia comunque.');
        } else if (s.status === 'done') {
          setWaitingVerification(false);
          if (s.invalidCount === 0) onDecisionRef.current('continue');
          else {
            setVerification(s);
            setNote('Dopo la firma restano allegati non validi.');
          }
        }
      } catch {
        // silenzioso
      }
    }, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [waitingVerification, campaignId, signatureRequired]);

  const onSignFinished = (s: RemoteSignStatus) => {
    if (s.status === 'done') {
      setSigning(false);
      setWaitingVerification(true);
    }
  };

  if (signing) {
    return (
      <RemoteSignModal
        apiFetch={apiFetch}
        mode={{ kind: 'campaign', campaignId }}
        onClose={() => setSigning(false)}
        onFinished={onSignFinished}
      />
    );
  }

  return (
    <div className="modal d-block" tabIndex={-1} style={{ background: 'rgba(0,0,0,0.4)' }}>
      <div className="modal-dialog">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title d-flex align-items-center gap-2"><AlertTriangle size={18} /> Allegato non firmato validamente</h5>
          </div>
          <div className="modal-body">
            <p className="mb-1">{invalidRecipientsText(verification.invalidCount, verification.totalRows)}:</p>
            <InvalidFilesList status={verification} className="mb-2" />
            <p className="small text-muted mb-2">Per SEND tutti gli allegati sono notificati come documenti dell'atto, quindi vanno firmati tutti: senza firma digitale valida la notifica rischia di essere contestata (autenticità dell'atto, decorrenza dei termini).</p>
            {signatureRequired && <div className="alert alert-danger small mb-2">La firma digitale è obbligatoria (Impostazioni → SEND): l'invio parte solo con allegati firmati validamente.</div>}
            {note && <div className="alert alert-warning small">{note}</div>}
            {waitingVerification && <div className="d-flex align-items-center gap-2"><Loader2 className="icon-spin" size={16} /> Verifica della firma in corso…</div>}
          </div>
          <div className="modal-footer">
            {/* Annulla sempre attivo: anche durante l'attesa della verifica (ferma il polling). */}
            <button type="button" className="btn btn-outline-secondary" onClick={() => { setWaitingVerification(false); onDecision('cancel'); }}>Annulla</button>
            {!signatureRequired && (
              <button type="button" className="btn btn-outline-danger" disabled={waitingVerification} onClick={() => onDecision('continue')}>Invia comunque</button>
            )}
            {arubaEnabled && (
              <button type="button" className="btn btn-primary" disabled={waitingVerification} onClick={() => { setNote(null); setSigning(true); }}>
                <PenLine size={14} className="me-1" />Firma con Aruba
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
