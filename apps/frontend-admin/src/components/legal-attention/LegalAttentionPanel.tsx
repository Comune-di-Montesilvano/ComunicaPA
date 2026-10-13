// apps/frontend-admin/src/components/legal-attention/LegalAttentionPanel.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Clock, ExternalLink, Loader2, X } from 'lucide-react';
import { KIND_LABELS } from './types';
import type { ApiFetch, ApplyReviewsResult, LegalAttentionItem, LegalAttentionSummaryItem } from './types';

interface Props {
  apiFetch: ApiFetch;
  campaign: LegalAttentionSummaryItem;
  onClose: () => void;
  onOpenNotification: (recipientId: string) => void;
  onOpenCampaign: (id: string) => void;
}

const PAGE_SIZE = 50;
const SNOOZE_PRESETS = [15, 30, 45];

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function tomorrowIsoDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function LegalAttentionPanel({ apiFetch, campaign, onClose, onOpenNotification, onOpenCampaign }: Props) {
  const apiFetchRef = useRef(apiFetch);
  useEffect(() => { apiFetchRef.current = apiFetch; }, [apiFetch]);
  const [items, setItems] = useState<LegalAttentionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [snoozeDays, setSnoozeDays] = useState<number | 'custom'>(30);
  const [customDate, setCustomDate] = useState(tomorrowIsoDate());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string; skipped: ApplyReviewsResult['skipped'] } | null>(null);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await apiFetchRef.current(`/legal-attention/campaigns/${campaign.campaignId}?page=${p}&pageSize=${PAGE_SIZE}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
      setSelected(new Set());
    } catch {
      setMessage({ tone: 'danger', text: 'Impossibile caricare le notifiche della campagna.', skipped: [] });
    } finally {
      setLoading(false);
    }
  }, [campaign.campaignId]);

  useEffect(() => { void load(page); }, [load, page]);

  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.recipientId)), [items, selected]);
  const hasBlockingSelected = selectedItems.some((i) => i.kind === 'blocking');
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.recipientId));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const apply = async (action: 'ack' | 'snooze') => {
    if (selectedItems.length === 0) return;
    const body: Record<string, unknown> = { recipientIds: selectedItems.map((i) => i.recipientId), action };
    if (note.trim()) body.note = note.trim();
    if (action === 'snooze') {
      body.snoozedUntil = snoozeDays === 'custom' ? new Date(`${customDate}T00:00:00`).toISOString() : addDays(snoozeDays);
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetchRef.current('/legal-attention/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const text = Array.isArray(err.message) ? err.message.join(', ') : (err.message ?? `HTTP ${res.status}`);
        setMessage({ tone: 'danger', text, skipped: [] });
        return;
      }
      const result: ApplyReviewsResult = await res.json();
      const verb = action === 'ack' ? 'Presa visione registrata' : 'Posticipo registrato';
      const count = result.applied === 1 ? '1 notifica' : `${result.applied} notifiche`;
      setMessage({ tone: 'success', text: `${verb} per ${count}.`, skipped: result.skipped });
      setNote('');
      await load(page);
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (id: string) => {
    const it = items.find((i) => i.recipientId === id);
    return it ? (it.fullName || it.codiceFiscale) : id;
  };

  return (
    <div className="modal fade show d-block" style={{ background: 'rgba(0,0,0,0.5)' }} tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-dialog modal-xl modal-dialog-scrollable">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">Notifiche senza esito legale — {campaign.name}</h5>
            <button type="button" className="btn btn-sm btn-link" onClick={() => onOpenCampaign(campaign.campaignId)}>
              <ExternalLink size={14} className="me-1" />Apri campagna
            </button>
            <button type="button" className="btn-close" aria-label="Chiudi" onClick={onClose}><X size={16} /></button>
          </div>
          <div className="modal-body">
            {message && (
              <div className={`alert alert-${message.tone} small`}>
                {message.text}
                {message.skipped.length > 0 && (
                  <ul className="mb-0 mt-1">
                    {message.skipped.map((s) => <li key={s.recipientId}>{nameOf(s.recipientId)}: {s.reason}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div className="d-flex flex-wrap gap-2 align-items-end mb-3">
              <div className="flex-grow-1">
                <label className="form-label small mb-1" htmlFor="la-note">Nota (facoltativa)</label>
                <input id="la-note" className="form-control form-control-sm" maxLength={1000} value={note}
                  onChange={(e) => setNote(e.target.value)} placeholder="Es. rinotificata tramite messo" />
              </div>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || selectedItems.length === 0} onClick={() => void apply('ack')}>
                <CheckCircle2 size={14} className="me-1" />Presa visione ({selectedItems.length})
              </button>
              <div className="d-flex gap-1 align-items-end">
                <select className="form-select form-select-sm" style={{ width: 'auto' }} aria-label="Durata posticipo"
                  value={String(snoozeDays)} onChange={(e) => setSnoozeDays(e.target.value === 'custom' ? 'custom' : Number(e.target.value))}>
                  {SNOOZE_PRESETS.map((d) => <option key={d} value={d}>{d} giorni</option>)}
                  <option value="custom">Altra data…</option>
                </select>
                {snoozeDays === 'custom' && (
                  <input type="date" className="form-control form-control-sm" style={{ width: 'auto' }} aria-label="Data posticipo"
                    min={tomorrowIsoDate()} value={customDate} onChange={(e) => setCustomDate(e.target.value)} />
                )}
                <button type="button" className="btn btn-sm btn-outline-secondary"
                  disabled={busy || selectedItems.length === 0 || hasBlockingSelected}
                  title={hasBlockingSelected ? 'Il posticipo vale solo per le notifiche ferme: le notifiche con esito bloccante si possono solo prendere in visione.' : undefined}
                  onClick={() => void apply('snooze')}>
                  <Clock size={14} className="me-1" />Posticipa
                </button>
              </div>
            </div>

            {loading ? (
              <div className="text-muted small"><Loader2 className="icon-spin me-1" size={14} />Caricamento…</div>
            ) : items.length === 0 ? (
              <div className="text-muted small">Nessuna notifica da gestire per questa campagna.</div>
            ) : (
              <div className="table-responsive">
                <table className="table table-sm align-middle">
                  <thead>
                    <tr>
                      <th><input type="checkbox" aria-label="Seleziona tutte" checked={allSelected}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.recipientId)))} /></th>
                      <th>Destinatario</th>
                      <th>Codice fiscale</th>
                      <th>Situazione</th>
                      <th>Motivo</th>
                      <th>IUN / Raccomandata</th>
                      <th>Ultima azione</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.recipientId}>
                        <td><input type="checkbox" aria-label={`Seleziona ${i.fullName || i.codiceFiscale}`} checked={selected.has(i.recipientId)} onChange={() => toggle(i.recipientId)} /></td>
                        <td><button type="button" className="btn btn-link btn-sm p-0" onClick={() => onOpenNotification(i.recipientId)}>{i.fullName || '—'}</button></td>
                        <td className="small">{i.codiceFiscale}</td>
                        <td><span className={`stx-status ${i.kind === 'blocking' ? 'is-bad' : 'is-warn'}`}>{KIND_LABELS[i.kind]}</span></td>
                        <td className="small">{i.reason}</td>
                        <td className="small">{i.iun ?? i.postalCode ?? '—'}</td>
                        <td className="small text-muted">
                          {i.lastReview
                            ? `${i.lastReview.action === 'ack' ? 'Presa visione' : 'Posticipo'} di ${i.lastReview.createdBy} il ${new Date(i.lastReview.createdAt).toLocaleDateString('it-IT')}`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {pages > 1 && (
              <div className="d-flex justify-content-between align-items-center small">
                <span>{total} notifiche · pagina {page} di {pages}</span>
                <div className="btn-group">
                  <button type="button" className="btn btn-sm btn-outline-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Precedente</button>
                  <button type="button" className="btn btn-sm btn-outline-secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Successiva</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
