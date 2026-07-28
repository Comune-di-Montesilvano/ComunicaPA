import { RecipientStatus } from '../entities/recipient.entity';
import { classifyChannelOutcome } from './channel-outcome.util';

describe('classifyChannelOutcome', () => {
  it('primario riuscito, nessun appIo → primaryOnly', () => {
    expect(classifyChannelOutcome(RecipientStatus.SENT, {})).toBe('primaryOnly');
  });

  it('primario riuscito + appIo riuscito → both', () => {
    expect(classifyChannelOutcome(RecipientStatus.SENT, { appIo: { success: true } })).toBe('both');
  });

  it('consegnato SOLO via appIo esclusiva (deliveredVia) → appIoOnly', () => {
    expect(classifyChannelOutcome(RecipientStatus.SENT, { deliveredVia: 'APP_IO', appIo: { success: true } })).toBe('appIoOnly');
  });

  it('primario fallito ma appIo riuscito → appIoDespitePrimaryFail', () => {
    expect(classifyChannelOutcome(RecipientStatus.FAILED, { appIo: { success: true } })).toBe('appIoDespitePrimaryFail');
  });

  it('nessuno dei due riuscito → neither', () => {
    expect(classifyChannelOutcome(RecipientStatus.FAILED, {})).toBe('neither');
  });

  it('stato non classificabile (PENDING/QUEUED) → null', () => {
    expect(classifyChannelOutcome(RecipientStatus.PENDING, {})).toBeNull();
    expect(classifyChannelOutcome(RecipientStatus.QUEUED, null)).toBeNull();
  });
});
