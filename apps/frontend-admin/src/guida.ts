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

// Sezioni di secondo livello, per l'indice in cima alla vista.
export function guidaSections(markdown: string): Array<{ id: string; title: string }> {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => {
      const title = line.slice(3).trim();
      return { id: guidaSlug(title), title };
    });
}

// Sezione della guida aperta dal bottone "?" della topbar, per vista.
// Le viste senza voce aprono la guida dall'inizio.
export const GUIDA_PER_VISTA: Record<string, string> = {
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
export const GUIDA_WIZARD_MASSIVO = 'lanciare-un-invio-massivo-da-file-csv';
