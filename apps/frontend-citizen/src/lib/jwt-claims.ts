export function decodeJwtClaims(token: string): { cf: string; name: string; provider?: string } {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return { cf: '', name: '' };
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (base64.length % 4)) % 4;
    const padded = base64 + '='.repeat(pad);
    
    // Decodifica UTF-8 sicura per atob
    const binStr = atob(padded);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    const jsonStr = new TextDecoder().decode(bytes);
    const payload = JSON.parse(jsonStr) as Record<string, unknown>;
    
    const rawCf = String(
      payload['fiscal_number'] ??
        payload['https://attributes.eid.gov.it/fiscal_number'] ??
        payload['https://attributes.spid.gov.it/fiscalNumber'] ??
        payload['codice_fiscale'] ??
        payload['cf'] ??
        payload['codiceFiscale'] ??
        payload['fiscalNumber'] ??
        payload['fiscalCode'] ??
        '',
    ).toUpperCase();
    const cf = rawCf.replace(/^TIN[A-Z]{2}-/, '');
    
    const given = String(
      payload['given_name'] ??
        payload['first_name'] ??
        payload['givenName'] ??
        '',
    );
    const family = String(
      payload['family_name'] ??
        payload['last_name'] ??
        payload['sn'] ??
        payload['surname'] ??
        payload['familyName'] ??
        '',
    );
    const name =
      (given && family)
        ? `${given} ${family}`
        : (String(payload['name'] ?? '') || [given, family].filter(Boolean).join(' '));
    
    // Rileva provider (SPID, CIE, eIDAS, IT-Wallet, ecc.)
    const amr = payload['amr'];
    let provider = 'Identità Digitale';
    if (payload['provider_name']) {
      provider = String(payload['provider_name']);
    } else if (amr) {
      const amrVal = Array.isArray(amr) ? amr[0] : amr;
      if (typeof amrVal === 'string') {
        const amrLower = amrVal.toLowerCase();
        if (amrLower.includes('cie') || amrLower.includes('interno.gov.it')) {
          provider = 'CIE';
        } else if (amrLower.includes('spid')) {
          provider = 'SPID';
        } else if (amrLower.includes('eidas')) {
          provider = 'eIDAS';
        } else if (amrLower.includes('wallet') || amrLower.includes('itwallet')) {
          provider = 'IT-Wallet';
        } else {
          provider = amrVal.toUpperCase();
        }
      }
    }
    
    return { cf, name, provider };
  } catch (e) {
    console.error('decodeJwtClaims error:', e);
    return { cf: '', name: '', provider: 'Identità Digitale' };
  }
}
