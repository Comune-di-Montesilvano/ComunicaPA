/**
 * Suffissi che i software di firma (Dike, ArubaSign, …) aggiungono al nome
 * del PDF firmato. Al ricarico si tolgono per ritrovare il nome originale,
 * l'unico referenziato dal CSV della campagna (colonna allegato).
 */
export const SIGNED_SUFFIXES = ['-signed', '_signed', '.signed', '-firmato', '_firmato', ' (firmato)'] as const;

export interface MatchResult {
  matched: Array<{ uploaded: string; original: string }>;
  rejected: Array<{ file: string; reason: string }>;
}

function candidateOriginal(lowerName: string): string[] {
  const base = lowerName.slice(0, -'.pdf'.length);
  const out = [lowerName];
  for (const suffix of SIGNED_SUFFIXES) {
    if (base.endsWith(suffix)) out.push(`${base.slice(0, -suffix.length)}.pdf`);
  }
  return out;
}

/**
 * Abbina i file caricati dall'operatore agli allegati da firmare. Mai
 * indovinare: un file senza abbinamento certo viene rifiutato con il motivo,
 * mai salvato a caso. Ambigui (più file sullo stesso originale) tutti
 * rifiutati. Un originale già valido non si sovrascrive mai.
 */
export function matchSignedFiles(uploaded: string[], toSign: string[], alreadyValid: string[]): MatchResult {
  const toSignByLower = new Map(toSign.map((f) => [f.toLowerCase(), f]));
  const validByLower = new Map(alreadyValid.map((f) => [f.toLowerCase(), f]));
  const rejected: MatchResult['rejected'] = [];
  const byOriginal = new Map<string, string[]>();

  for (const file of uploaded) {
    const lower = file.toLowerCase();
    if (lower.endsWith('.p7m')) {
      rejected.push({ file, reason: 'Serve firma PAdES (PDF), non CAdES (.p7m)' });
      continue;
    }
    if (!lower.endsWith('.pdf')) {
      rejected.push({ file, reason: 'Non è un PDF' });
      continue;
    }
    const candidates = candidateOriginal(lower);
    const original = candidates.map((c) => toSignByLower.get(c)).find((o): o is string => !!o);
    if (original) {
      byOriginal.set(original, [...(byOriginal.get(original) ?? []), file]);
      continue;
    }
    if (candidates.some((c) => validByLower.has(c))) {
      rejected.push({ file, reason: 'Allegato già firmato validamente' });
      continue;
    }
    rejected.push({ file, reason: 'Nessun allegato da firmare con questo nome' });
  }

  const matched: MatchResult['matched'] = [];
  for (const [original, files] of byOriginal) {
    if (files.length === 1) {
      matched.push({ uploaded: files[0], original });
    } else {
      for (const file of files) rejected.push({ file, reason: `Più file per lo stesso allegato ${original}` });
    }
  }
  return { matched, rejected };
}
