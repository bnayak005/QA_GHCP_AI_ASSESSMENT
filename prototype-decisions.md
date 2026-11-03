# Approved Prototype Decisions and Contracts

## Approval boundary

On 2026-11-03 the requesting user approved React/TypeScript, Node/TypeScript/Express, a loopback-only mock-backed prototype, generated synthetic credentials, USD available balances, session defaults, SSE updates, demo fault controls, and local test targets. This supersedes the earlier discovery-only direction for the **prototype only**. The original seven reviewed design revisions remain the behavioral baseline.

The production tasks and bank approval gates in the original implementation plan are not deemed completed. No real banking credentials or infrastructure were supplied.

## API contract

All mutations require an allowed loopback Origin and JSON body. API errors have `{ error, correlationId }`, with explicit 400/401/403/413/429/500/503 outcomes; unknown API routes return 404. The client separately identifies invalid response contracts as a 502-equivalent error. Protected reads require the opaque `bank_session` cookie. Responses are not cached.

| Endpoint                         | Request / outcome                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/login`                | `{ username, password }`; creates a new session, revokes a prior cookie session, returns `{ username }`. Invalid credentials are generic.                           |
| `POST /api/logout`               | `{}`; invalidates server session/streams and expires HttpOnly cookie. Session-service failure explicitly leaves server logout unconfirmed.                          |
| `GET /api/session`               | Checks validity without extending inactivity.                                                                                                                       |
| `POST /api/activity`             | `{}`; records actual customer activity. Client invokes on user input at most once per minute; automatic updates/reconnect do not touch inactivity.                  |
| `GET /api/balances`              | Complete owned eligible-account snapshot, or explicit error. Empty means entitlement resolution succeeded with no eligible accounts.                                |
| `GET /api/events`                | SSE JSON messages: full `snapshot`, `unavailable`, or `session-ended`. Current session validity is checked on each send and every second, including quiet accounts. |
| `POST /api/demo/balance`         | `{ accountId, amount }`; modifies an owned synthetic fixture, not a transaction. Exact two-decimal USD string, at most ten whole digits.                            |
| `POST /api/demo/account-failure` | `{ accountId, failed }`; causes an initial complete-snapshot error or explicit later per-account unavailability.                                                    |
| `POST /api/demo/revoke`          | `{ accountId }`; removes an owned synthetic account until restart.                                                                                                  |
| `POST /api/demo/source`          | `{ available }`; toggles the process-wide mock balance source.                                                                                                      |
| `POST /api/demo/session-outage`  | `{}`; triggers a five-second mock validity outage, closes protected streams, then automatically recovers.                                                           |
| `GET /api/health`                | Process responsiveness and local-mock mode only; not a production dependency readiness guarantee.                                                                   |

## Snapshot consistency and freshness

Snapshots contain source epoch, monotonic source cursor, source verification timestamp, and the complete authorized account set. Account records contain type, masked label, currency, balance type, exact amount, version, change timestamp, and current/unavailable status.

Versions increment by seven to demonstrate that monetary versions are not event-continuity sequences. The source cursor advances on fixture balance/entitlement mutations; availability verification is separate. Complete source reads run synchronously after subscription registration. Reconnect always takes a new snapshot instead of trusting an arbitrary Last-Event-ID. A new process uses a new epoch.

Later account failures retain last-known values with explicit unavailable status; global failures mark all displayed values not current. Successful periodic source reads verify quiet accounts. There is no application-level stream queue. A write that triggers Node response backpressure destroys the connection, and the client retries with capped backoff/jitter. The high-water mark is a flow-control threshold, not a hard byte cap: a single write can exceed it before disconnection.

Initialization and reconnect requests use abort signals and a separate connection generation. Visibility changes and cleanup invalidate pending attempts before replacing streams; obsolete success/failure callbacks cannot reopen a connection, overwrite a snapshot, or clear a newer valid session. Initial HTTP snapshots use the same runtime snapshot guard as SSE. Invalid JSON/response shapes produce explicit feedback rather than rendering unvalidated data.

Action failures are displayed in a separate accessible alert, not in the stream-health status. Background snapshots cannot erase them. Alerts clear on dismissal, a new action, login, or session clearing.

## Reviewed decisions implemented versus deferred

| Decision                                     | Prototype treatment                                                                                           | Production gap                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| DD-01: Cookie ownership / response lifecycle | Server cookie expiry; client auth generations, view clearing, stale callback rejection.                       | Bank identity/session integration and controls require approval/testing.            |
| DD-02: Snapshot / continuity                 | Consistent full synchronous snapshots, source epoch/cursor, version checks, reconnect resnapshot.             | Durable source cursor/replay/gap/reset and atomic integration contracts unverified. |
| DD-03: Positive freshness evidence           | Mock source reads every second; explicit failures and five-second client watchdog.                            | Bank source-health, timing uncertainty, and reconciliation budgets unverified.      |
| DD-04: Fan-out / bounded recovery            | All local listeners receive full snapshots; bounded writes and jittered reconnects.                           | Cross-replica routing, durable infrastructure, load and failover not implemented.   |
| DD-05: Validity lifecycle                    | Shared in-process session map; synchronous invalidation plus quiet-stream timer; session outage fails closed. | Distributed invalidation and entitlement propagation bounds unverified.             |
| DD-06: Initial completeness                  | Initial failure if any eligible balance fails; later explicit account status.                                 | Real bank account-set resolution/contracts unverified.                              |
| DD-07: Approval gates                        | Local prototype defaults approved separately and limitations documented.                                      | Production gates remain open; no fabricated bank sign-off.                          |

## Validation scope

Automated domain/API/client-state tests cover authentication, exact expiry thresholds, generic errors, attempt controls, authorization, exact monetary values, source failures/recovery, complete-versus-partial outcomes, quiet-account freshness, ten-session update timing, stream invalidation, and snapshot ordering/reset/removal.

A real browser check covers invalid/valid login, savings/checking presentation, visible update timing, source/account failures and recovery, logout, empty accounts, a delayed response across logout/different login, and a mobile-width layout. It is a smoke check, not full WCAG certification, production load testing, or compliance verification.

### Recorded local validation: 2026-11-03

- `npm.cmd run build`: passed TypeScript checks, backend compilation, and frontend build.
- `npm.cmd test`: 21 tests passed across three files, including measured one-second update delivery to ten concurrent local sessions and five-second outage notification limits.
- `npm.cmd run test:browser`: passed; visible balance update took 73 ms in the final run, outage timing passed, old-session delayed data did not restore the view, mobile-width layout fit, and no browser page errors occurred.
- `npm.cmd audit --audit-level=moderate`: zero reported vulnerabilities in the installed dependency set at validation time.

Temporary browser servers were stopped after checks. No real bank integration, multi-replica operation, production availability, full accessibility certification, or deployment was validated.

### Post-review defect validation: 2026-11-03

The three peer-review defects are fixed: malformed initial responses are rejected before rendering, superseded reconnect attempts are cancelled and generation-checked, and action-error alerts are independent of background stream status.

- Final build/type-check passed.
- 32 automated tests passed, including malformed snapshot/error contracts, individually missing fields, and unknown API routes.
- Expanded browser smoke passed: malformed JSON shapes and non-JSON initial responses did not crash; action errors survived multiple background updates and cleared through dismissal/new action; delayed reconnect success/failure after visibility changes left exactly one subscription; logout removed all listeners.
- Existing login, balance, outage/recovery, delayed old-session response, and mobile-layout checks remained passing. The visible balance update took 92 ms in the final run.
- The running local server returned HTTP 200 for health, the page, and its rebuilt JavaScript asset. The shared browser page was refreshed.

No production bank readiness is claimed. These results supersede the initial local test counts above without changing the approved prototype scope.

### Comprehensive verification: 2026-11-03

- Build and strict TypeScript checks passed.
- 49 automated cases passed across four files: 44 runtime unit/integration cases and five document-checker unit cases.
- Scoped coverage: statements 96.53%, branches 95.83%, functions 96.22%, lines 100%. This covers the backend application/domain, shared contracts, and client state helper; it does not claim measured React-component or startup-bootstrap coverage.
- Browser verification passed, including required-field/keyboard behavior, an unconfirmed logout, and all earlier lifecycle/error regressions. Visible update latency was 103 ms; ten-session update and source-outage timing targets also passed in integration tests.
- Six-document verification passed after correcting four content-quality issues. The checker validates source-ID coverage, cross-document references, local links/section anchors, table/code-fence structure, the 29-task dependency graph, API route/default agreement, and explicit prototype/production boundaries. Human review complements these rule checks.
- Original Word source fidelity passed: the user story and five acceptance criteria are preserved exactly.
- Dependency audit reported zero known vulnerabilities. The running prototype health and HTML endpoints returned HTTP 200.

See [verification-report.md](./verification-report.md) for consolidated results, scope exclusions, and reproduction commands. Production bank integration, distributed revocation/fan-out, compliance, availability, and full accessibility certification remain unverified.

### Code-quality follow-up: 2026-11-03

The comprehensive verification command now begins with strict TypeScript, zero-warning ESLint, and Prettier checks. Unsafe Express boundary typing and an async timer callback were corrected; source formatting is consistent. Tests keep strict TypeScript and baseline lint checks, while untyped Supertest invalid-input assertions are excluded from type-aware lint rules only.

The quality-gated rerun passed all 49 automated cases, browser regressions, and six-document checks. Current scoped coverage is statements 96.57%, branches 95.90%, functions 96.22%, and lines 98.73%; the visible browser update took 76 ms. Formatting exposes separate uncovered lines that were previously combined; it does not imply reduced functional verification. Supported/patched linter dependencies audit with zero known vulnerabilities.

See the verification report for the configured gates and their limits. These checks do not replace peer review or production bank validation.
