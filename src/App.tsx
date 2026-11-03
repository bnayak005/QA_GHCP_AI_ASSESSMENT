import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  isApiError,
  isSnapshot,
  isStreamMessage,
  type Snapshot,
  type StreamMessage,
} from '../shared/contracts';
import { acceptSnapshot, formatAmount } from './state';

class RequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request(url: string, body?: object, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(
      url,
      body
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
          }
        : { cache: 'no-store', signal },
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error.name === 'AbortError') throw error;
    throw new RequestError(0, 'Connection unavailable. Please try again.');
  }
  if (response.status === 204) return;
  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (!(error instanceof SyntaxError)) throw error;
    throw new RequestError(
      response.ok ? 502 : response.status,
      'Server returned an invalid response. Please try again.',
    );
  }
  if (!response.ok) {
    throw new RequestError(
      response.status,
      isApiError(result)
        ? result.error
        : `Request failed (HTTP ${response.status}). Please try again.`,
    );
  }
  return result;
}

export function App() {
  const [username, setUsername] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [current, setCurrent] = useState(false);
  const [message, setMessage] = useState(
    'Sign in using the synthetic credentials printed in the server terminal.',
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const generation = useRef(0);
  const activeStream = useRef<EventSource | null>(null);
  const verified = useRef(0);
  const activeUser = useRef(false);
  const lastActivity = useRef(0);

  function clearSession(reason: string) {
    generation.current++;
    activeUser.current = false;
    activeStream.current?.close();
    activeStream.current = null;
    setUsername(null);
    setSnapshot(null);
    setAmounts({});
    setFailed({});
    setCurrent(false);
    setMessage(reason);
    setActionError(null);
    setBusy(false);
  }

  useEffect(() => {
    if (!username) return;
    const token = generation.current;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let disposed = false;
    let connectionGeneration = 0;
    let pendingRequest: AbortController | undefined;
    const valid = () => !disposed && generation.current === token;
    const active = (attempt: number) => valid() && connectionGeneration === attempt;
    function invalidateConnection() {
      connectionGeneration++;
      if (retry) clearTimeout(retry);
      retry = undefined;
      pendingRequest?.abort();
      pendingRequest = undefined;
      activeStream.current?.close();
      activeStream.current = null;
      return connectionGeneration;
    }
    function connect() {
      if (!valid()) return;
      const attempt = invalidateConnection();
      const stream = new EventSource('/api/events');
      activeStream.current = stream;
      stream.onmessage = (event: MessageEvent<string>) => {
        if (!active(attempt) || activeStream.current !== stream) return;
        let data: StreamMessage;
        try {
          const parsed: unknown = JSON.parse(event.data);
          if (!isStreamMessage(parsed))
            throw new Error('Update does not match the stream contract');
          data = parsed;
        } catch (error) {
          console.error('Invalid update payload', error);
          setCurrent(false);
          setMessage('Invalid update received. Reconnect to verify balances.');
          stream.close();
          return;
        }
        if (data.kind === 'session-ended') {
          clearSession(data.message);
          return;
        }
        if (data.kind === 'unavailable') {
          setCurrent(false);
          setMessage(data.message);
          return;
        }
        attempts = 0;
        verified.current = Date.now();
        setSnapshot((old) => acceptSnapshot(old, data));
        setCurrent(true);
        setMessage(
          data.accounts.some((account) => account.status === 'unavailable')
            ? 'An account source is unavailable. Its last-known amount is not current.'
            : 'Balances verified against the local mock source.',
        );
      };
      stream.onerror = () => {
        stream.close();
        if (!active(attempt) || activeStream.current !== stream) return;
        setCurrent(false);
        setMessage('Updates disconnected. Balances are not current; reconnecting.');
        const delay = Math.min(10_000, 500 * 2 ** Math.min(attempts++, 5)) + Math.random() * 250;
        retry = setTimeout(() => {
          void reconnect(attempt);
        }, delay);
      };
    }
    async function reconnect(attempt: number) {
      retry = undefined;
      if (!active(attempt)) return;
      const controller = new AbortController();
      pendingRequest = controller;
      try {
        // Distinguish terminal session errors from a temporarily unhealthy balance source.
        await request('/api/session', undefined, controller.signal);
        if (active(attempt)) connect();
      } catch (error) {
        if (!active(attempt) || controller.signal.aborted) return;
        if (error instanceof RequestError && (error.status === 401 || error.status === 503))
          clearSession(error.message);
        else {
          setMessage(error instanceof Error ? error.message : 'Reconnect failed.');
          connect();
        }
      } finally {
        if (pendingRequest === controller) pendingRequest = undefined;
      }
    }
    async function initialize() {
      const attempt = connectionGeneration;
      const controller = new AbortController();
      pendingRequest = controller;
      try {
        const initial = await request('/api/balances', undefined, controller.signal);
        if (!active(attempt)) return;
        if (!isSnapshot(initial))
          throw new RequestError(502, 'Invalid balance response. Balances could not be verified.');
        setSnapshot(initial);
      } catch (error) {
        if (!active(attempt) || controller.signal.aborted) return;
        if (error instanceof RequestError && error.status === 401) {
          clearSession(error.message);
          return;
        }
        setCurrent(false);
        setMessage(error instanceof Error ? error.message : 'Balance retrieval failed.');
        if (error instanceof RequestError && error.status === 502) setActionError(error.message);
      } finally {
        if (pendingRequest === controller) pendingRequest = undefined;
      }
      if (active(attempt)) connect();
    }
    void initialize();
    const freshness = setInterval(() => {
      if (valid() && Date.now() - verified.current > 5000) {
        setCurrent(false);
        setMessage('Source verification overdue. Balances are not current.');
      }
    }, 500);
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !valid()) return;
      setCurrent(false);
      connect();
    };
    const onActivity = () => {
      if (!valid() || Date.now() - lastActivity.current < 60_000) return;
      lastActivity.current = Date.now();
      void request('/api/activity', {}).catch((error: unknown) => {
        if (!valid()) return;
        if (error instanceof RequestError && (error.status === 401 || error.status === 503))
          clearSession(error.message);
        else
          setActionError(error instanceof Error ? error.message : 'Activity verification failed.');
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('pointerdown', onActivity);
    document.addEventListener('keydown', onActivity);
    return () => {
      disposed = true;
      invalidateConnection();
      clearInterval(freshness);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('pointerdown', onActivity);
      document.removeEventListener('keydown', onActivity);
    };
  }, [username]);

  useEffect(() => {
    const onPageHide = () => {
      if (activeUser.current) clearSession('Sign in again after returning to this page.');
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const token = ++generation.current;
    setBusy(true);
    setActionError(null);
    try {
      const result = await request('/api/login', {
        username: data.get('username'),
        password: data.get('password'),
      });
      if (generation.current !== token) return;
      if (
        !result ||
        typeof result !== 'object' ||
        !('username' in result) ||
        typeof result.username !== 'string' ||
        !result.username
      ) {
        throw new RequestError(502, 'Invalid login response. Please try again.');
      }
      form.reset();
      verified.current = Date.now();
      activeUser.current = true;
      setUsername(result.username);
      setMessage('Loading your balances...');
    } catch (error) {
      if (generation.current === token)
        setMessage(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }

  async function logout() {
    clearSession('Signing out; local account data cleared.');
    const token = generation.current;
    setBusy(true);
    try {
      await request('/api/logout', {});
      if (generation.current === token) setMessage('Signed out.');
    } catch (error) {
      if (generation.current === token)
        setMessage(
          error instanceof Error
            ? `Logout not confirmed: ${error.message}`
            : 'Logout not confirmed.',
        );
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }

  async function simulate(url: string, body: object, onSuccess?: () => void) {
    const token = generation.current;
    setActionError(null);
    try {
      await request(url, body);
      if (generation.current === token) onSuccess?.();
    } catch (error) {
      if (generation.current !== token) return;
      if (error instanceof RequestError && error.status === 401) clearSession(error.message);
      else setActionError(error instanceof Error ? error.message : 'Simulation failed.');
    }
  }

  return (
    <main>
      <header>
        <div className="mark">B</div>
        <div>
          <h1>Banking Prototype</h1>
          <p>Simple access to your available balances</p>
        </div>
      </header>
      <aside className="notice">
        <strong>Local demonstration only.</strong> Synthetic accounts, in-memory storage, and no
        real bank connection. Data and credentials reset on restart.
      </aside>
      <div className="status" role="status" aria-live="polite">
        {message}
      </div>
      {actionError && (
        <div className="action-error" role="alert">
          <p>{actionError}</p>
          <button type="button" className="secondary" onClick={() => setActionError(null)}>
            Dismiss error
          </button>
        </div>
      )}
      {!username ? (
        <section className="login">
          <h2>Sign in</h2>
          <p>Demo users: alice (savings/checking), bob (savings), empty (no accounts).</p>
          <form onSubmit={(event) => void login(event)}>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              required
              maxLength={64}
              disabled={busy}
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              disabled={busy}
            />
            <button disabled={busy}>{busy ? 'Please wait...' : 'Sign in'}</button>
          </form>
        </section>
      ) : (
        <>
          <div className="toolbar">
            <h2>
              Your accounts <small>({username})</small>
            </h2>
            <button className="secondary" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
          <p
            className={
              current && !snapshot?.accounts.some((account) => account.status === 'unavailable')
                ? 'fresh'
                : 'stale'
            }
          >
            {current
              ? snapshot?.accounts.some((account) => account.status === 'unavailable')
                ? 'Some balances unavailable - see account status'
                : 'Current - verified mock balances'
              : 'Not current - do not rely on these amounts'}
          </p>
          {snapshot && (
            <p className="meta">
              Last source verification: {new Date(snapshot.verifiedAt).toLocaleTimeString()} · USD
              available balances
            </p>
          )}
          {snapshot?.accounts.length === 0 && current && (
            <p>No eligible savings or checking accounts.</p>
          )}
          <div className="accounts">
            {snapshot?.accounts.map((account) => (
              <article
                key={account.id}
                className={
                  !current || account.status === 'unavailable' ? 'account stale-card' : 'account'
                }
              >
                <h3>{account.label}</h3>
                <p>{account.type === 'savings' ? 'Savings account' : 'Checking account'}</p>
                <div className="balance" aria-label={`${account.type} balance`}>
                  USD {formatAmount(account.amount)}
                </div>
                <p className="meta">
                  Available balance{' '}
                  {(!current || account.status === 'unavailable') && '(last known, not current)'}
                </p>
                <details>
                  <summary>Demo-only account controls</summary>
                  <label htmlFor={`amount-${account.id}`}>Synthetic balance (USD)</label>
                  <input
                    id={`amount-${account.id}`}
                    value={amounts[account.id] ?? ''}
                    onChange={(event) =>
                      setAmounts((old) => ({ ...old, [account.id]: event.target.value }))
                    }
                    placeholder="1234.56"
                  />
                  <button
                    onClick={() =>
                      void simulate('/api/demo/balance', {
                        accountId: account.id,
                        amount: amounts[account.id] ?? '',
                      })
                    }
                  >
                    Simulate balance change
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void simulate(
                        '/api/demo/account-failure',
                        { accountId: account.id, failed: !failed[account.id] },
                        () => setFailed((old) => ({ ...old, [account.id]: !old[account.id] })),
                      )
                    }
                  >
                    {failed[account.id] ? 'Restore account source' : 'Simulate account failure'}
                  </button>
                  <button
                    className="secondary"
                    onClick={() => void simulate('/api/demo/revoke', { accountId: account.id })}
                  >
                    Revoke demo account access
                  </button>
                </details>
              </article>
            ))}
          </div>
          <section className="demo">
            <h3>Mock service simulations</h3>
            <p>These controls affect this local process only. They are not banking transactions.</p>
            <button
              className="secondary"
              onClick={() => void simulate('/api/demo/source', { available: false })}
            >
              Simulate source outage
            </button>
            <button
              className="secondary"
              onClick={() => void simulate('/api/demo/source', { available: true })}
            >
              Restore source
            </button>
            <button
              className="secondary"
              onClick={() => void simulate('/api/demo/session-outage', {})}
            >
              Simulate 5-second session outage
            </button>
          </section>
        </>
      )}
      <footer>Read-only banking feature · Changes above alter synthetic test fixtures only.</footer>
    </main>
  );
}
