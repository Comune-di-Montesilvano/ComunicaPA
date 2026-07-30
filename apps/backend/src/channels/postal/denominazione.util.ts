export interface DenominazioneAbbreviation {
  pattern: string;
  replacement: string;
}

/**
 * Applica una tabella di abbreviazioni (es. dicitura legale eredi troppo
 * lunga) e poi spezza il risultato su due righe ≤maxPerLine caratteri
 * ciascuna (WSDL GlobalCom InfoIndirizzoExt.Denominazione1/2, entrambe max
 * 44 char — vedi manuale tecnico §3.3.1). Word-wrap sull'ultimo spazio
 * utile: mai una parola spezzata a metà. Se anche dopo l'abbreviazione il
 * risultato eccede maxPerLine*2 caratteri totali, denominazione2 viene
 * troncata secca come ultima rete di sicurezza.
 */
/**
 * GlobalCom rifiuta l'apostrofo in Denominazione1/2 (e Indirizzo1/2, stessa
 * funzione riusata da postal.strategy.ts per l'indirizzo) — errore reale
 * riscontrato: "Errore nei dati del destinatario 0, D'ANGELO DAVIDE:
 * Caratteri non validi per D'ANGELO DAVIDE: `" (l'apostrofo compare
 * codificato come backtick nel messaggio d'errore lato loro). Non
 * documentato nel manuale/WSDL — scoperto solo dall'errore applicativo.
 * Rimosso (non sostituito con spazio) per restare il più vicino possibile
 * alla resa tipografica corretta del cognome.
 */
function stripInvalidGlobalComChars(text: string): string {
  return text.replace(/['’`´]/g, '');
}

export function splitDenominazione(
  fullName: string,
  abbreviations: DenominazioneAbbreviation[],
  maxPerLine = 44,
): { denominazione1: string; denominazione2?: string; truncated: boolean } {
  let text = stripInvalidGlobalComChars(fullName.trim());

  if (text.length > maxPerLine) {
    const safeAbbreviations: DenominazioneAbbreviation[] = Array.isArray(abbreviations)
      ? abbreviations.filter(
          (a): a is DenominazioneAbbreviation =>
            !!a && typeof a.pattern === 'string' && a.pattern.length > 0 && typeof a.replacement === 'string',
        )
      : [];
    for (const { pattern, replacement } of safeAbbreviations) {
      text = text.split(pattern).join(replacement);
    }
    text = text.trim();
  }

  if (text.length <= maxPerLine) {
    return { denominazione1: text, truncated: false };
  }

  // Word-wrap: trova l'ultimo spazio entro maxPerLine per non spezzare una parola.
  let splitAt = text.lastIndexOf(' ', maxPerLine);
  if (splitAt <= 0) splitAt = maxPerLine; // parola singola più lunga del limite: taglio secco

  const denominazione1 = text.slice(0, splitAt).trim();
  const remainder = text.slice(splitAt).trim();
  const denominazione2 = remainder.slice(0, maxPerLine);
  const truncated = remainder.length > maxPerLine;

  return { denominazione1, denominazione2: denominazione2 || undefined, truncated };
}
