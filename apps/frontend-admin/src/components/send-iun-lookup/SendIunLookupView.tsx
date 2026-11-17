// Ricerca IUN SEND per numero di protocollo e apertura della notifica, anche
// per invii fatti fuori da ComunicaPA (portale SEND, altri gestionali). Il
// backend usa una apiKey PN dedicata; senza, la voce di menu non compare.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Download, FileSearch, FileText, Loader2, Search, Users } from 'lucide-react';
import { sendDocumentLabel, type SendDocumentItem } from '../notification-detail/send-documents';
import { describeSendTimelineEvent, type SendTimelineEvent } from '../notification-detail/send-timeline';

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

interface Recipient {
  index: number;
  recipientType: string;
  denomination: string;
  taxId: string;
}

type LookupResult =
  | { found: false }
  | {
      found: true;
      iun: string;
      paProtocolNumber: string;
      requestStatus: string;
      notificationStatus?: string;
      subject?: string;
      sentAt?: string;
      group?: string;
      recipients: Recipient[];
    };

interface NotificationDetail {
  iun: string;
  paProtocolNumber: string;
  subject?: string;
  abstract?: string;
  sentAt?: string;
  group?: string;
  senderDenomination?: string;
  notificationStatus?: string;
  documentsAvailable: boolean;
  statusHistory: Array<{ status: string; activeFrom: string }>;
  recipients: Recipient[];
  timeline: SendTimelineEvent[];
  notifiedDocuments: Array<{ docIdx: number; title: string }>;
  sendDocuments: Array<SendDocumentItem & { recIndex?: number }>;
}

interface Props {
  apiFetch: ApiFetch;
  /** Atto notificato (comunicazione originale) scaricabile solo dagli admin; il backend lo impone. */
  canDownloadNotifiedDocuments: boolean;
  renderSendStatus: (status: string | undefined) => ReactNode;
  sendStatusLabel: (status: string) => string;
}

const TONE_CLASS: Record<string, string> = { ok: 'text-success', ko: 'text-danger', warn: 'text-warning', neutral: 'text-secondary' };

function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { message?: string | string[] } | null;
  const msg = Array.isArray(body?.message) ? body?.message.join(', ') : body?.message;
  return msg || `Errore HTTP ${res.status}`;
}

function recIndexOf(e: SendTimelineEvent): number | undefined {
  const v = e.details?.['recIndex'];
  return typeof v === 'number' ? v : undefined;
}

function recipientLabel(r: Recipient): string {
  return `${r.denomination || 'Destinatario senza nome'}${r.taxId ? ` (${r.taxId})` : ''}`;
}

