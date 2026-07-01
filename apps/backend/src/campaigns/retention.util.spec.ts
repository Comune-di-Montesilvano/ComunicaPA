import { getEffectiveRetentionDays } from './retention.util';

describe('getEffectiveRetentionDays', () => {
  it('usa retentionDays della campagna se impostato', () => {
    expect(getEffectiveRetentionDays({ retentionDays: 30 }, 90)).toBe(30);
  });

  it('usa il default globale se retentionDays è null', () => {
    expect(getEffectiveRetentionDays({ retentionDays: null }, 90)).toBe(90);
  });

  it('non supera mai il default globale anche se la campagna chiede di più', () => {
    expect(getEffectiveRetentionDays({ retentionDays: 365 }, 90)).toBe(90);
  });
});
