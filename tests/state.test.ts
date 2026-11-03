import { describe, expect, it } from 'vitest';
import { acceptSnapshot, formatAmount } from '../src/state';
import { isApiError, isSnapshot, isStreamMessage, type Snapshot } from '../shared/contracts';

const snapshot: Snapshot = {
  kind: 'snapshot',
  sourceEpoch: 'epoch-1',
  cursor: 10,
  verifiedAt: '2026-11-03T00:00:00Z',
  accounts: [
    {
      id: 'one',
      type: 'savings',
      label: 'Savings ...1234',
      currency: 'USD',
      balanceType: 'available',
      amount: '123.45',
      version: 15,
      changedAt: '2026-11-01T00:00:00Z',
      status: 'current',
    },
  ],
};
describe('client snapshot reconciliation', () => {
  it('rejects older cursors or versions without assuming consecutive versions', () => {
    expect(acceptSnapshot(snapshot, { ...snapshot, cursor: 9 })).toBe(snapshot);
    expect(
      acceptSnapshot(snapshot, {
        ...snapshot,
        accounts: [{ ...snapshot.accounts[0]!, version: 8 }],
      }),
    ).toBe(snapshot);
    const newer = {
      ...snapshot,
      cursor: 11,
      accounts: [{ ...snapshot.accounts[0]!, version: 22 }],
    };
    expect(acceptSnapshot(snapshot, newer)).toBe(newer);
  });

  describe('HTTP response contract validation', () => {
    it.each([
      null,
      {},
      '',
      { ...snapshot, accounts: null },
      { ...snapshot, accounts: [null] },
      { ...snapshot, accounts: [{ ...snapshot.accounts[0]!, amount: 123.45 }] },
      { ...snapshot, accounts: [{ ...snapshot.accounts[0]!, status: 'unknown' }] },
      { ...snapshot, verifiedAt: undefined },
    ])('rejects malformed initial balance responses: %j', (value) => {
      expect(isSnapshot(value)).toBe(false);
    });
    it('accepts valid populated/empty snapshots but not an error message as a snapshot', () => {
      expect(isSnapshot(snapshot)).toBe(true);
      expect(isSnapshot({ ...snapshot, accounts: [] })).toBe(true);
      expect(isSnapshot({ kind: 'unavailable', message: 'Source unavailable' })).toBe(false);
    });
    it('validates error bodies before displaying their messages', () => {
      expect(isApiError({ error: 'Source unavailable', correlationId: 'trace' })).toBe(true);
      expect(isApiError({})).toBe(false);
      expect(isApiError({ error: 500, correlationId: 'trace' })).toBe(false);
      expect(isApiError({ error: '', correlationId: 'trace' })).toBe(false);
    });
  });
  it('accepts a new source epoch and reconciles removal with a full snapshot', () => {
    const reset = { ...snapshot, sourceEpoch: 'epoch-2', cursor: 0 };
    expect(acceptSnapshot(snapshot, reset)).toBe(reset);
    expect(acceptSnapshot(snapshot, { ...snapshot, cursor: 11, accounts: [] }).accounts).toEqual(
      [],
    );
  });
  it('validates the wire shape and formats money without conversion to floating point', () => {
    expect(isStreamMessage(snapshot)).toBe(true);
    expect(isStreamMessage({ kind: 'snapshot', accounts: [] })).toBe(false);
    expect(isStreamMessage({ kind: 'unavailable', message: 'Failed' })).toBe(true);
    expect(formatAmount('9999999999.99')).toBe('9,999,999,999.99');
    expect(formatAmount('-1234.01')).toBe('-1,234.01');
  });
});
