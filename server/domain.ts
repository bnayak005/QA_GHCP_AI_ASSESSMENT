import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AccountView, Snapshot } from '../shared/contracts.js';

export class DomainError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface User {
  salt: Buffer;
  hash: Buffer;
}

interface Account extends AccountView {
  owner: string;
  failed: boolean;
}

export interface Session {
  username: string;
  createdAt: number;
  lastActivity: number;
}

export interface DomainOptions {
  now?: () => number;
  idleMs?: number;
  absoluteMs?: number;
}

export class Bank {
  readonly sourceEpoch = randomUUID();
  readonly sessions = new Map<string, Session>();
  readonly listeners = new Set<() => void>();
  readonly now: () => number;
  readonly idleMs: number;
  readonly absoluteMs: number;
  private users = new Map<string, User>();
  private accounts = new Map<string, Account>();
  private attempts = new Map<string, { count: number; until: number }>();
  private sourceAvailable = true;
  private sessionAvailable = true;
  private cursor = 0;
  private readonly dummySalt = randomBytes(16);
  private readonly dummyHash = scryptSync(randomBytes(24), this.dummySalt, 64);

  constructor(options: DomainOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 15 * 60_000;
    this.absoluteMs = options.absoluteMs ?? 8 * 60 * 60_000;
  }

  seed(): { username: string; password: string }[] {
    if (this.users.size > 0) throw new Error('Demo data already initialized');
    const credentials = ['alice', 'bob', 'empty'].map((username) => {
      const password = randomBytes(18).toString('base64url');
      const salt = randomBytes(16);
      this.users.set(username, { salt, hash: scryptSync(password, salt, 64) });
      return { username, password };
    });
    for (const [id, owner, type, amount] of [
      ['sav-alice', 'alice', 'savings', '12500.00'],
      ['chk-alice', 'alice', 'checking', '2340.75'],
      ['sav-bob', 'bob', 'savings', '500.00'],
    ] as const) {
      this.accounts.set(id, {
        id,
        owner,
        type,
        amount,
        currency: 'USD',
        balanceType: 'available',
        label: `${type === 'savings' ? 'Savings' : 'Checking'} ...${id === 'sav-alice' ? '1042' : id === 'chk-alice' ? '2086' : '3091'}`,
        version: 1,
        changedAt: new Date(this.now()).toISOString(),
        failed: false,
        status: 'current',
      });
    }
    return credentials;
  }

  login(username: string, password: string): string {
    if (!this.sessionAvailable) throw new DomainError(503, 'Session service unavailable.');
    const now = this.now();
    const key = username.toLowerCase();
    const attempt = this.attempts.get(key);
    if (attempt && attempt.until > now && attempt.count >= 5) {
      throw new DomainError(429, 'Too many attempts. Try again in one minute.');
    }
    const user = this.users.get(username);
    const candidate = scryptSync(password, user?.salt ?? this.dummySalt, 64);
    const matched = timingSafeEqual(candidate, user?.hash ?? this.dummyHash);
    if (!user || !matched) {
      this.attempts.set(key, {
        count: attempt && attempt.until > now ? attempt.count + 1 : 1,
        until: now + 60_000,
      });
      throw new DomainError(401, 'Invalid username or password.');
    }
    this.attempts.delete(key);
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { username, createdAt: now, lastActivity: now });
    return id;
  }

  session(id: string, touch = false): Session {
    if (!this.sessionAvailable)
      throw new DomainError(503, 'Session validity cannot be verified. Please sign in again.');
    const session = this.sessions.get(id);
    if (
      !session ||
      this.now() - session.lastActivity >= this.idleMs ||
      this.now() - session.createdAt >= this.absoluteMs
    ) {
      this.sessions.delete(id);
      throw new DomainError(401, 'Session ended. Please sign in again.');
    }
    if (touch) session.lastActivity = this.now();
    return session;
  }

  logout(id: string): void {
    if (!this.sessionAvailable)
      throw new DomainError(503, 'Logout not confirmed by the server. Your local view is cleared.');
    this.sessions.delete(id);
    this.notify();
  }

  snapshot(id: string, allowPartial = false): Snapshot {
    const session = this.session(id);
    if (!this.sourceAvailable)
      throw new DomainError(503, 'Balance source unavailable. Balances are not current.');
    const accounts: AccountView[] = [];
    for (const account of this.accounts.values()) {
      if (account.owner !== session.username) continue;
      if (account.failed && !allowPartial)
        throw new DomainError(
          503,
          'An account balance is unavailable. A complete snapshot cannot be verified.',
        );
      const { owner: _owner, failed: _failed, ...view } = account;
      accounts.push({ ...view, status: account.failed ? 'unavailable' : 'current' });
    }
    return {
      kind: 'snapshot',
      sourceEpoch: this.sourceEpoch,
      cursor: this.cursor,
      verifiedAt: new Date(this.now()).toISOString(),
      accounts,
    };
  }

  setBalance(id: string, accountId: string, amount: string): void {
    const account = this.authorize(id, accountId);
    if (!this.sourceAvailable || account.failed)
      throw new DomainError(503, 'Balance source unavailable.');
    if (!/^-?(?:0|[1-9]\d{0,9})\.\d{2}$/.test(amount)) {
      throw new DomainError(
        400,
        'Use an exact USD amount with two decimal places, up to 10 whole digits.',
      );
    }
    account.amount = amount === '-0.00' ? '0.00' : amount;
    account.version += 7;
    account.changedAt = new Date(this.now()).toISOString();
    this.cursor++;
    this.notify();
  }

  setAccountFailure(id: string, accountId: string, failed: boolean): void {
    this.authorize(id, accountId).failed = failed;
    this.notify();
  }

  revokeAccount(id: string, accountId: string): void {
    this.authorize(id, accountId);
    this.accounts.delete(accountId);
    this.cursor++;
    this.notify();
  }

  setSourceAvailable(available: boolean): void {
    this.sourceAvailable = available;
    this.notify();
  }

  setSessionAvailable(available: boolean): void {
    this.sessionAvailable = available;
    this.notify();
  }

  private authorize(id: string, accountId: string): Account {
    const session = this.session(id);
    const account = this.accounts.get(accountId);
    if (!account || account.owner !== session.username)
      throw new DomainError(403, 'Account access denied.');
    return account;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  sweep(): void {
    for (const [id, session] of this.sessions) {
      if (
        this.now() - session.lastActivity >= this.idleMs ||
        this.now() - session.createdAt >= this.absoluteMs
      ) {
        this.sessions.delete(id);
      }
    }
    for (const [key, attempt] of this.attempts)
      if (attempt.until <= this.now()) this.attempts.delete(key);
  }
}
