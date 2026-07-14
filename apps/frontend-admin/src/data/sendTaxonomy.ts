// Tassonomia SEND ufficiale v2.5 — fonte:
// https://raw.githubusercontent.com/pagopa/devportal-docs-translations/a5e20810a6a3b0d6d733f955c4c3ff980e22b764/docs/3FyVXetkmOApT9WPTwPN/tassonomia-send.md
// Verificato 2026-07-14. Dato di riferimento statico: aggiornare a mano se
// pagopa pubblica nuove voci (nessuna chiamata di rete).

export interface SendTaxonomyEntry {
  code: string;
  entityType: string;
  title: string;
  description: string;
}

export const SEND_ENTITY_TYPES: { code: string; label: string }[] = [
  { code: '01', label: 'Comune' },
  { code: '02', label: 'Regioni ed Enti Regionali' },
  { code: '03', label: 'Riscossore' },
  { code: '04', label: 'Ministeri' },
  { code: '05', label: 'Previdenza' },
  { code: '06', label: 'Servizio Sanitario Nazionale' },
  { code: '07', label: 'Provincia' },
  { code: '08', label: "Università/ Scuola statale/ Altri Enti" },
  { code: '09', label: 'Camera di Commercio' },
  { code: '10', label: 'Ordine Professionale' },
  { code: '11', label: 'Gestore di Pubblico Servizio' },
  { code: '12', label: 'Società a Controllo Pubblico' },
];

