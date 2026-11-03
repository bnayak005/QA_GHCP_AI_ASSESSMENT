import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Bank, DomainError } from './domain.js';
import type { StreamMessage } from '../shared/contracts.js';

interface AppOptions {
  origins?: string[];
  tickMs?: number;
  log?: (event: Record<string, string | number>) => void;
}

type ApiResponse = Response<unknown, { correlationId: string }>;

function sessionId(req: Request): string {
  const match = /(?:^|;\s*)bank_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '');
  return match?.[1] ?? '';
}

function cookie(res: Response, value: string): void {
  res.cookie('bank_session', value, {
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
    path: '/',
    maxAge: value ? 8 * 60 * 60_000 : 0,
  });
}

function bodyObject(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new DomainError(400, 'A JSON object is required.');
  return { ...body };
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max)
    throw new DomainError(400, `${name} is required and must be at most ${max} characters.`);
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new DomainError(400, 'A boolean value is required.');
  return value;
}

export function createApp(bank: Bank, options: AppOptions = {}) {
  const app = express();
  const origins = options.origins ?? [
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ];
  const tickMs = options.tickMs ?? 1000;
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  const connections = new Set<Response>();
  app.disable('x-powered-by');
  app.use((req, res: ApiResponse, next) => {
    res.locals.correlationId = randomUUID();
    const start = Date.now();
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.on('finish', () => {
      const route: unknown = req.route;
      const routePath =
        route && typeof route === 'object' && 'path' in route && typeof route.path === 'string'
          ? route.path
          : 'unmatched';
      log({
        event: 'request',
        method: req.method,
        route: routePath,
        status: res.statusCode,
        elapsedMs: Date.now() - start,
        correlationId: res.locals.correlationId,
      });
    });
    const hostname = req.hostname;
    if (hostname !== 'localhost' && hostname !== '127.0.0.1')
      return next(new DomainError(403, 'Loopback host required.'));
    const origin = req.headers.origin;
    if (
      (origin && !origins.includes(origin)) ||
      (req.method !== 'GET' && req.method !== 'HEAD' && !origin)
    ) {
      return next(new DomainError(403, 'An approved same-origin request is required.'));
    }
    next();
  });
  app.use(express.json({ limit: '4kb' }));
  app.get('/api/health', (_req, res) =>
    res.json({ status: 'ok', mode: 'local-mock', sourceEpoch: bank.sourceEpoch }),
  );

  app.post('/api/login', (req, res) => {
    const body = bodyObject(req);
    const username = text(body.username, 'Username', 64);
    const password = text(body.password, 'Password', 128);
    const id = bank.login(username, password);
    const oldId = sessionId(req);
    if (oldId) bank.logout(oldId);
    cookie(res, id);
    res.json({ username });
  });

  app.post('/api/logout', (req, res) => {
    bank.logout(sessionId(req));
    cookie(res, '');
    res.json({ message: 'Signed out.' });
  });

  app.post('/api/activity', (req, res) => {
    bank.session(sessionId(req), true);
    res.sendStatus(204);
  });
  app.get('/api/session', (req, res) => {
    res.json({ username: bank.session(sessionId(req)).username });
  });

  app.get('/api/balances', (req, res) => res.json(bank.snapshot(sessionId(req))));

  app.get('/api/events', (req, res: ApiResponse) => {
    const id = sessionId(req);
    bank.session(id);
    res.set({
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    connections.add(res);
    let closed = false;
    const send = (message: StreamMessage) => {
      if (closed) return;
      // Never accumulate a slow client's financial snapshots in an unbounded queue.
      if (!res.write(`data: ${JSON.stringify(message)}\n\n`)) res.destroy();
    };
    const publish = () => {
      if (closed) return;
      try {
        bank.session(id);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        log({
          event: 'stream-session-ended',
          status: error.status,
          correlationId: res.locals.correlationId,
        });
        send({ kind: 'session-ended', message: error.message });
        res.end();
        return;
      }
      try {
        // In this synchronous mock, subscription registration and a complete source
        // read run in one turn; reconnect always resnapshots instead of replaying deltas.
        send(bank.snapshot(id, true));
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        log({
          event: 'stream-source-unavailable',
          status: error.status,
          correlationId: res.locals.correlationId,
        });
        send({ kind: 'unavailable', message: error.message });
      }
    };
    bank.listeners.add(publish);
    const timer = setInterval(publish, tickMs);
    res.on('close', () => {
      closed = true;
      clearInterval(timer);
      bank.listeners.delete(publish);
      connections.delete(res);
    });
    publish();
  });

  app.post('/api/demo/balance', (req, res) => {
    const body = bodyObject(req);
    bank.setBalance(
      sessionId(req),
      text(body.accountId, 'Account', 64),
      text(body.amount, 'Amount', 32),
    );
    res.sendStatus(204);
  });
  app.post('/api/demo/account-failure', (req, res) => {
    const body = bodyObject(req);
    bank.setAccountFailure(
      sessionId(req),
      text(body.accountId, 'Account', 64),
      boolean(body.failed),
    );
    res.sendStatus(204);
  });
  app.post('/api/demo/revoke', (req, res) => {
    bank.revokeAccount(sessionId(req), text(bodyObject(req).accountId, 'Account', 64));
    res.sendStatus(204);
  });
  app.post('/api/demo/source', (req, res) => {
    bank.session(sessionId(req));
    bank.setSourceAvailable(boolean(bodyObject(req).available));
    res.sendStatus(204);
  });
  app.post('/api/demo/session-outage', (req, res) => {
    bank.session(sessionId(req));
    bank.setSessionAvailable(false);
    res.sendStatus(204);
    // Recovery must not require the now unavailable mock session service.
    setTimeout(() => bank.setSessionAvailable(true), 5000).unref();
  });
  app.use('/api', (_req, _res, next) => next(new DomainError(404, 'API operation not found.')));
  app.use(express.static(path.resolve('dist/client'), { index: 'index.html' }));
  app.use((error: unknown, _req: Request, res: ApiResponse, _next: NextFunction) => {
    const tooLarge = error instanceof Error && 'type' in error && error.type === 'entity.too.large';
    const status =
      error instanceof DomainError
        ? error.status
        : tooLarge
          ? 413
          : error instanceof SyntaxError
            ? 400
            : 500;
    const message =
      error instanceof DomainError
        ? error.message
        : status === 413
          ? 'Request exceeds the 4 KB limit.'
          : status === 400
            ? 'Invalid JSON request.'
            : 'Unexpected server error.';
    log({
      event: 'request-error',
      status,
      correlationId: res.locals.correlationId,
      category: error instanceof Error ? error.name : 'Unknown',
    });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(status).json({ error: message, correlationId: res.locals.correlationId });
  });
  const sweep = setInterval(() => bank.sweep(), tickMs);
  sweep.unref();
  return {
    app,
    close() {
      clearInterval(sweep);
      for (const res of connections) res.destroy();
    },
  };
}
