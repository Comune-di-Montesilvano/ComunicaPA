import { Injectable } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService, type PdndEnvironment } from '../../pdnd/pdnd-auth.service';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error';

const REGISTRO_IMPRESE_BASE_URL: Record<PdndEnvironment, string> = {
  test: 'https://pdndcl.registroimprese.it',
  prod: 'https://pdnd.registroimprese.it',
};

export interface RegistroImpreseIndirizzo {
  comune?: string;
  provincia?: string;
  toponimo?: string;
  via?: string;
  nCivico?: string;
  cap?: string;
  frazione?: string;
}

export interface RegistroImpreseAtecoVoce {
  codice?: string;
  descrizione?: string;
  importanza?: string;
}

export interface RegistroImpresePersona {
  nome?: string;
  cognome?: string;
  cFiscale?: string;
  dataNascita?: string;
  rappresentante: boolean;
  cariche: string[];
}

export interface RegistroImpreseLocalizzazione {
  tipo?: string;
  sottoTipi: string[];
  dataApertura?: string;
  indirizzo?: RegistroImpreseIndirizzo;
  attivitaEsercitata?: string;
  ateco: RegistroImpreseAtecoVoce[];
}

export interface RegistroImpreseSocio {
  denominazione?: string;
  cFiscale?: string;
  diritto?: string;
}

export interface RegistroImpreseImpresaData {
  sede: {
    denominazione?: string;
    formaGiuridica?: string;
    cFiscale?: string;
    partitaIva?: string;
    cciaa?: string;
    nRea?: string;
    dtIscrizioneRi?: string;
    dtAttoCostituzione?: string;
    pec?: string;
    indirizzo?: RegistroImpreseIndirizzo;
  };
  attivita: {
    esercitata?: string;
    secondaria?: string;
    prevalente?: string;
    ateco: RegistroImpreseAtecoVoce[];
  };
  persone: RegistroImpresePersona[];
  localizzazioni: RegistroImpreseLocalizzazione[];
  soci: RegistroImpreseSocio[];
  statuto: {
    durataSocieta?: string;
    sistemaAmministrazione?: string;
    formeAmministrative: string[];
    collegioSindacale?: { effettivi?: string; supplenti?: string };
  };
  patrimonio?: {
    valuta?: string;
    deliberato?: string;
    sottoscritto?: string;
    versato?: string;
  };
}

export interface RegistroImpreseDettaglioResult {
  found: boolean;
  raw: string;
  pec?: string;
  denominazione?: string;
  data?: RegistroImpreseImpresaData;
}

/**
 * Integrazione Registro Imprese (PCAD-PDND, Unioncamere) — sostituisce
 * INIPEC come fonte del domicilio digitale d'impresa. Risposta XML (nessuno
 * schema nello spec OpenAPI, solo {type:"string"}) — struttura confermata con
 * chiamata reale del 2026-09-05 (vedi mapImpresaData sotto e
 * docs/superpowers/specs/2026-08-11-registro-imprese-pdnd-design.md).
 */
@Injectable()
export class RegistroImpreseService {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  async getVoucher(env: PdndEnvironment): Promise<string> {
    const purposeId = await this.settings.get<string>(`registroImprese.${env}.purposeId` as SettingKey);
    if (!purposeId) {
      throw new Error(`Configurazione Registro Imprese (${env}) incompleta: purposeId non impostato`);
    }
    return this.pdndAuth.getVoucher(env, purposeId);
  }