export function SendIunLookupView({ apiFetch, canDownloadNotifiedDocuments, renderSendStatus, sendStatusLabel }: Props) {
  const apiFetchRef = useRef(apiFetch);
  useEffect(() => { apiFetchRef.current = apiFetch; }, [apiFetch]);

  const [protocol, setProtocol] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [result, setResult] = useState<LookupResult | null>(null);

  const [detail, setDetail] = useState<NotificationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [openRecipient, setOpenRecipient] = useState<number | null>(null);
  const [downloadState, setDownloadState] = useState<Record<string, string>>({});

  const search = async () => {
    const p = protocol.trim();
    if (!p) return;
    setSearching(true);
    setSearchError(null);
    setResult(null);
    setDetail(null);
    try {
      const qs = new URLSearchParams({ protocollo: p });
      const res = await apiFetchRef.current(`/send-iun-lookup?${qs.toString()}`);
      if (!res.ok) {
        setSearchError(await errorText(res));
        return;
      }
      setResult(await res.json());
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Errore di rete');
    } finally {
      setSearching(false);
    }
  };

  const openDetail = async (iun: string) => {
    setDetailLoading(true);
    setDetailError(null);
    setDownloadState({});
    try {
      const res = await apiFetchRef.current(`/send-iun-lookup/notifications/${encodeURIComponent(iun)}`);
      if (!res.ok) {
        setDetailError(await errorText(res));
        return;
      }
      const d: NotificationDetail = await res.json();
      setDetail(d);
      setOpenRecipient(d.recipients.length === 1 ? 0 : null);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Errore di rete');
    } finally {
      setDetailLoading(false);
    }
  };

  // PDF aperti in una nuova scheda, il resto scaricato; documento non ancora
  // pronto (archiviato da PN) → messaggio con l'attesa indicata da PN.
  const download = async (key: string, path: string) => {
    setDownloadState((s) => ({ ...s, [key]: 'loading' }));
    try {
      const res = await apiFetchRef.current(path);
      if (!res.ok) {
        setDownloadState((s) => ({ ...s, [key]: 'Errore durante il download' }));
        return;
      }
      if ((res.headers.get('content-type') || '').includes('application/json')) {
        const data = await res.json() as { retryAfterSeconds?: number; error?: string };
        const msg = data.error
          ? `Non disponibile: ${data.error}`
          : `Documento in preparazione su SEND, riprova tra ${Math.max(1, Math.ceil((data.retryAfterSeconds ?? 60) / 60))} min`;
        setDownloadState((s) => ({ ...s, [key]: msg }));
        return;
      }
      setDownloadState((s) => {
        const next = { ...s };
        delete next[key];
        return next;
      });
      const blob = await res.blob();
      const match = (res.headers.get('content-disposition') || '').match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : 'documento';
      const url = URL.createObjectURL(blob);
      if (/\.pdf$/i.test(filename)) {
        window.open(url, '_blank');
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch {
      setDownloadState((s) => ({ ...s, [key]: 'Errore durante il download' }));
    }
  };

  const downloadButton = (key: string, path: string, label: string) => {
    const state = downloadState[key];
    return (
      <div key={key} className="d-flex flex-column mb-2">
        <button type="button" className="btn btn-link btn-sm p-0 text-start text-decoration-none d-flex align-items-center justify-content-start gap-2" onClick={() => download(key, path)} disabled={state === 'loading'}>
          {state === 'loading' ? <Loader2 className="icon-spin" size={14} /> : <Download size={14} />}
          <span>{label}</span>
        </button>
        {state && state !== 'loading' && <span className="small text-muted ms-4">{state}</span>}
      </div>
    );
  };

  const sendDocButton = (d: NotificationDetail, item: SendDocumentItem) =>
    downloadButton(
      `send:${item.legalFactId}`,
      `/send-iun-lookup/notifications/${encodeURIComponent(d.iun)}/send-documents/download?legalFactId=${encodeURIComponent(item.legalFactId)}`,
      sendDocumentLabel(item),
    );

  if (detail) {
    const commonDocs = detail.sendDocuments.filter((x) => x.recIndex === undefined);
    return (
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <button type="button" className="btn btn-link btn-sm px-0 mb-3 text-decoration-none d-flex align-items-center gap-1" onClick={() => setDetail(null)}>
          <ArrowLeft size={16} />Torna alla ricerca
        </button>

        <div className="card shadow-sm p-4 mb-4 border-0 bg-white rounded-3">
          <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
            <div>
              <div className="small text-muted text-uppercase fw-bold">IUN</div>
              <h3 className="h5 fw-bold font-monospace mb-0">{detail.iun}</h3>
            </div>
            {renderSendStatus(detail.notificationStatus)}
          </div>
          <dl className="row small mb-0">
            <dt className="col-sm-3 text-muted">Numero protocollo</dt><dd className="col-sm-9">{detail.paProtocolNumber || '—'}</dd>
            <dt className="col-sm-3 text-muted">Oggetto</dt><dd className="col-sm-9">{detail.subject || '—'}</dd>
            {detail.abstract && (<><dt className="col-sm-3 text-muted">Descrizione</dt><dd className="col-sm-9">{detail.abstract}</dd></>)}
            <dt className="col-sm-3 text-muted">Inviata il</dt><dd className="col-sm-9">{formatDateTime(detail.sentAt)}</dd>
            {detail.group && (<><dt className="col-sm-3 text-muted">Gruppo SEND</dt><dd className="col-sm-9">{detail.group}</dd></>)}
            {detail.senderDenomination && (<><dt className="col-sm-3 text-muted">Mittente</dt><dd className="col-sm-9">{detail.senderDenomination}</dd></>)}
          </dl>
        </div>

        <div className="row g-4">
          <div className="col-lg-8">
            <div className="card shadow-sm p-4 border-0 bg-white rounded-3">
              <h4 className="h6 fw-bold mb-3 d-flex align-items-center gap-2"><Users size={18} className="text-primary" />Destinatari ({detail.recipients.length})</h4>
              {detail.recipients.map((r) => {
                const isOpen = openRecipient === r.index;
                const events = detail.timeline.filter((e) => recIndexOf(e) === r.index);
                const docs = detail.sendDocuments.filter((x) => x.recIndex === r.index);
                return (
                  <div key={r.index} className="border rounded-3 mb-2">
                    <button
                      type="button"
                      className="btn btn-light w-100 text-start d-flex align-items-center justify-content-start gap-2 border-0"
                      aria-expanded={isOpen}
                      onClick={() => setOpenRecipient(isOpen ? null : r.index)}
                    >
                      {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <span className="fw-semibold">{recipientLabel(r)}</span>
                      {r.recipientType === 'PG' && <span className="badge bg-light text-dark border ms-auto">Persona giuridica</span>}
                    </button>
                    {isOpen && (
                      <div className="p-3">
                        {docs.length > 0 && (
                          <div className="mb-3">
                            <div className="small text-muted text-uppercase fw-bold mb-2">Documenti del destinatario</div>
                            {docs.map((item) => sendDocButton(detail, item))}
                          </div>
                        )}
                        <div className="small text-muted text-uppercase fw-bold mb-2">Percorso</div>
                        {events.length === 0 && <div className="small text-muted">Nessun evento ancora registrato da SEND.</div>}
                        <ul className="list-unstyled small mb-0 text-start">
                          {events.map((e, i) => {
                            const described = describeSendTimelineEvent(e, events);
                            if (!described) return null;
                            return (
                              <li key={`${e.category}-${e.at}-${i}`} className="mb-2 d-flex gap-3">
                                <span className="text-muted text-nowrap" style={{ minWidth: '120px' }}>{formatDateTime(e.at)}</span>
                                <span>
                                  <span className={`fw-semibold ${TONE_CLASS[described.tone] ?? ''}`}>{described.title}{described.logo ? ' App IO' : ''}</span>
                                  {described.detail && <span className="d-block text-muted">{described.detail}</span>}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="col-lg-4">
            <div className="card shadow-sm p-4 mb-4 border-0 bg-white rounded-3">
              <h4 className="h6 fw-bold mb-3 d-flex align-items-center gap-2"><FileText size={18} className="text-primary" />Documenti</h4>
              <div className="small text-muted text-uppercase fw-bold mb-2">Atti notificati</div>
              {!detail.documentsAvailable && (
                <div className="small text-muted mb-2">Non più disponibili su SEND (oltre i 120 giorni dal perfezionamento).</div>
              )}
              {detail.documentsAvailable && detail.notifiedDocuments.length === 0 && <div className="small text-muted mb-2">Nessun documento.</div>}
              {detail.documentsAvailable && canDownloadNotifiedDocuments && detail.notifiedDocuments.map((doc) =>
                downloadButton(
                  `doc:${doc.docIdx}`,
                  `/send-iun-lookup/notifications/${encodeURIComponent(detail.iun)}/documents/${doc.docIdx}`,
                  doc.title,
                ),
              )}
              {detail.documentsAvailable && !canDownloadNotifiedDocuments && detail.notifiedDocuments.length > 0 && (
                <>
                  <ul className="list-unstyled small mb-1 text-start">
                    {detail.notifiedDocuments.map((doc) => (
                      <li key={doc.docIdx} className="d-flex align-items-center gap-2"><FileText size={14} className="text-muted" />{doc.title}</li>
                    ))}
                  </ul>
                  <div className="small text-muted mb-2">Il download dell'atto notificato è riservato agli amministratori.</div>
                </>
              )}
              {commonDocs.length > 0 && (
                <>
                  <div className="small text-muted text-uppercase fw-bold mt-3 mb-2">Attestazioni della notifica</div>
                  {commonDocs.map((item) => sendDocButton(detail, item))}
                </>
              )}
            </div>

            <div className="card shadow-sm p-4 border-0 bg-white rounded-3">
              <h4 className="h6 fw-bold mb-3">Storico stati</h4>
              {detail.statusHistory.length === 0 && <div className="small text-muted">—</div>}
              <ul className="list-unstyled small mb-0 text-start">
                {detail.statusHistory.map((h) => (
                  <li key={`${h.status}-${h.activeFrom}`} className="mb-1 d-flex justify-content-between gap-2">
                    <span>{sendStatusLabel(h.status)}</span>
                    <span className="text-muted text-nowrap">{formatDateTime(h.activeFrom)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
      <div className="mb-3">
        <h3 className="h5 fw-bold text-dark mb-1 d-flex align-items-center gap-2">
          <FileSearch className="text-primary" size={20} />Ricerca IUN SEND
        </h3>
        <p className="small text-muted mb-0">
          Trova una notifica SEND dal numero di protocollo, anche se inviata dal portale SEND o da un altro gestionale, e aprila:
          destinatari, percorso, atti notificati e attestazioni.
        </p>
      </div>

      <div className="card shadow-sm p-4 mb-4 border-0 bg-white rounded-3">
        <label className="form-label small fw-bold text-secondary text-uppercase tracking-wider" htmlFor="send-lookup-protocol">Numero di protocollo</label>
        <div className="input-group input-group-sm" style={{ maxWidth: '600px' }}>
          <input
            id="send-lookup-protocol"
            type="text"
            className="form-control fw-semibold"
            placeholder="Esattamente come inserito nella notifica, es. 1234 oppure 1234/2026"
            maxLength={256}
            value={protocol}
            onChange={(e) => setProtocol(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
          />
          <button className="btn btn-primary px-4 fw-medium d-flex align-items-center gap-2" type="button" onClick={search} disabled={searching || !protocol.trim()}>
            {searching ? <><Loader2 className="icon-spin" size={16} />Ricerca...</> : <><Search size={16} />Cerca</>}
          </button>
        </div>
        <div className="form-text small">
          Il protocollo deve coincidere carattere per carattere con quello della notifica (con o senza anno, come è stato scritto).
        </div>
        {searchError && <div className="small text-danger mt-2">{searchError}</div>}
      </div>

      {result && !result.found && (
        <div className="alert alert-warning small">
          <div className="fw-semibold mb-1">Nessuna notifica trovata con questo protocollo.</div>
          <div>
            SEND cerca il protocollo esattamente com'è stato scritto all'invio. Prova nel formato <strong>numero/anno</strong>{' '}
            (es. 1234/2026): chi ha inviato la notifica potrebbe però averlo scritto come <strong>numero-anno</strong> (1234-2026)
            o con il <strong>solo numero</strong> (1234), quindi prova anche queste forme.
          </div>
        </div>
      )}

      {result?.found && (
        <div className="card shadow-sm p-4 border-0 bg-white rounded-3">
          <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
            <div>
              <div className="small text-muted text-uppercase fw-bold">IUN</div>
              <div className="h5 fw-bold font-monospace mb-0">{result.iun}</div>
            </div>
            {renderSendStatus(result.notificationStatus)}
          </div>
          <dl className="row small mb-3">
            <dt className="col-sm-3 text-muted">Numero protocollo</dt><dd className="col-sm-9">{result.paProtocolNumber}</dd>
            <dt className="col-sm-3 text-muted">Oggetto</dt><dd className="col-sm-9">{result.subject || '—'}</dd>
            <dt className="col-sm-3 text-muted">Inviata il</dt><dd className="col-sm-9">{formatDateTime(result.sentAt)}</dd>
            {result.group && (<><dt className="col-sm-3 text-muted">Gruppo SEND</dt><dd className="col-sm-9">{result.group}</dd></>)}
            <dt className="col-sm-3 text-muted">Destinatari</dt>
            <dd className="col-sm-9">
              <ul className="list-unstyled mb-0">
                {result.recipients.map((r) => <li key={r.index}>{recipientLabel(r)}</li>)}
              </ul>
            </dd>
          </dl>
          <div>
            <button type="button" className="btn btn-primary btn-sm d-inline-flex align-items-center gap-2" onClick={() => openDetail(result.iun)} disabled={detailLoading}>
              {detailLoading ? <Loader2 className="icon-spin" size={16} /> : <FileText size={16} />}Apri notifica
            </button>
          </div>
          {detailError && <div className="small text-danger mt-2">{detailError}</div>}
        </div>
      )}
    </div>
  );
}
