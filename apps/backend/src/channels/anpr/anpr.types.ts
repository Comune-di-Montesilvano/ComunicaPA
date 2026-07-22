export interface AnprComune {
  nomeComune?: string;
  codiceIstat?: string;
  siglaProvinciaIstat?: string;
  descrizioneLocalita?: string;
}

export interface AnprToponimo {
  specie?: string;
  denominazioneToponimo?: string;
}

export interface AnprNumeroCivico {
  numero?: string;
  lettera?: string;
}

export interface AnprIndirizzo {
  cap?: string;
  comune?: AnprComune;
  frazione?: string;
  toponimo?: AnprToponimo;
  numeroCivico?: AnprNumeroCivico;
}

export interface AnprLocalitaEstera {
  consolato?: { codiceConsolato?: string; descrizioneConsolato?: string };
  indirizzoEstero?: {
    cap?: string;
    localita?: { codiceStato?: string; descrizioneLocalita?: string; descrizioneStato?: string };
    toponimo?: { denominazione?: string; numeroCivico?: string };
  };
}

export interface AnprResidenza {
  tipoIndirizzo?: string;
  indirizzo?: AnprIndirizzo;
  localitaEstera?: AnprLocalitaEstera;
  dataDecorrenzaResidenza?: string;
  presso?: string;
}

export interface AnprGeneralita {
  codiceFiscale?: { codFiscale?: string; validitaCF?: string };
  cognome?: string;
  senzaCognome?: string;
  nome?: string;
  senzaNome?: string;
  sesso?: string;
  dataNascita?: string;
  senzaGiorno?: string;
  senzaGiornoMese?: string;
  luogoNascita?: { comune?: AnprComune; localita?: { descrizioneLocalita?: string; descrizioneStato?: string } };
  soggettoAIRE?: string;
  annoEspatrio?: string;
}

/** Coppia chiave/valore generica usata da ANPR C002 per dati non modellati come campo dedicato (es. esistenza in vita, domicilio digitale). */
export interface AnprInfoSoggettoEnte {
  chiave?: string;
  valore?: 'A' | 'N' | 'S';
  valoreTesto?: string;
  valoreData?: string;
  dettaglio?: string;
}

export interface AnprResidenzaResult {
  found: boolean;
  data?: {
    idANPR?: string;
    generalita: AnprGeneralita;
    residenza: AnprResidenza[];
    infoSoggettoEnte: AnprInfoSoggettoEnte[];
  };
}

export interface AnprEsistenzaInVitaResult {
  found: boolean;
  data?: {
    idANPR?: string;
    generalita: AnprGeneralita;
    esistenzaInVita?: 'S' | 'N';
    dataDecesso?: string;
  };
}
