/**
 * Oggetto per destinatario: se la campagna mappa una colonna CSV per
 * l'oggetto (channelConfig.csvMapping.subject) e la cella di quel
 * destinatario non è vuota, usa quel valore al posto del template generico
 * di campagna (es. tributi diversi nello stesso invio SEND). Pura, nessun
 * effetto se csvMapping.subject non è configurato — comportamento
 * invariato per gli altri canali, che non popolano mai quella chiave.
 */
export function resolveSubjectTemplate(
  campaign: { channelConfig: Record<string, unknown>; name: string },
  recipient: { extraData: Record<string, unknown> },
): string {
  const csvMapping = campaign.channelConfig['csvMapping'] as Record<string, unknown> | undefined;
  const subjectColumn = csvMapping?.['subject'] as string | undefined;
  const perRecipientSubject = subjectColumn ? (recipient.extraData[subjectColumn] as string | undefined) : undefined;
  if (perRecipientSubject && perRecipientSubject.trim()) return perRecipientSubject;
  return (campaign.channelConfig['subject'] as string) || campaign.name;
}
