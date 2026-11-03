import { describe, expect, it } from 'vitest';
import { Bank, DomainError } from '../server/domain';

function fixture(options: ConstructorParameters<typeof Bank>[0] = {}) {
  const bank = new Bank(options);
  const credentials = bank.seed();
  const alice = credentials.find((entry) => entry.username === 'alice')!;
  const id = bank.login(alice.username, alice.password);
  return { bank, credentials, id };
}

describe('authentication and lifecycle', () => {
  it('prevents reseeding and uses new source epochs for independent mock processes', () => {
    const { bank } = fixture();
    expect(() => bank.seed()).toThrow('already initialized');
    expect(new Bank().sourceEpoch).not.toBe(bank.sourceEpoch);
  });
  it('generates distinct credentials; rejects valid-user and unknown-user mistakes equivalently', () => {
    const { bank, credentials } = fixture();
    expect(new Set(credentials.map((user) => user.password)).size).toBe(3);
    expect(() => bank.login('alice', 'wrong')).toThrow('Invalid username or password.');
    expect(() => bank.login('unknown', 'wrong')).toThrow('Invalid username or password.');
  });
  it('limits attempts and expires the limiter', () => {
    let now = 0;
    const { bank } = fixture({ now: () => now });
    for (let i = 0; i < 5; i++) expect(() => bank.login('alice', 'wrong')).toThrow(DomainError);
    expect(() => bank.login('alice', 'wrong')).toThrow('Too many attempts');
    now = 60_001;
    expect(() => bank.login('alice', 'wrong')).toThrow('Invalid username');
  });
  it('expires at the exact idle threshold; snapshots never extend activity', () => {
    let now = 0;
    const { bank, id } = fixture({ now: () => now, idleMs: 1000 });
    now = 999;
    bank.snapshot(id);
    now = 1000;
    expect(() => bank.snapshot(id)).toThrow('Session ended');
  });
  it('extends idle expiry only on activity and enforces absolute expiry', () => {
    let now = 0;
    const { bank, id } = fixture({ now: () => now, idleMs: 1000, absoluteMs: 2000 });
    now = 900;
    bank.session(id, true);
    now = 1800;
    bank.session(id, true);
    now = 2000;
    expect(() => bank.session(id)).toThrow('Session ended');
  });
  it('revokes logout and fails closed when sessions cannot be verified', () => {
    const { bank, id } = fixture();
    bank.setSessionAvailable(false);
    expect(() => bank.snapshot(id)).toThrow('Session validity cannot be verified');
    expect(() => bank.logout(id)).toThrow('Logout not confirmed');
    bank.setSessionAvailable(true);
    bank.logout(id);
    expect(() => bank.snapshot(id)).toThrow('Session ended');
  });
  it('sweeps expired sessions and resets attempt state after expiry', () => {
    let now = 0;
    const { bank, id, credentials } = fixture({ now: () => now, idleMs: 1000 });
    for (let i = 0; i < 5; i++) expect(() => bank.login('alice', 'wrong')).toThrow();
    now = 60_001;
    bank.sweep();
    expect(bank.sessions.has(id)).toBe(false);
    const user = credentials.find((entry) => entry.username === 'alice')!;
    expect(() => bank.login(user.username, user.password)).not.toThrow();
  });
});

describe('authoritative synthetic balances', () => {
  it('normalizes negative zero and forbids fixture mutation during source/account outages', () => {
    const { bank, id } = fixture();
    bank.setBalance(id, 'sav-alice', '-0.00');
    expect(bank.snapshot(id).accounts[0]?.amount).toBe('0.00');
    bank.setSourceAvailable(false);
    expect(() => bank.setBalance(id, 'sav-alice', '1.00')).toThrow('source unavailable');
    bank.setSourceAvailable(true);
    bank.setAccountFailure(id, 'sav-alice', true);
    expect(() => bank.setBalance(id, 'sav-alice', '1.00')).toThrow('source unavailable');
  });
  it('returns only owned savings/checking and a genuine empty collection', () => {
    const { bank, id, credentials } = fixture();
    expect(bank.snapshot(id).accounts.map((account) => account.type)).toEqual([
      'savings',
      'checking',
    ]);
    const empty = credentials.find((entry) => entry.username === 'empty')!;
    expect(bank.snapshot(bank.login(empty.username, empty.password)).accounts).toEqual([]);
    expect(() => bank.setBalance(id, 'sav-bob', '0.00')).toThrow('Account access denied');
  });
  it('preserves exact positive, negative and zero amounts without floating-point arithmetic', () => {
    const { bank, id } = fixture();
    for (const amount of ['9999999999.99', '-0.01', '0.00']) {
      bank.setBalance(id, 'sav-alice', amount);
      expect(bank.snapshot(id).accounts[0]?.amount).toBe(amount);
    }
    for (const amount of ['1.001', 'NaN', '1e2', '01.00', '10000000000.00']) {
      expect(() => bank.setBalance(id, 'sav-alice', amount)).toThrow('exact USD amount');
    }
    expect(bank.snapshot(id).accounts[0]?.version).toBe(22);
  });
  it('fails the complete initial snapshot, but streams explicit per-account unavailability', () => {
    const { bank, id } = fixture();
    bank.setAccountFailure(id, 'sav-alice', true);
    expect(() => bank.snapshot(id)).toThrow('complete snapshot');
    const partial = bank.snapshot(id, true);
    expect(partial.accounts.map((account) => account.status)).toEqual(['unavailable', 'current']);
    expect(partial.accounts[0]?.amount).toBe('12500.00');
    bank.setAccountFailure(id, 'sav-alice', false);
    expect(bank.snapshot(id).accounts[0]?.status).toBe('current');
  });
  it('verifies quiet accounts separately from their last balance change; signals source failure', () => {
    let now = 0;
    const { bank, id } = fixture({ now: () => now });
    now = 500;
    const snapshot = bank.snapshot(id);
    expect(snapshot.verifiedAt).not.toBe(snapshot.accounts[0]?.changedAt);
    bank.setSourceAvailable(false);
    expect(() => bank.snapshot(id)).toThrow('not current');
    bank.setSourceAvailable(true);
    expect(bank.snapshot(id).accounts).toHaveLength(2);
  });
  it('removes revoked accounts and denies later account operations', () => {
    const { bank, id } = fixture();
    bank.revokeAccount(id, 'sav-alice');
    expect(bank.snapshot(id).accounts.map((account) => account.id)).toEqual(['chk-alice']);
    expect(() => bank.setBalance(id, 'sav-alice', '0.00')).toThrow('Account access denied');
  });
});
