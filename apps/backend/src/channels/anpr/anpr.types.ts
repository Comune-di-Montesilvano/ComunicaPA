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
  codiceFiscale?: { codFiscale?: string };
  cognome?: string;
  nome?: string;
  dataNascita?: string;
}

export interface AnprResidenzaResult {
  found: boolean;
  data?: {
    idANPR?: string;
    generalita: AnprGeneralita;
    residenza: AnprResidenza[];
  };
}
