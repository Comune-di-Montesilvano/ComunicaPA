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
        <div className="f-top">
          <div className="f-ident">
            {logoUrl ? (
              <img src={logoUrl} alt={entityName} className="stemma" />
            ) : (
              <i className="fas fa-landmark stemma" style={{ fontSize: '2.2rem', color: '#94a3b8' }} aria-hidden="true"></i>
            )}
            <div>
              <div className="title">{entityName}</div>
              <div className="sub">
                ComunicaPA — Notifiche e comunicazioni istituzionali ai cittadini
              </div>
            </div>
          </div>
          <div className="f-help">
            <span className="f-help-lbl">Accesso</span>
            <span>Area riservata con identità digitale <strong style={{ color: '#fff' }}>SPID / CIE</strong></span>
          </div>
        </div>
      </div>
      <div className="f-bottom">
        <div className="container">
          <div>
            © {new Date().getFullYear()} {entityName} — ComunicaPA
            {version ? ` (${version})` : ''}
          </div>
          <div className="f-legal">
            <a href="https://www.spid.gov.it" target="_blank" rel="noopener noreferrer">Cos'è SPID</a>
            <a href="https://www.cartaidentita.interno.gov.it" target="_blank" rel="noopener noreferrer">Cos'è CIE</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
