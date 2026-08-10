import { ExternalApiClient } from './external-api-client.entity';

describe('ExternalApiClient', () => {
  it('ha i campi attesi con i default corretti prima del save', () => {
    const entity = new ExternalApiClient();
    entity.name = 'Comune X — sistema tributi';
    entity.apiKeyHash = 'a'.repeat(64);
    expect(entity.name).toBe('Comune X — sistema tributi');
    expect(entity.apiKeyHash).toHaveLength(64);
  });
});
