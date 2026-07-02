import { assertProductionSecrets, DEFAULT_DOWNLOAD_LINK_SECRET } from './production-guards';

describe('assertProductionSecrets', () => {
  it('rifiuta il boot in produzione se il download-link secret è ancora il default', () => {
    expect(() => assertProductionSecrets('production', DEFAULT_DOWNLOAD_LINK_SECRET)).toThrow(
      /DOWNLOAD_LINK_SECRET/,
    );
  });

  it('rifiuta il boot in un ambiente arbitrario non-development col default', () => {
    expect(() => assertProductionSecrets('staging', DEFAULT_DOWNLOAD_LINK_SECRET)).toThrow();
  });

  it('consente il boot in development anche col default (dev locale/docker)', () => {
    expect(() => assertProductionSecrets('development', DEFAULT_DOWNLOAD_LINK_SECRET)).not.toThrow();
  });

  it('consente il boot in produzione con un segreto reale impostato', () => {
    expect(() => assertProductionSecrets('production', 'un-segreto-lungo-e-casuale-xyz')).not.toThrow();
  });
});
