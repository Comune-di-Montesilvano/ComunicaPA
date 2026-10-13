// apps/frontend-admin/src/components/legal-attention/LegalAttentionCard.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { getChannelMeta } from '../../data/channels';
import { plural } from '../stats-ui';
import { LegalAttentionPanel } from './LegalAttentionPanel';
import type { ApiFetch, LegalAttentionSummaryItem } from './types';

interface Props {
  apiFetch: ApiFetch;
  isAdmin: boolean;
  onOpenNotification: (recipientId: string) => void;
  onOpenCampaign: (id: string) => void;
}

// Notifiche SEND / Posta con AR senza esito legale (bloccanti o ferme da 45
// giorni). Caricato all'apertura e da "Aggiorna", mai nel polling della
// dashboard: la query lavora su tutti i destinatari delle campagne legali.
// apiFetch arriva ricreata a ogni render di App (polling 5s): tenuta in ref,
// altrimenti useEffect ricaricherebbe a ogni giro.
export function LegalAttentionCard({ apiFetch, isAdmin, onOpenNotification, onOpenCampaign }: Props) {
  const apiFetchRef = useRef(apiFetch);
  useEffect(() => { apiFetchRef.current = apiFetch; }, [apiFetch]);
  const [items, setItems] = useState<LegalAttentionSummaryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openCampaign, setOpenCampaign] = useState<LegalAttentionSummaryItem | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetchRef.current(refresh ? '/legal-attention?refresh=1' : '/legal-attention');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items ?? []);
    } catch {
      setError('Impossibile caricare le notifiche senza esito legale.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!error && (!items || items.length === 0)) return null;

  return (
    <div className="stx-card stx-alerts">
      <div className="stx-card-head">
        <h3 className="stx-card-title"><ShieldAlert size={16} style={{ color: '#b42318' }} />Notifiche senza esito legale</h3>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => void load(true)} disabled={loading}>
          {loading ? <Loader2 className="icon-spin me-1" size={14} /> : <RefreshCw className="me-1" size={14} />}Aggiorna
        </button>
      </div>
      {error && <div className="text-danger small px-3 pb-2">{error}</div>}
      {/* Molte campagne (es. invii singoli): lista a scorrimento, la dashboard resta leggibile. */}
      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
      {(items ?? []).map((c) => {
        const meta = getChannelMeta(c.channelType);
        return (
          <div key={c.campaignId} className="stx-alert-row" onClick={() => setOpenCampaign(c)} role="button">
            <span className="stx-alert-main">
              <span className="stx-alert-kind">{meta.label}</span>
              <strong>{c.name}</strong>
              {isAdmin && <span className="text-muted small">di {c.createdByDisplayName}</span>}
              {c.blockingCount > 0 && <span className="stx-status is-bad">{plural(c.blockingCount, 'esito bloccante', 'esiti bloccanti')}</span>}
              {c.staleCount > 0 && <span className="stx-status is-warn">{plural(c.staleCount, 'ferma da almeno 45 giorni', 'ferme da almeno 45 giorni')}</span>}
            </span>
            <span className="stx-alert-cta">Gestisci<ChevronRight size={14} /></span>
          </div>
        );
      })}
      </div>
      {openCampaign && (
        <LegalAttentionPanel
          apiFetch={apiFetch}
          campaign={openCampaign}
          onClose={() => { setOpenCampaign(null); void load(true); }}
          onOpenNotification={onOpenNotification}
          onOpenCampaign={(id) => { setOpenCampaign(null); onOpenCampaign(id); }}
        />
      )}
    </div>
  );
}
