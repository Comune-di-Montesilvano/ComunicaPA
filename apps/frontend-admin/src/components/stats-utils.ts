// Costanti e formattatori condivisi tra Statistiche e Dashboard (senza componenti:
// stats-ui.tsx esporta solo componenti, per il Fast Refresh di Vite).

// ─── Palette grafici: fissa per entità, mai per posizione (validata dataviz) ───
// I colori del registro canali (loghi/badge) sono troppo vicini tra loro per
// un grafico (PEC e App IO sono due blu quasi identici): qui serve una
// palette categorica distinguibile anche con daltonismo.
export const CHART = {
  blue: '#2a78d6',
  orange: '#eb6834',
  aqua: '#1baf7a',
  yellow: '#eda100',
  magenta: '#e87ba4',
  green: '#008300',
  grey: '#94a3b8',
  /** Stato "critico" riservato ai fallimenti, mai usato come colore di serie. */
  critical: '#c0352b',
};
const CHANNEL_ORDER = ['EMAIL', 'PEC', 'APP_IO', 'SEND', 'POSTAL', 'CITIZEN_PORTAL'];
const CHANNEL_COLOR: Record<string, string> = {
  EMAIL: CHART.blue,
  PEC: CHART.orange,
  APP_IO: CHART.aqua,
  SEND: CHART.yellow,
  POSTAL: CHART.magenta,
  CITIZEN_PORTAL: CHART.green,
};
export const channelColor = (c: string) => CHANNEL_COLOR[(c || '').toUpperCase()] ?? CHART.grey;
export const channelRank = (c: string) => {
  const i = CHANNEL_ORDER.indexOf((c || '').toUpperCase());
  return i === -1 ? CHANNEL_ORDER.length : i;
};

// ─── Formattazione ───
const MONTHS_IT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
/** "2026-09" → "set 26" */
export const formatMonth = (ym: string) => {
  const [y, m] = ym.split('-');
  return `${MONTHS_IT[Number(m) - 1] ?? m} ${y?.slice(2)}`;
};
/** "2026-09-24" → "24 set" */
export const formatDay = (ymd: string) => {
  const [, m, d] = ymd.split('-');
  return `${Number(d)} ${MONTHS_IT[Number(m) - 1] ?? m}`;
};
const nf = new Intl.NumberFormat('it-IT', { useGrouping: true });
export const fmt = (n: number) => nf.format(n);
export const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);
export const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;
export const iso = (d: Date) => d.toISOString().slice(0, 10);
