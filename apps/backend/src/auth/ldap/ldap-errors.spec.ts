import { createRequire } from 'node:module';
import { describeLdapError, patchLdapjsDiagnosticMessage } from './ldap-errors.js';

// Il modulo errori che usa davvero il client ldapjs (non il re-export di `ldapjs`).
const require = createRequire(import.meta.url);
const ldapRequire = createRequire(require.resolve('ldapjs'));
const errors = ldapRequire('./errors') as { getError: (res: unknown) => Error };
const { LdapResult } = ldapRequire('@ldapjs/messages') as {
  LdapResult: new (opts: { status: number; diagnosticMessage?: string }) => unknown;
};

const AD_LOCKED = '80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 775, v4563';

describe('patchLdapjsDiagnosticMessage', () => {
  it('l\'errore del client porta il messaggio diagnostico di AD invece del generico', () => {
    patchLdapjsDiagnosticMessage();
    const err = errors.getError(new LdapResult({ status: 49, diagnosticMessage: AD_LOCKED }));
    expect(err.name).toBe('InvalidCredentialsError');
    expect(err.message).toBe(AD_LOCKED);
  });

  it('senza messaggio diagnostico resta il testo standard; applicarla due volte non cambia nulla', () => {
    patchLdapjsDiagnosticMessage();
    patchLdapjsDiagnosticMessage();
    expect(errors.getError(new LdapResult({ status: 49 })).message).toBe('Invalid Credentials');
  });
});

describe('describeLdapError', () => {
  it('traduce il sottocodice AD del bind', () => {
    const err = Object.assign(new Error(AD_LOCKED), { name: 'InvalidCredentialsError' });
    expect(describeLdapError(err)).toBe(`InvalidCredentialsError: ${AD_LOCKED} (AD: account bloccato)`);
    expect(describeLdapError(new Error('... data 52e, v4563'))).toContain('(AD: password errata)');
    expect(describeLdapError(new Error('... data 532, v4563'))).toContain('(AD: password scaduta)');
    expect(describeLdapError(new Error('... data 773, v4563'))).toContain('(AD: cambio password obbligatorio)');
  });

  it('senza sottocodice noto: solo l\'errore', () => {
    expect(describeLdapError(new Error('Invalid Credentials'))).toBe('Error: Invalid Credentials');
    expect(describeLdapError(new Error('... data 999, v1'))).toBe('Error: ... data 999, v1');
    expect(describeLdapError('timeout')).toBe('timeout');
  });
});
