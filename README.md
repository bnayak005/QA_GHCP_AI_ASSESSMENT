# QA_GHCP_AI_ASSESSMENT

QA_GHCP_AI_ASSESSMENT

## Banking Prototype

Local, mock-backed implementation of the user-approved banking login and balance-viewing design.

**Not production banking software.** Use synthetic data only. No real bank APIs, real transactions, production identity provider, or regulatory compliance claims.

## Run on Windows

Requires Node.js 24.14 or later in the Node 24 release line, and npm.

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd start
```

Open **http://127.0.0.1:3000**. Startup prints fresh synthetic passwords for:

- `alice`: savings and checking accounts.
- `bob`: savings account.
- `empty`: no eligible accounts.

Passwords are generated on each restart, hashed with scrypt in memory, and never written to a credential file. Startup credential output is an intentional local-demo exception; request/stream logs exclude credentials, balances, and session tokens. Do not share terminal output.

For development, `npm.cmd run dev` starts the backend on port 3000 and Vite on **http://127.0.0.1:5173**. Both bind to loopback. Stop using Ctrl+C.

## Verify

Run the code-quality gate independently:

```powershell
npm.cmd run quality
```

This requires strict frontend/backend TypeScript checks with unused-variable/parameter checks, zero ESLint errors or warnings, and consistent Prettier formatting. Runtime TypeScript uses type-aware lint rules; React hook rules check hook usage and effect dependencies. Tests retain strict TypeScript and baseline ESLint checks, while type-aware lint rules are not applied to deliberate invalid-input assertions using Supertest's untyped response bodies. Generated dependencies, build output, coverage, test reports, and the generated lockfile are excluded from formatting/lint inspection as appropriate.

Use `npm.cmd run format` to apply the configured formatting, then rerun quality and verification. The comprehensive `verify` command runs the quality gate before build and tests, so lint or formatting failures cannot be reported as a successful overall verification.

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:browser
```

For the comprehensive code-quality, testing, and six-document verification suite:

```powershell
npm.cmd run verify
npm.cmd audit --audit-level=moderate
```

The four planning documents default to `docs/`. An explicit `--documents-root` override remains available; a missing or invalid supplied folder fails verification rather than falling back to the default. The suite checks those four documents plus this README and the prototype decision document. Coverage reports are written to `coverage/`, and document findings to `test-results/documents.json`. Measured coverage applies to the backend application/domain, shared contracts, and client state helper; the React UI is verified separately through the browser suite. Internal coverage gates are 90% statements/lines/functions and 80% branches, not bank service requirements.

The pinned GitHub Actions workflow runs this same suite and dependency audit on Windows for pull requests and pushes to `main`. CI results must be reviewed before merging; local results do not imply CI has passed.

See [verification-report.md](./verification-report.md) for the recorded comprehensive results, document-quality corrections, and remaining limitations.

The browser check uses Playwright Chromium if installed, or Windows Microsoft Edge. If neither is available:

```powershell
npx.cmd playwright install chromium
```

The browser check runs its own temporary loopback server on an available port and stops it afterward. It uses generated credentials held only in memory.

## Features

- Valid/invalid login, required fields, generic errors, and a five-failure/one-minute username attempt control.
- Server-managed HttpOnly, SameSite=Strict sessions, 15-minute inactivity and 8-hour absolute expiry, session rotation, logout, and quiet-stream expiry.
- Authorized savings/checking available balances in USD with exact two-decimal string representation, including negative/zero amounts.
- Complete initial snapshots or explicit errors; per-account unavailable states for later failures.
- SSE complete snapshots with source epoch, versions, continuity cursor, verification time, reconnect/resynchronization, bounded output buffering, and old-session response rejection.
- Freshness derived from successful mock source verification, not last balance-change age.
- Runtime validation of initial balance responses, including malformed/empty JSON and non-JSON failures, without crashing the page.
- Cancelled obsolete initialization/reconnect requests and connection generations that prevent duplicate subscriptions after visibility changes.
- Separate, dismissible action-error alerts that remain visible through background balance updates.
- Demo-only controls for source/account outages, session outage, balance changes, and account revocation.
- Accessible labeled inputs/status feedback, responsive layout, and explicit stale/no-account/error states.

The approved prototype targets are updates within one second under ten concurrent local sessions and source outage notification within five seconds. These are measured local test targets, not bank SLAs.

## Architecture and limitations

The backend is one Express process with logical identity/session, authorization, balance, and update modules. React/TypeScript renders the customer interface. All data resets on restart. No new password/balance database is introduced.

HTTP cookies intentionally omit Secure **only for this loopback HTTP demo**. The server binds to `127.0.0.1`, rejects non-loopback hosts, and requires an allowed Origin on mutations. Do not expose or proxy it publicly.

Mock reads/mutations are synchronous and snapshots are complete, so subscription registration plus source read is consistent within one JavaScript turn. Every reconnect rereads authoritative mock state; this is not a durable event replay system. Slow clients are disconnected rather than buffered without bounds. No multi-replica delivery/revocation guarantee is implemented.

Demo source toggles affect all sessions in this process; account controls are restricted to the authenticated customer's synthetic accounts. Account revocation removes the synthetic fixture until restart. Session outages recover automatically after five seconds. No account-selection, transfers, payments, registration, or transaction history is implemented.

See [prototype-decisions.md](./prototype-decisions.md) for approved defaults, detailed contract, and production gaps. The preserved SDLC documents are [requirements](./docs/requirements.md), [architecture](./docs/architecture.md), [design review](./docs/design-review.md), and [implementation plan](./docs/impl-plan.md). Their production approval gates are not falsely marked complete by this demo.

## Production prerequisites

Before any bank deployment, replace mocks with validated identity/core/feed contracts and bank entitlements, durable shared sessions, approved TLS/Secure cookie and secrets controls, cross-replica fan-out/invalidation, source-consistency/freshness guarantees, approved service budgets, audit retention, and compliance controls. Perform bank acceptance, security, accessibility, scale, recovery, and release-readiness reviews. Synthetic mock success is not evidence that these integrations are feasible.
