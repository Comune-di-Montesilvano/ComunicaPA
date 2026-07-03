import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController — version', () => {
  const controller = new AppController(new AppService());

  afterEach(() => {
    delete process.env['APP_VERSION'];
    delete process.env['LDAP_HOST'];
  });

  it('senza APP_VERSION → dev', () => {
    expect(controller.getVersion()).toEqual({ version: 'dev', isLdapMock: false });
  });

  it('con APP_VERSION → valore iniettato', () => {
    process.env['APP_VERSION'] = 'v0.5.0';
    expect(controller.getVersion()).toEqual({ version: 'v0.5.0', isLdapMock: false });
  });

  it('con LDAP_HOST=mock → isLdapMock: true', () => {
    process.env['LDAP_HOST'] = 'mock';
    expect(controller.getVersion()).toEqual({ version: 'dev', isLdapMock: true });
  });
});
