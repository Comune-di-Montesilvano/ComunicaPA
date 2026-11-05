// Guida operatori: unica fonte in public/guida/guida.md, servita così com'è
// da /guida/guida.md (la legge anche CruscottoPA come guida GitHub) e resa
// nella vista "Guida". Le ancore sono quelle generate da rehype-slug
// (github-slugger) dentro MDEditor.Markdown: guidaSlug ne replica la regola
// per i titoli usati qui (lettere, numeri, spazi, punteggiatura semplice).
// scripts/check-guida.mjs verifica che ogni ancora citata nel codice esista.

export const GUIDA_URL = '/guida/guida.md';

export function guidaSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

// Titoli di secondo e terzo livello, per l'indice laterale della vista.
// Righe dentro i blocchi ``` ignorate: un "## " lì non è un titolo.
export function guidaSections(markdown: string): Array<{ id: string; title: string; level: 2 | 3 }> {
  const out: Array<{ id: string; title: string; level: 2 | 3 }> = [];
  let inCode = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inCode = !inCode;
    if (inCode) continue;
    const m = /^(##|###) (.+)$/.exec(line);
    if (!m) continue;
    const title = m[2].trim();
    out.push({ id: guidaSlug(title), title, level: m[1] === '##' ? 2 : 3 });
  }
  return out;
}

// Sezione della guida aperta dal bottone "?" della topbar, per vista.
// Le viste senza voce aprono la guida dall'inizio.
export const GUIDA_PER_VISTA: Record<string, string> = {
  dashboard: 'gestire-le-notifiche-senza-esito-legale',
  'invio-massivo': 'seguire-lo-stato-di-una-campagna',
  'campaign-detail': 'seguire-lo-stato-di-una-campagna',
  'notifiche-ricerca': 'cercare-una-singola-notifica',
  'cerca-domicilio': 'verificare-anagrafica-e-domicilio-digitale',
  'verifica-domicili': 'verificare-i-domicili-digitali-di-un-elenco',
  'template-dashboard': 'gestire-i-template',
  'arricchimento': 'convertire-un-tracciato-maggioli-in-csv',
  'impostazioni': 'impostazioni-solo-amministratori',
};

export const GUIDA_WIZARD_SINGOLO = 'inviare-una-comunicazione-a-pochi-destinatari';
// Link contestuali su date legali (dettaglio notifica, elenco destinatari) e
// su notifiche non consegnate/irreperibili (dettaglio, dashboard).
export const GUIDA_DATE_TERMINI = 'date-di-notifica-e-termini';
export const GUIDA_IRREPERIBILE = 'notifica-non-consegnata-o-destinatario-irreperibile';
export const GUIDA_WIZARD_MASSIVO = 'lanciare-un-invio-massivo-da-file-csv';
