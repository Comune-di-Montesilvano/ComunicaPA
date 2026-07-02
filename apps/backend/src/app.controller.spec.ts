import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController — version', () => {
  const controller = new AppController(new AppService());

  afterEach(() => {
    delete process.env['APP_VERSION'];
  });

  it('senza APP_VERSION → dev', () => {
    expect(controller.getVersion()).toEqual({ version: 'dev' });
  });

  it('con APP_VERSION → valore iniettato', () => {
    process.env['APP_VERSION'] = 'v0.5.0';
    expect(controller.getVersion()).toEqual({ version: 'v0.5.0' });
  });
});
