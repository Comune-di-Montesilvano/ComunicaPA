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
export function splitDenominazione(
  fullName: string,
  abbreviations: DenominazioneAbbreviation[],
  maxPerLine = 44,
): { denominazione1: string; denominazione2?: string } {
  let text = fullName.trim();
  for (const { pattern, replacement } of abbreviations) {
    text = text.split(pattern).join(replacement);
  }
  text = text.trim();

  if (text.length <= maxPerLine) {
    return { denominazione1: text };
  }

  // Word-wrap: trova l'ultimo spazio entro maxPerLine per non spezzare una parola.
  let splitAt = text.lastIndexOf(' ', maxPerLine);
  if (splitAt <= 0) splitAt = maxPerLine; // parola singola più lunga del limite: taglio secco

  const denominazione1 = text.slice(0, splitAt).trim();
  const denominazione2 = text.slice(splitAt).trim().slice(0, maxPerLine);

  return { denominazione1, denominazione2: denominazione2 || undefined };
}
