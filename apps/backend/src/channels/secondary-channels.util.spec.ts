import { resolveSecondaryAppIoConfig } from './secondary-channels.util';

describe('resolveSecondaryAppIoConfig', () => {
  it('legge dal nuovo formato secondaryChannels quando presente', () => {
    const result = resolveSecondaryAppIoConfig({
      secondaryChannels: [
        { channel: 'APP_IO', mode: 'parallel', ioServiceId: 'svc-1', subjectOverride: 'Ciao', bodyOverride: 'Corpo IO' },
      ],
    });
    expect(result).toEqual({
      channel: 'APP_IO',
      mode: 'parallel',
      ioServiceId: 'svc-1',
      subjectOverride: 'Ciao',
      bodyOverride: 'Corpo IO',
    });
  });

  it('ignora entry di secondaryChannels per canali diversi da APP_IO', () => {
    const result = resolveSecondaryAppIoConfig({
      secondaryChannels: [{ channel: 'POSTAL', mode: 'parallel' }],
    });
    expect(result).toBeUndefined();
  });

  it('fa fallback al vecchio formato channelConfig.appIo se secondaryChannels è assente', () => {
    const result = resolveSecondaryAppIoConfig({
      appIo: { mode: 'exclusive', ioServiceId: 'svc-legacy' },
    });
    expect(result).toEqual({ mode: 'exclusive', ioServiceId: 'svc-legacy' });
  });

  it('ritorna undefined se non è configurato alcun canale secondario', () => {
    expect(resolveSecondaryAppIoConfig({})).toBeUndefined();
    expect(resolveSecondaryAppIoConfig(undefined)).toBeUndefined();
  });
});
