import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import { Bank } from '../server/domain';
import { createApp } from '../server/app';
import { isStreamMessage, type StreamMessage } from '../shared/contracts';

const origin = 'http://127.0.0.1:3000';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture(options: ConstructorParameters<typeof Bank>[0] = {}) {
  const bank = new Bank(options);
  const credentials = bank.seed();
  const runtime = createApp(bank, { tickMs: 50, log: () => {} });
  cleanup.push(runtime.close);
  return { bank, credentials, runtime };
}

async function login(
  runtime: ReturnType<typeof createApp>,
  credentials: { username: string; password: string }[],
  username = 'alice',
) {
  const user = credentials.find((entry) => entry.username === username)!;
  const response = await request(runtime.app)
    .post('/api/login')
    .set('Origin', origin)
    .send(user)
    .expect(200);
  return cookieHeaders(response.headers['set-cookie'])[0]!.split(';')[0]!;
}

function cookieHeaders(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every((item: unknown) => typeof item === 'string')
  ) {
    throw new Error('Session cookie headers missing');
  }
  return value;
}

async function openStream(server: Server, cookie: string, lastEventId?: string) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server address unavailable');
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
    headers: { Cookie: cookie, ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  if (!response.body) throw new Error('No stream body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function next(
    predicate: (message: StreamMessage) => boolean = () => true,
  ): Promise<StreamMessage> {
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const message: unknown = JSON.parse(frame.replace(/^data: /, ''));
          if (!isStreamMessage(message)) throw new Error('Invalid stream contract');
          if (predicate(message)) return message;
        } else {
          const result = await reader.read();
          if (result.done) throw new Error('Stream ended before expected message');
          buffer += decoder.decode(result.value, { stream: true });
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  return { next, close: () => controller.abort() };
}

async function listen(runtime: ReturnType<typeof createApp>) {
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        runtime.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return server;
}

describe('HTTP boundaries', () => {
  it('validates input types, lengths, JSON objects, and boolean controls', async () => {
    const { runtime, credentials } = fixture();
    for (const body of [
      [],
      { username: 1, password: 'synthetic' },
      { username: 'alice', password: false },
      { username: 'x'.repeat(65), password: 'synthetic' },
      { username: 'alice', password: 'x'.repeat(129) },
    ])
      await request(runtime.app).post('/api/login').set('Origin', origin).send(body).expect(400);
    const cookie = await login(runtime, credentials);
    await request(runtime.app)
      .post('/api/demo/source')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ available: 'false' })
      .expect(400);
    await request(runtime.app)
      .post('/api/demo/account-failure')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ accountId: 'sav-alice', failed: 1 })
      .expect(400);
  });
  it('requires authentication on every protected API surface', async () => {
    const { runtime } = fixture();
    for (const path of ['/api/balances', '/api/events', '/api/session']) {
      await request(runtime.app).get(path).expect(401);
    }
    for (const [path, body] of [
      ['/api/activity', {}],
      ['/api/demo/balance', { accountId: 'sav-alice', amount: '1.00' }],
      ['/api/demo/account-failure', { accountId: 'sav-alice', failed: true }],
      ['/api/demo/revoke', { accountId: 'sav-alice' }],
      ['/api/demo/source', { available: false }],
      ['/api/demo/session-outage', {}],
    ] as const)
      await request(runtime.app).post(path).set('Origin', origin).send(body).expect(401);
  });
  it('applies rate limits through HTTP and keeps credential errors generic', async () => {
    const { runtime } = fixture();
    for (let i = 0; i < 5; i++) {
      const result = await request(runtime.app)
        .post('/api/login')
        .set('Origin', origin)
        .send({ username: 'alice', password: 'wrong' })
        .expect(401);
      expect(result.body.error).toBe('Invalid username or password.');
    }
    await request(runtime.app)
      .post('/api/login')
      .set('Origin', origin)
      .send({ username: 'alice', password: 'wrong' })
      .expect(429);
    const unknown = await request(runtime.app)
      .post('/api/login')
      .set('Origin', origin)
      .send({ username: 'unknown', password: 'wrong' })
      .expect(401);
    expect(unknown.body.error).toBe('Invalid username or password.');
  });
  it('distinguishes session-service failure from invalid credentials and unconfirmed logout', async () => {
    const { runtime, bank, credentials } = fixture();
    const cookie = await login(runtime, credentials);
    bank.setSessionAvailable(false);
    const user = credentials.find((entry) => entry.username === 'alice')!;
    await request(runtime.app).post('/api/login').set('Origin', origin).send(user).expect(503);
    const result = await request(runtime.app)
      .post('/api/logout')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({})
      .expect(503);
    expect(result.body.error).toContain('Logout not confirmed');
    expect(result.headers['set-cookie']).toBeUndefined();
    await request(runtime.app).get('/api/balances').set('Cookie', cookie).expect(503);
  });
  it('returns safe 500 errors rather than leaking unexpected internal diagnostics', async () => {
    const { runtime, bank, credentials } = fixture();
    const cookie = await login(runtime, credentials);
    const spy = vi.spyOn(bank, 'snapshot').mockImplementation(() => {
      throw new Error('internal-sensitive-diagnostic');
    });
    try {
      const result = await request(runtime.app)
        .get('/api/balances')
        .set('Cookie', cookie)
        .expect(500);
      expect(result.body.error).toBe('Unexpected server error.');
      expect(JSON.stringify(result.body)).not.toContain('internal-sensitive-diagnostic');
    } finally {
      spy.mockRestore();
    }
  });
  it('handles unknown API routes and individually missing fields explicitly', async () => {
    const { runtime, credentials } = fixture();
    const missing = await request(runtime.app).get('/api/not-found').expect(404);
    expect(missing.body.error).toBe('API operation not found.');
    expect(missing.body.correlationId).toBeTypeOf('string');
    for (const body of [{ username: 'alice' }, { password: 'synthetic' }]) {
      await request(runtime.app).post('/api/login').set('Origin', origin).send(body).expect(400);
    }
    const cookie = await login(runtime, credentials);
    for (const body of [{ accountId: 'sav-alice' }, { amount: '1.00' }]) {
      await request(runtime.app)
        .post('/api/demo/balance')
        .set('Origin', origin)
        .set('Cookie', cookie)
        .send(body)
        .expect(400);
    }
    await request(runtime.app)
      .post('/api/demo/account-failure')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ accountId: 'sav-alice' })
      .expect(400);
  });
  it('requires authentication, validates inputs and rejects unapproved origins/hosts', async () => {
    const { runtime } = fixture();
    await request(runtime.app).get('/api/balances').expect(401);
    await request(runtime.app).post('/api/login').send({}).expect(403);
    await request(runtime.app).post('/api/login').set('Origin', origin).send({}).expect(400);
    await request(runtime.app)
      .post('/api/login')
      .set('Origin', 'http://evil.example')
      .send({})
      .expect(403);
    await request(runtime.app).get('/api/health').set('Host', 'evil.example').expect(403);
    const bad = await request(runtime.app)
      .post('/api/login')
      .set('Origin', origin)
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
    expect(bad.body.correlationId).toBeTypeOf('string');
    await request(runtime.app)
      .post('/api/login')
      .set('Origin', origin)
      .send({ username: 'alice', password: 'x'.repeat(5000) })
      .expect(413);
  });
  it('sets HttpOnly cookie, denies cross-customer data, expires server cookie and rotates sessions', async () => {
    const { runtime, credentials } = fixture();
    const old = await login(runtime, credentials);
    const user = credentials.find((entry) => entry.username === 'alice')!;
    const response = await request(runtime.app)
      .post('/api/login')
      .set('Origin', origin)
      .set('Cookie', old)
      .send(user)
      .expect(200);
    const headers = cookieHeaders(response.headers['set-cookie']);
    expect(headers.join()).toContain('HttpOnly');
    expect(headers.join()).toContain('SameSite=Strict');
    await request(runtime.app).get('/api/balances').set('Cookie', old).expect(401);
    const cookie = headers[0]!.split(';')[0]!;
    const balances = await request(runtime.app)
      .get('/api/balances')
      .set('Cookie', cookie)
      .expect(200);
    expect(balances.headers['cache-control']).toBe('no-store');
    expect(balances.body.accounts).toHaveLength(2);
    await request(runtime.app)
      .post('/api/demo/balance')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ accountId: 'sav-bob', amount: '1.00' })
      .expect(403);
    const logout = await request(runtime.app)
      .post('/api/logout')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({})
      .expect(200);
    expect(cookieHeaders(logout.headers['set-cookie']).join()).toContain('Max-Age=0');
    await request(runtime.app).get('/api/balances').set('Cookie', cookie).expect(401);
  });
  it('does not turn a failed account or failed source into an empty or zero result', async () => {
    const { runtime, bank, credentials } = fixture();
    const cookie = await login(runtime, credentials);
    await request(runtime.app)
      .post('/api/demo/account-failure')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ accountId: 'sav-alice', failed: true })
      .expect(204);
    const result = await request(runtime.app)
      .get('/api/balances')
      .set('Cookie', cookie)
      .expect(503);
    expect(result.body.accounts).toBeUndefined();
    bank.setSourceAvailable(false);
    await request(runtime.app).get('/api/balances').set('Cookie', cookie).expect(503);
  });
  it('never logs credentials, balances, or session secrets', async () => {
    const bank = new Bank();
    const credentials = bank.seed();
    const logs: Record<string, string | number>[] = [];
    const runtime = createApp(bank, { log: (event) => logs.push(event) });
    cleanup.push(runtime.close);
    const cookie = await login(runtime, credentials);
    await request(runtime.app).get('/api/balances').set('Cookie', cookie).expect(200);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(credentials[0]!.password);
    expect(serialized).not.toContain(cookie);
    expect(serialized).not.toContain('12500.00');
  });
});