export const SEND_TAXONOMY_CATALOG: SendTaxonomyEntry[] = [
  // 01 - Comune
  { code: '010101P', entityType: '01', title: 'Notifiche Violazioni al Codice della Strada', description: "Tutte le tipologie di comunicazioni/verbali/solleciti relative a violazione al CdS (divieto di sosta, autovelox, ztl etc...)" },
  { code: '010102P', entityType: '01', title: 'Notifiche Violazioni extra CdS', description: "Tutte le tipologie di comunicazioni relative a violazioni extra CdS (sanzioni ambientali, altre sanzioni amministrative etc...)" },
  { code: '010103N', entityType: '01', title: 'Notifiche Violazioni al Codice della Strada', description: "Tutte le tipologie di comunicazioni/verbali/solleciti relative a violazione al CdS (divieto di sosta, autovelox, ztl etc...)" },
  { code: '010104N', entityType: '01', title: 'Notifiche Violazioni extra CdS', description: "Tutte le tipologie di comunicazioni relative a violazioni extra CdS (sanzioni ambientali, altre sanzioni amministrative etc...)" },
  { code: '010201P', entityType: '01', title: 'Notifiche Riscossione Tributi con pagamento', description: "Tutte le tipologie di comunicazione associate ad un pagamento (es: accertamenti, solleciti etc...) relative a Tributi che l'Ente deve incassare dal cittadino/impresa (IMU, TASI, TARI, IDRICO etc...)" },
  { code: '010202N', entityType: '01', title: 'Notifiche Riscossione Tributi senza pagamento', description: "Tutte le tipologie di comunicazione che non prevedono un pagamento correlato (es: rettifica/annullamento dell'accertamento, atto di invito a comparire per accertamento con adesione, questionario e censimento lg. 147/2013, controllo su planimetria abitazione, revisione rendite catastali lg 336, stipula/cessazione contratto idrico, atto di messa in mora etc...) relative a Tributi che l'Ente incassa dal cittadino/impresa (IMU, TASI, TARI, IDRICO etc...)" },
  { code: '010301P', entityType: '01', title: 'Notifiche riscossione entrate patrimoniali con pagamento', description: 'Tutte le tipologie di comunicazione associate ad un pagamento (es. notifica/sollecito rata affitti) relative a entrate patrimoniali che l\'Ente incassa dal cittadino/impresa' },
  { code: '010302N', entityType: '01', title: 'Notifiche riscossione entrate patrimoniali senza pagamento', description: "Tutte le tipologie di comunicazione che non prevedono un pagamento correlato (es. rettifica annullamento, stipula, determinazione canone, richiesta dati reddituali, cessazione contratto etc..) relative ad entrate patrimoniali che l'Ente incassa dal cittadino/impresa" },
  { code: '010401P', entityType: '01', title: 'Notifiche per sollecito pagamento servizi scolastici', description: 'Tutte le tipologie di comunicazione relative al sollecito di pagamento servizi scolastici (es. mense, trasporto, rette, pre post scuola etc...)' },
  { code: '010401N', entityType: '01', title: 'Notifiche Atti Servizi Scolastici', description: 'Tutte le tipologie di comunicazione relative al sollecito di pagamento servizi scolastici (es. mense, trasporto, rette, pre post scuola etc...)' },
  { code: '010501N', entityType: '01', title: 'Notifiche comunicazioni VL relative ad ufficio anagrafe', description: 'Tutte le tipologie di provvedimenti e notifiche emessi da Ufficio Anagrafe vs. cittadini e imprese (es. provvedimento di irreperibilità, nomina presidente/scrutatore di seggio, convocazione per giuramento cittadinanza, accesso agli atti etc...)' },
  { code: '010601N', entityType: '01', title: 'Notifiche comunicazioni VL Ufficio Tecnico / SUAP', description: 'Tutte le tipologie di atti inviati a imprese/cittadini per procedimenti attivati c/o Ufficio Tecnico / SUAP (es. richiesta parere altri uffici, SCIA accoglimento/diniego, comunicazioni e autorizzazioni accoglimento/diniego etc...)' },
  { code: '010701P', entityType: '01', title: 'Ordinanze Comunali con pagamento', description: 'Notifica Ordinanza ingiunzione (es. sanzioni amministrative varie)' },
  { code: '010702N', entityType: '01', title: 'Ordinanze Comunali senza pagamento', description: 'Notifiche Ordinanze (es. ordinarie, per casi eccezionali di particolare gravità, contingibili e urgenti, etc...)' },
  { code: '010801N', entityType: '01', title: 'Comunicazioni relative a riscossioni coattive e ingiunzioni fiscali', description: 'Notifica atti relativi a procedimenti di riscossione coattiva / ingiunzioni fiscali (es. preavviso fermo amministrativo, preavviso iscrizione ipoteca, avviso di intimazione)' },
  { code: '010801P', entityType: '01', title: 'Comunicazioni relative a riscossioni coattive e ingiunzioni fiscali', description: 'Notifica atti relativi a procedimenti di riscossione coattiva / ingiunzioni fiscali (es. preavviso fermo amministrativo, preavviso iscrizione ipoteca, avviso di intimazione)' },
  { code: '010901N', entityType: '01', title: 'notifica delegazioni di pagamento a tesoriere', description: 'a notificare al tesoriere i documenti richiesti da cddpp' },
  { code: '011001N', entityType: '01', title: 'notifica atti di convocazione consiglio comunale', description: 'per notificare ai vari consiglieri comunali la convocazione del consiglio' },
  // 02 - Regioni ed Enti Regionali
  { code: '020101P', entityType: '02', title: 'Notifiche Riscossione Bollo non pagato', description: "Tutte le comunicazione associate ad un pagamento (es: accertamenti, solleciti etc...) relative al recupero dei Bolli non pagati degli anni precedenti che l'Ente deve incassare dal cittadino/impresa." },
  { code: '020401P', entityType: '02', title: 'Notifiche Istanze di diniego/accettazione esenzione', description: 'Tutte le comunicazioni, di diniego, di accettazione o di carenza di documentazione, che riguardano le istanze di esenzione per il pagamento del bollo auto presentate da soggetti ex art. 3, co.3, l. 104/92, invalide, etc...' },
  { code: '020402N', entityType: '02', title: 'Notifiche Istanze di diniego/accettazione esenzione', description: 'Tutte le comunicazioni, di diniego, di accettazione o di carenza di documentazione, che riguardano le istanze di esenzione per il pagamento del bollo auto presentate da soggetti ex art. 3, co.3, l. 104/92, invalide, etc...' },
  { code: '020403N', entityType: '02', title: 'Notifica Tasse per Sospensione Rivenditori', description: 'Tutte le comunicazioni che riguardano il contributo da versare in relazione alla sospensione del bollo auto per rivendita' },
  // 03 - Riscossore
  { code: '030101P', entityType: '03', title: 'Notifiche Riscossione Tributi con pagamento', description: "Tutte le tipologie di comunicazione associate ad un pagamento (es: accertamenti, solleciti etc...) relative a Tributi che l'Ente deve incassare dal cittadino/impresa (IMU, TASI, TARI, IDRICO etc...)" },
  { code: '030102N', entityType: '03', title: 'Notifiche Riscossione Tributi senza pagamento', description: "Tutte le tipologie di comunicazione che non prevedono un pagamento correlato relative a Tributi che l'Ente incassa dal cittadino/impresa (IMU, TASI, TARI, IDRICO etc...)" },
  { code: '030201P', entityType: '03', title: 'Notifiche riscossione entrate patrimoniali con pagamento', description: "Tutte le tipologie di comunicazione associate ad un pagamento (es. notifica/sollecito rata affitti, ICP, CANONE UNICO PATRIMONIALE, OCCUPAZIONE SUOLO PUBBLICO, etc...) relative a entrate patrimoniali che l'Ente incassa dal cittadino/impresa" },
  { code: '030202N', entityType: '03', title: 'Notifiche riscossione entrate patrimoniali senza pagamento', description: "Tutte le tipologie di comunicazione che non prevedono un pagamento correlato (es. rettifica annullamento, stipula, determinazione canone, richiesta dati reddituali, cessazione contratto etc..) relative a entrate patrimoniali che l'Ente incassa dal cittadino/impresa" },
  { code: '030301P', entityType: '03', title: 'Comunicazioni relative a riscossioni coattive e ingiunzioni fiscali', description: 'Tutte le tipologie di comunicazioni associate ad un pagamento che prevedono la notifica di atti relativi a procedimenti di riscossione coattiva / ingiunzioni fiscali' },
  { code: '030302N', entityType: '03', title: 'Comunicazioni relative a riscossioni coattive e ingiunzioni fiscali', description: 'Notifica atti relativi a procedimenti di riscossione coattiva / ingiunzioni fiscali' },
  { code: '030401P', entityType: '03', title: 'Comunicazioni relative a processi amministrativi di accesso agli atti', description: "Tutte le tipologie di comunicazioni associate ad un pagamento rispetto alla erogazione del servizio di accesso agli atti dell'Ente" },
  { code: '030402N', entityType: '03', title: 'Comunicazioni relative a processi amministrativi di accesso agli atti', description: "Notifiche di atti relativi a procedimenti relativi alla richiesta di accesso agli atti dell'Ente (conferma, diniego, rifiuto, etc...)" },
  { code: '030501N', entityType: '03', title: 'Comunicazioni relative ad ufficio SUAP e Commercio', description: 'Tutte le tipologie di comunicazioni associate ad un pagamento che prevedono la notifica di atti c/o ufficio tecnico (Richiesta parere altri uffici, SCIA - Accoglimento/Diniego, Comunicazioni, Accoglimento/Diniego Autorizzazioni, etc...)' },
  { code: '030601P', entityType: '03', title: 'Notifiche Riscossione Bollo non pagato', description: "Tutte le comunicazione associate ad un pagamento relative al recupero dei Bolli non pagati degli anni precedenti che l'Ente deve incassare dal cittadino/impresa." },
  // 04 - Ministeri
  { code: '040101N', entityType: '04', title: 'Notifica di concessione/diniego di cittadinanza', description: 'Notifiche di atti relativi a procedimenti inerenti a richieste di cittadinanza' },
  { code: '040201N', entityType: '04', title: 'Comunicazione di avvio del procedimento', description: 'Costituzione in mora – Comunicazione di avvio del procedimento' },
  // 05 - Previdenza
  { code: '050101P', entityType: '05', title: "Notifiche relative a Contributi verso l'ente previdenziale", description: "Notifiche relative a Contributi verso l'ente previdenziale (es. Riscatti, Ricongiunzione e Rendite, Versamenti Volontari, Lavoratori Domestici)" },
  { code: '050201N', entityType: '05', title: 'Notifiche dei Provvedimenti dei prodotti/servizi', description: 'Notifiche dei provvedimenti dei prodotti/servizi (es. Riscatti, Ricongiunzione e Rendite, Assegno di Inclusione, Supporto Formazione e Lavoro)' },
  { code: '050201P', entityType: '05', title: 'Notifiche dei Provvedimenti dei prodotti/servizi', description: 'Notifiche dei provvedimenti dei prodotti/servizi (es. Riscatti, Ricongiunzione e Rendite, Assegno di Inclusione, Supporto Formazione e Lavoro)' },
  { code: '050301N', entityType: '05', title: 'Notifiche dei provvedimenti di recupero indebiti', description: 'Notifiche dei provvedimenti di recupero indebiti da pensione, ammortizzatori sociali ed entrate' },
  { code: '050301P', entityType: '05', title: 'Notifiche dei provvedimenti di recupero indebiti', description: 'Notifiche dei provvedimenti di recupero indebiti da pensione, ammortizzatori sociali ed entrate' },
  { code: '050401P', entityType: '05', title: 'Notifiche dei provvedimenti di recupero del credito', description: "Notifiche dei provvedimenti di recupero del credito emessi dall'Istituto Previdenziale e riscossi dall'Agenzia delle entrate-Riscossione" },
  // 06 - Servizio Sanitario Nazionale
  { code: '060101P', entityType: '06', title: 'Notifiche relative al Pagamento nei confronti della Sanità', description: 'Tutte le tipologie di notifiche che riguardano il pagamento di una tassa per usufruire del servizio sanitario pubblico' },
  { code: '060201P', entityType: '06', title: 'Notifiche recupero crediti in seguito ad errate dichiarazioni di esenzione da reddito', description: 'Tutte le comunicazioni associate ad un pagamento, relative al recupero del ticket dovuto per le prestazioni di assistenza specialistica e/o farmaceutica fruite indebitamente' },
  // 07 - Provincia
  { code: '070101P', entityType: '07', title: 'Notifiche Violazioni al Codice della Strada', description: 'Tutte le tipologie di comunicazioni/verbali/solleciti relative a violazione al CdS in ambito provinciale (ex. autovelox, etc...)' },
  { code: '070201P', entityType: '07', title: 'Notifiche Violazioni extra CdS', description: 'Inviare le notifiche Extra Cds per le Province' },
  { code: '070202N', entityType: '07', title: 'Notifiche Violazioni extra CdS', description: 'Inviare le notifiche Extra Cds per le Province' },
  { code: '070301P', entityType: '07', title: 'Ordinanze Provinciali', description: 'Inviare le notifiche Extra Cds per le Province' },
  { code: '070302N', entityType: '07', title: 'Ordinanze Provinciali', description: 'Inviare le notifiche Extra Cds per le Province' },
  // 08 - Università/ Scuola statale/ Altri Enti
  { code: '080101N', entityType: '08', title: 'Revoca dei benefici per mancanza di requisiti', description: 'Comunicazione amministrativa di revoca per perdita dei requisiti di accesso ai benefici e richiesta di rientro delle somme percepite' },
  { code: '080102N', entityType: '08', title: 'Remissione del credito art. 1236 codice civile', description: "Sollecito a comunicare il Codice IBAN per l'accredito della Borsa di Studio a pena di remissione del credito in caso di inadempienza" },
  { code: '080201N', entityType: '08', title: 'Accertamento economico-patrimoniale', description: 'Comunicazione amministrativa di avvio procedimento per accertamento di sussistenza dei requisiti che danno diritto ai benefici concessi' },
  // 09 - Camera di Commercio
  { code: '090101P', entityType: '09', title: 'Servizio di notifiche digitali per Verbali e Ordinanze', description: 'Ingiungere gli importi dovuti a seguito di sanzioni amministrative (registro imprese e di altri organi accertatori)' },
  // 10 - Ordine Professionale
  { code: '100101P', entityType: '10', title: 'Tassa Iscrizione Annua', description: 'Tutte le tipologie di comunicazioni associate al pagamento della Tassa di Iscrizione Annua che prevedono la notifica di atti relativi ai procedimenti di riscossione' },
  { code: '100102N', entityType: '10', title: 'Tassa Iscrizione Annua', description: 'Tutte le tipologie di comunicazioni associate alla Tassa di Iscrizione Annua' },
  { code: '100103P', entityType: '10', title: "Notifiche relative al Pagamento nei confronti dell'Ordine", description: 'Tutte le tipologie di comunicazioni associate ad un pagamento che prevedono la notifica di atti relativi a procedimenti di riscossione (Decreti ingiuntivi, etc)' },
  { code: '100104N', entityType: '10', title: "Notifiche relative al Pagamento nei confronti dell'Ordine", description: 'Tutte le tipologie di comunicazioni associate ad un pagamento che prevedono la notifica di atti relativi a procedimenti di riscossione (Decreti ingiuntivi, etc)' },
  { code: '100105P', entityType: '10', title: 'Notifiche atti amministrativi/contabili', description: "Tutte le tipologie di comunicazioni associate ad un pagamento rispetto alla erogazione del servizio di accesso agli atti dell'Ente" },
  { code: '100106N', entityType: '10', title: 'Notifiche atti amministrativi', description: "Notifiche di atti relativi a procedimenti amministrativi dell'Ente (Rigetti, Cancellazioni, Sospensioni, Diffide, etc…)" },
  { code: '100107N', entityType: '10', title: 'Avviso Morosità', description: 'Comunicazione relativa al sollecito di pagamento della Tassa di Iscrizione annua (primo, secondo e terzo avviso)' },
  // 11 - Gestore di Pubblico Servizio
  { code: '110101P', entityType: '11', title: 'Solleciti di Pagamento', description: 'Tutte le tipologie di sollecito clienti morosi' },
  // 12 - Società a Controllo Pubblico
  { code: '120101P', entityType: '12', title: 'Notifica Avviso di Pagamento', description: 'avviso di pagamento di una rata del finanziamento/contributo concesso' },
  { code: '120102P', entityType: '12', title: 'Notifica Solleciti di Pagamento', description: 'Sollecito avviso di pagamento di una o più rate scadute del finanziamento/contributo concesso' },
  { code: '120103P', entityType: '12', title: 'Notifica Atto di Ingiunzione', description: "Atto di ingiunzione alla restituzione del finanziamento e/o contributo concesso qualora l'intero ammontare non sia stato restituito a seguito di revoca nei tempi stabiliti" },
];
