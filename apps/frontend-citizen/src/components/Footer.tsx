import React from 'react';

interface FooterProps {
  entityName: string;
  logoUrl?: string | null;
  version?: string | null;
}

/** Footer istituzionale scuro (stile GovPay Interaction Layer). */
export function Footer({ entityName, logoUrl, version }: FooterProps): React.JSX.Element {
  return (
    <footer className="site-footer mt-auto">
      <div className="container">
        <div className="f-compact-row">
          <div className="f-left">
            {logoUrl ? (
              <img src={logoUrl} alt={entityName} className="stemma" />
            ) : (
              <i className="fas fa-landmark stemma" style={{ fontSize: '1.6rem', color: '#94a3b8' }} aria-hidden="true"></i>
            )}
            <div className="f-info">
              <div className="title">{entityName} <span style={{ color: '#64748b', fontWeight: 'normal', marginLeft: 4 }}>— ComunicaPA</span></div>
              <div className="sub">
                © {new Date().getFullYear()} Tutti i diritti riservati{version ? ` (${version})` : ''}
              </div>
            </div>
          </div>

          <div className="f-center">
            <span className="lbl">Servizi collegati</span>
            <div className="chips">
              <a href="https://ioapp.it" target="_blank" rel="noopener noreferrer" className="f-partner-link">
                <span className="f-partner-chip"><img src="https://ioapp.it/assets/IO_84d780c485.svg" alt="" width={12} height={12} /></span>
                App IO
              </a>
              <a href="https://www.notifichedigitali.it" target="_blank" rel="noopener noreferrer" className="f-partner-link">
                <span className="f-partner-chip"><img src="https://notifichedigitali.it/assets/logo_d7df1d4592.svg" alt="" width={12} height={12} /></span>
                SEND
              </a>
              <a href="https://www.pagopa.it" target="_blank" rel="noopener noreferrer" className="f-partner-link">
                <img src="https://www.pagopa.gov.it/assets/images/logo-pagopa-bianco.svg" alt="PagoPA" height={12} style={{ marginLeft: 4 }} />
              </a>
            </div>
          </div>

          <div className="f-right">
            <span className="lbl">Identità Digitale</span>
            <div className="links">
              <a href="https://www.spid.gov.it" target="_blank" rel="noopener noreferrer">Cos'è SPID</a>
              <span className="dot-sep">•</span>
              <a href="https://www.cartaidentita.interno.gov.it" target="_blank" rel="noopener noreferrer">Cos'è CIE</a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