  async dettaglioImpresa(partitaIva: string, env: PdndEnvironment = 'prod'): Promise<RegistroImpreseDettaglioResult> {
    const voucher = await this.getVoucher(env);
    const url = `${REGISTRO_IMPRESE_BASE_URL[env]}/rest/pcad/v1/dettaglio/codicefiscale?codiceFiscale=${encodeURIComponent(partitaIva)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${voucher}` } });
    // response.text() decodifica UTF-8 di default — la risposta dichiara
    // encoding="windows-1252" nel prologo XML (confermato con chiamata
    // reale), un `response.text()` diretto storpia ogni carattere
    // accentato (es. "attivit�" invece di "attività"). Decodifica esplicita.
    const text = new TextDecoder('windows-1252').decode(await response.arrayBuffer());

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      throw new RegistroImpreseRateLimitError(retryAfterSeconds);
    }
    if (response.status === 404) {
      return { found: false, raw: text };
    }
    if (!response.ok) {
      throw new Error(`Registro Imprese dettaglio fallito: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }

    let data: RegistroImpreseImpresaData | undefined;
    try {
      data = parseDettaglioImpresaXml(text);
    } catch {
      // XML malformato/inatteso: found resta true (la chiamata HTTP è andata a
      // buon fine), ma nessun dato strutturato — raw resta comunque disponibile.
      data = undefined;
    }

    return { found: true, raw: text, pec: data?.sede.pec, denominazione: data?.sede.denominazione, data };
  }
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
});

/** fast-xml-parser restituisce un oggetto per un solo figlio, un array se ripetuto — normalizza sempre ad array. */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    const t = (value as Record<string, unknown>)['#text'];
    return typeof t === 'string' ? t.trim() || undefined : undefined;
  }
  return undefined;
}

function parseIndirizzo(el: any): RegistroImpreseIndirizzo | undefined {
  if (!el) return undefined;
  return {
    comune: el['@_comune'],
    provincia: el['@_provincia'],
    toponimo: el['@_toponimo'],
    via: el['@_via'],
    nCivico: el['@_n-civico'],
    cap: el['@_cap'],
    frazione: el['@_frazione'],
  };
}

function parseAteco(classificazioniEl: any): RegistroImpreseAtecoVoce[] {
  const voci = toArray(classificazioniEl?.['classificazione-ateco']);
  return voci.map((v: any) => ({
    codice: v['@_c-attivita'],
    descrizione: v['@_attivita'],
    importanza: v['@_importanza'],
  }));
}

function parsePersona(el: any): RegistroImpresePersona {
  const pf = el['persona-fisica'] ?? {};
  const cariche: string[] = [];
  for (const atto of toArray(el['atti-conferimento-cariche']?.['atto-conferimento-cariche'])) {
    for (const carica of toArray(atto?.cariche?.carica)) {
      const label = textOf(carica);
      if (label) cariche.push(label);
    }
  }
  return {
    nome: pf['@_nome'],
    cognome: pf['@_cognome'],
    cFiscale: pf['@_c-fiscale'],
    dataNascita: pf['estremi-nascita']?.['@_dt'],
    rappresentante: el['@_f-rappresentante-ri'] === 'S',
    cariche,
  };
}

function parseLocalizzazione(el: any): RegistroImpreseLocalizzazione {
  return {
    tipo: el['@_tipo'],
    sottoTipi: toArray(el['sotto-tipi']?.['sotto-tipo']).map((s: any) => textOf(s)).filter((s): s is string => !!s),
    dataApertura: el['@_dt-apertura'],
    indirizzo: parseIndirizzo(el['indirizzo-localizzazione']),
    attivitaEsercitata: textOf(el['attivita-esercitata']),
    ateco: parseAteco(el['classificazioni-ateco']),
  };
}

function parseSocio(el: any): RegistroImpreseSocio {
  const anagrafica = el['anagrafica-titolare'] ?? {};
  return {
    denominazione: anagrafica['@_denominazione'],
    cFiscale: anagrafica['@_c-fiscale'],
    diritto: el['diritto-partecipazione']?.['@_tipo'],
  };
}

/**
 * Mappa lo schema reale confermato con chiamata dal vivo (2026-09-05):
 *   <blocchi-impresa>
 *     <dati-identificativi denominazione="..." c-fiscale="..." ...>
 *       <indirizzo-posta-certificata>PEC</indirizzo-posta-certificata>
 *     </dati-identificativi>
 *     <info-attivita>...<classificazioni-ateco>...</info-attivita>
 *     <persone-sede><persona>...</persona></persone-sede>
 *     <localizzazioni><localizzazione>...</localizzazione></localizzazioni>
 *     <elenco-soci><riquadri><riquadro><titolari><titolare>...</titolare></titolari></riquadro></riquadri></elenco-soci>
 *     <info-statuto>...</info-statuto>
 *     <amministrazione-controllo>...</amministrazione-controllo>
 *     <info-patrimoniali-finanziarie><capitale-sociale>...</capitale-sociale></info-patrimoniali-finanziarie>
 *   </blocchi-impresa>
 * Ogni accesso è difensivo (campo assente ⇒ undefined) — lo schema non è
 * documentato nello spec OpenAPI, solo confermato empiricamente.
 */
function parseDettaglioImpresaXml(xml: string): RegistroImpreseImpresaData {
  const parsed = xmlParser.parse(xml);
  const root = parsed['blocchi-impresa'] ?? {};
  const identificativi = root['dati-identificativi'] ?? {};
  const infoAttivita = root['info-attivita'] ?? {};
  const statuto = root['info-statuto'] ?? {};
  const amministrazione = root['amministrazione-controllo'] ?? {};
  const patrimoniali = root['info-patrimoniali-finanziarie']?.['capitale-sociale'];

  return {
    sede: {
      denominazione: identificativi['@_denominazione'],
      formaGiuridica: textOf(identificativi['forma-giuridica']),
      cFiscale: identificativi['@_c-fiscale'],
      partitaIva: identificativi['@_partita-iva'],
      cciaa: identificativi['@_cciaa'],
      nRea: identificativi['@_n-rea'],
      dtIscrizioneRi: identificativi['@_dt-iscrizione-ri'],
      dtAttoCostituzione: identificativi['@_dt-atto-costituzione'],
      pec: textOf(identificativi['indirizzo-posta-certificata'])?.toLowerCase(),
      indirizzo: parseIndirizzo(identificativi['indirizzo-localizzazione']),
    },
    attivita: {
      esercitata: textOf(infoAttivita['attivita-esercitata']),
      secondaria: textOf(infoAttivita['attivita-secondaria-esercitata']),
      prevalente: textOf(infoAttivita['attivita-prevalente']),
      ateco: parseAteco(infoAttivita['classificazioni-ateco']),
    },
    persone: toArray(root['persone-sede']?.persona).map(parsePersona),
    localizzazioni: toArray(root['localizzazioni']?.localizzazione).map(parseLocalizzazione),
    soci: toArray(root['elenco-soci']?.riquadri?.riquadro).flatMap((r: any) => toArray(r?.titolari?.titolare).map(parseSocio)),
    statuto: {
      durataSocieta: statuto['durata-societa']?.['@_dt-termine'],
      sistemaAmministrazione: textOf(amministrazione['sistema-amministrazione']),
      formeAmministrative: toArray(amministrazione['forme-amministrative']?.['forma-amministrativa'])
        .map((f: any) => textOf(f))
        .filter((f): f is string => !!f),
      collegioSindacale: amministrazione['collegio-sindacale']
        ? {
            effettivi: amministrazione['collegio-sindacale']['@_n-effettivi'],
            supplenti: amministrazione['collegio-sindacale']['@_n-supplenti'],
          }
        : undefined,
    },
    patrimonio: patrimoniali
      ? {
          valuta: patrimoniali['@_valuta'],
          deliberato: patrimoniali['deliberato']?.['@_ammontare'],
          sottoscritto: patrimoniali['sottoscritto']?.['@_ammontare'],
          versato: patrimoniali['versato']?.['@_ammontare'],
        }
      : undefined,
  };
}
