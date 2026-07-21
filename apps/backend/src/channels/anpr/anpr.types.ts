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

export interface AnprResidenza {
  tipoIndirizzo?: string;
  indirizzo?: AnprIndirizzo;
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