describe('real-time snapshot protocol', () => {
  it('streams per-account failure status and restores it without hiding healthy accounts', async () => {
    const { runtime, credentials } = fixture();
    const cookie = await login(runtime, credentials);
    const stream = await openStream(await listen(runtime), cookie);
    await stream.next();
    await request(runtime.app)
      .post('/api/demo/account-failure')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ accountId: 'sav-alice', failed: true })
      .expect(204);
    const failed = await stream.next(
      (message) => message.kind === 'snapshot' && message.accounts[0]?.status === 'unavailable',
    );
    expect(failed.kind === 'snapshot' && failed.accounts[1]?.status).toBe('current');
    await request(runtime.app)
      .post('/api/demo/account-failure')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ accountId: 'sav-alice', failed: false })
      .expect(204);
    await stream.next(
      (message) =>
        message.kind === 'snapshot' &&
        message.accounts.every((account) => account.status === 'current'),
    );
  });
  it('prevents cross-customer failure/revocation and verifies quiet source progress', async () => {
    let now = 0;
    const { runtime, credentials } = fixture({ now: () => now });
    const cookie = await login(runtime, credentials);
    const stream = await openStream(await listen(runtime), cookie);
    const initial = await stream.next();
    now = 500;
    const verified = await stream.next(
      (message) =>
        message.kind === 'snapshot' &&
        message.verifiedAt !== (initial.kind === 'snapshot' ? initial.verifiedAt : ''),
    );
    expect(verified.kind === 'snapshot' && verified.accounts[0]?.changedAt).toBe(
      initial.kind === 'snapshot' ? initial.accounts[0]?.changedAt : '',
    );
    await request(runtime.app)
      .post('/api/demo/revoke')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ accountId: 'sav-bob' })
      .expect(403);
    await request(runtime.app)
      .post('/api/demo/account-failure')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ accountId: 'sav-bob', failed: true })
      .expect(403);
    await request(runtime.app)
      .post('/api/demo/revoke')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ accountId: 'sav-alice' })
      .expect(204);
    await stream.next((message) => message.kind === 'snapshot' && message.accounts.length === 1);
  });
  it('exercises mock source and session outages through their API controls and recovers', async () => {
    const { runtime, credentials } = fixture();
    const cookie = await login(runtime, credentials);
    const stream = await openStream(await listen(runtime), cookie);
    await stream.next();
    await request(runtime.app)
      .post('/api/demo/source')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ available: false })
      .expect(204);
    await stream.next((message) => message.kind === 'unavailable');
    await request(runtime.app)
      .post('/api/demo/source')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ available: true })
      .expect(204);
    await stream.next((message) => message.kind === 'snapshot');
    await request(runtime.app)
      .post('/api/demo/session-outage')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({})
      .expect(204);
    await stream.next((message) => message.kind === 'session-ended');
    await request(runtime.app).get('/api/session').set('Cookie', cookie).expect(503);
    await new Promise((resolve) => setTimeout(resolve, 5100));
    await request(runtime.app).get('/api/session').set('Cookie', cookie).expect(200);
  });
  it('disconnects a backpressured stream and removes its listener', async () => {
    const { runtime, bank, credentials } = fixture();
    const cookie = await login(runtime, credentials);
    const server = await listen(runtime);
    server.prependListener('request', (_req, res) => {
      vi.spyOn(res, 'write').mockReturnValue(false);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server address unavailable');
    await expect(
      fetch(`http://127.0.0.1:${address.port}/api/events`, { headers: { Cookie: cookie } }).then(
        (res) => res.text(),
      ),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bank.listeners.size).toBe(0);
  });
  it('delivers correct updates within 1 second to 10 sessions, and resnapshots on reconnect', async () => {
    const { runtime, bank, credentials } = fixture();
    const server = await listen(runtime);
    const cookies = await Promise.all(
      Array.from({ length: 10 }, () => login(runtime, credentials)),
    );
    const streams = await Promise.all(cookies.map((cookie) => openStream(server, cookie)));
    await Promise.all(streams.map((stream) => stream.next()));
    const id = cookies[0]!.split('=')[1]!;
    const start = performance.now();
    bank.setBalance(id, 'sav-alice', '-123.45');
    const updates = await Promise.all(
      streams.map((stream) =>
        stream.next(
          (message) => message.kind === 'snapshot' && message.accounts[0]?.amount === '-123.45',
        ),
      ),
    );
    expect(performance.now() - start).toBeLessThanOrEqual(1000);
    for (const update of updates) {
      expect(update.kind).toBe('snapshot');
      if (update.kind === 'snapshot') expect(update.accounts[0]?.version).toBe(8);
    }
    streams[0]!.close();
    const reconnected = await openStream(server, cookies[0]!, 'untrusted-bob-cursor');
    const snapshot = await reconnected.next();
    expect(snapshot.kind === 'snapshot' && snapshot.accounts[0]?.amount).toBe('-123.45');
  });
  it('signals outage within 5 seconds, recovers, and removes revoked accounts', async () => {
    const { runtime, bank, credentials } = fixture();
    const cookie = await login(runtime, credentials);
    const stream = await openStream(await listen(runtime), cookie);
    await stream.next();
    const start = performance.now();
    bank.setSourceAvailable(false);
    await stream.next((message) => message.kind === 'unavailable');
    expect(performance.now() - start).toBeLessThanOrEqual(5000);
    bank.setSourceAvailable(true);
    await stream.next((message) => message.kind === 'snapshot');
    bank.revokeAccount(cookie.split('=')[1]!, 'sav-alice');
    const removed = await stream.next(
      (message) => message.kind === 'snapshot' && message.accounts.length === 1,
    );
    expect(removed.kind === 'snapshot' && removed.accounts[0]?.id).toBe('chk-alice');
  });
  it('ends quiet streams at idle expiry without renewing activity', async () => {
    let now = 0;
    const { runtime, credentials } = fixture({ now: () => now, idleMs: 1000 });
    const cookie = await login(runtime, credentials);
    const stream = await openStream(await listen(runtime), cookie);
    await stream.next();
    now = 1000;
    await stream.next((message) => message.kind === 'session-ended');
  });
  it('ends active subscriptions on logout and session-store unavailability', async () => {
    const { runtime, bank, credentials } = fixture();
    const cookie = await login(runtime, credentials);
    const server = await listen(runtime);
    const stream = await openStream(server, cookie);
    await stream.next();
    bank.logout(cookie.split('=')[1]!);
    await stream.next((message) => message.kind === 'session-ended');
    const nextCookie = await login(runtime, credentials);
    const nextStream = await openStream(server, nextCookie);
    await nextStream.next();
    bank.setSessionAvailable(false);
    await nextStream.next((message) => message.kind === 'session-ended');
  });
});
