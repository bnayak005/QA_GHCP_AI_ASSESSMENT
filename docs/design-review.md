# Structured Design Review: Banking Login and Balance Viewing

**Review date:** 2026-11-03  
**Inputs:** [architecture.md](./architecture.md) and [requirements.md](./requirements.md)  
**Review type:** Senior-level, pre-implementation architecture review. No production code was written.

**Historical scope:** Sections 1-7 preserve the original pre-implementation review and its status at that time. A separately approved local mock-backed prototype has since been implemented and verified; this does not close the production integration or bank approval gates. See [the prototype architecture](./architecture.md#10-separately-approved-local-prototype) for the scope distinction and the project's prototype decision document for later validation evidence.

## 1. Executive assessment

**Outcome: Revise before implementation; external approval gates remain open.**

The modular backend, reuse of bank identity/core services, read-only scope, exact monetary representation, and explicit failure states are appropriate for this feature. There is no evidence justifying additional microservices or a separate balance database.

The original design left material ambiguity in update consistency, freshness, multi-replica delivery, and session lifecycle. One logout step was technically incorrect: browser code cannot clear an HttpOnly cookie. These issues have been addressed in the architecture text, but their implementation and operational behavior are not yet verified.

The requesting user explicitly selected **"Approve all listed revisions"** in the design-review approval interaction. This establishes agreement on the seven design revisions in Section 4 only. It does not imply bank product, security, compliance, operations, or source-system owner approval.

## 2. Review method and coverage

Reviewed the design against:

- Functional and acceptance coverage: login, invalid credentials, savings/checking accounts, authoritative balances, and real-time changes.
- Correctness: source precision, account-set completeness, snapshot/update races, event ordering, and recovery.
- Session and access lifecycle: logout, expiry, entitlement changes, cross-replica invalidation, and delayed callbacks.
- Operational design: failure domains, source health, downstream load, fan-out, bounded buffering, and reconnect behavior.
- Governance: assumptions, proposed controls, measurable targets, integration feasibility, and sign-off boundaries.

Severity means design impact: **High** risks incorrect financial information, continued protected-data delivery, or failure of a core requirement; **Medium** risks incomplete/error-prone behavior or a misleading user experience. Findings are design risks, not claims of exploitable vulnerabilities in implemented code.

## 3. Findings and disposition

Section references identify the reviewed architecture areas; the architecture has now been revised, so these descriptions capture the original gaps rather than asserting that they remain unchanged.

| ID    | Severity | Architecture area                            | Finding and impact                                                                                                                                                                                                                                                      | Requirement linkage                                                      | Disposition                                                                                                                                                                                                 |
| ----- | -------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DR-01 | Medium   | 5.3: Logout                                  | The client was assigned responsibility for clearing an HttpOnly cookie. Browser JavaScript cannot perform that operation, leaving cookie lifecycle ownership incorrect. Failed server logout also lacked an explicit outcome.                                           | FR-11; NFR-05, NFR-10                                                    | Corrected in the design: server expires the cookie; client clears views; unconfirmed logout is explicit. Implementation tests pending.                                                                      |
| DR-02 | High     | 5.2: Synchronization and ordering            | Capture-before-snapshot did not state the required source consistency guarantee. Balance versions were also not distinguished from continuity sequences. Buffering with a lagging read can miss a value, and non-consecutive versions cannot reliably prove event loss. | FR-06; BR-03, BR-06; NFR-01, NFR-06                                      | Added snapshot/cursor or equivalent consistency prerequisite, distinct continuity semantics, and reset/overflow recovery. Source capability confirmation remains open.                                      |
| DR-03 | High     | 5.2 / 7: Freshness                           | The design distinguished transport health from source health but did not define positive freshness evidence. Using the last change time would incorrectly flag quiet accounts; transport heartbeats alone could conceal a stalled source feed.                          | FR-06, FR-09; NFR-01, NFR-06                                             | Added source health/progress or authoritative reconciliation, separate verification metadata, and quiet-account/stalled-feed tests. Thresholds and source contract remain open.                             |
| DR-04 | High     | 5.2 / 7: Multi-replica delivery and capacity | Fan-out/routing was named without defining delivery semantics. A competing-consumer group could send an event to only one replica, missing customers on others. Reconnect/capture/reconciliation load was not explicitly budgeted.                                      | FR-06; NFR-02, NFR-03, NFR-08, NFR-10                                    | Added all-interested-replica delivery, bounded capture/client buffers, reconnect backoff/jitter, draining, and downstream capacity accounting. Load/failover tests pending.                                 |
| DR-05 | High     | 5.2 / 5.3: Revocation and quiet streams      | Checking validity before balance dispatch alone does not terminate a quiet expired stream. Cross-replica invalidation, queued updates, and entitlement propagation bounds were not specified, so immediate revocation claims were unsupported.                          | FR-07, FR-11; NFR-05                                                     | Added scheduled expiry checks, shared invalidation, dispatch-generation checks, fail-closed behavior, and an explicit revocation-bound approval gate. No claim of instantaneous or retroactive data recall. |
| DR-06 | High     | 5.1 through 5.3: Client lifecycle            | An in-flight balance response could complete after logout or a different login and repopulate cleared account data. A per-account version alone does not distinguish different authenticated sessions or resynchronization generations.                                 | FR-07, FR-11; NFR-05, NFR-06                                             | Added authentication/synchronization generations, old-response rejection, account-set reconciliation, and delayed-callback tests. Implementation tests pending.                                             |
| DR-07 | Medium   | 5.1 / 6: Partial account failures            | Multi-account initial-load semantics were undefined. Silently omitting a failed account could look like a complete account set or no eligible accounts; later failures also need account-level status.                                                                  | FR-04, FR-05, FR-09, FR-10; NFR-06                                       | Agreed complete-or-explicit-failure initial response and per-account streaming error states. This does not promise cross-account transactional atomicity. Tests pending.                                    |
| DR-08 | High     | 2 / 8 / 9: External feasibility and approval | The document correctly listed open questions, but identity integration, event/snapshot capability, revocation contracts, and numeric service targets remain unverified. SSE selection alone cannot establish real-time compliance or production readiness.              | AC-01, AC-04; NFR-01 through NFR-05, NFR-08, NFR-10; OQ-01 through OQ-08 | Open approval/integration gate, not a newly discovered omission of the open-question list. Architecture now states the required evidence and separates user agreement from bank sign-off.                   |

**Disposition summary:** Seven findings have design-level corrections; DR-08 remains an external approval/integration risk. DR-02 through DR-05 also retain dependencies on source contracts or approved operational budgets. No finding is considered implementation-verified or risk-free.

## 4. Agreed design decisions

All decisions below were approved by the requesting user for this design revision on 2026-11-03 and incorporated into [architecture.md](./architecture.md). Policy-specific values and bank stakeholder approval remain pending.

| ID    | Agreed decision                                                                                                                                                                  | Rationale / trade-off                                                                                                                                                              | Findings addressed              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| DD-01 | The server owns HttpOnly cookie expiry. The client clears protected views and discards late responses from an invalidated authentication generation.                             | Correct cookie ownership and prevent old-session data from restoring the view. Failed logout cannot be presented as confirmed server revocation.                                   | DR-01, DR-06                    |
| DD-02 | Define a consistent snapshot/cursor or equivalent source guarantee; distinguish monetary versions from feed continuity and restart synchronization when continuity is uncertain. | Avoid lost/regressive updates without assuming consecutive balance versions. Requires adequate source integration, not just a connected stream.                                    | DR-02                           |
| DD-03 | Determine currentness from source health/progress or authoritative reconciliation, not the age of the last balance change.                                                       | Quiet accounts may be current; source stalls must be visible even when transport remains connected. Verification traffic consumes capacity.                                        | DR-03                           |
| DD-04 | Deliver events to every replica hosting affected subscriptions, with bounded buffers, reconnect backoff/jitter, and explicit resynchronization.                                  | Prevent missed updates and unbounded recovery load. Fan-out mechanism and capacity are validated against the existing bank platform.                                               | DR-04                           |
| DD-05 | Propagate session/entitlement invalidation across replicas; run expiry checks on quiet streams; stop protected delivery when validity cannot be established.                     | Close lifecycle gaps without promising instantaneous revocation. Propagation bounds and entitlement consistency require approval.                                                  | DR-05                           |
| DD-06 | Initial account snapshots are complete for the successfully resolved eligible set or explicitly fail; later account refresh failures have explicit per-account status.           | Prevent silent omissions and false no-account states. One failing account can block initial display, an intentional reliability/availability trade-off accepted for this baseline. | DR-07                           |
| DD-07 | Treat business definitions, measurable targets, and identity/source integration feasibility as gates before production implementation.                                           | Prevent provisional choices from becoming unsupported delivery commitments. User design agreement is not bank-wide approval.                                                       | DR-08 and residual dependencies |

**Retained recommendations, not newly approved bank decisions:** A modular backend, reuse of bank identity/core services, no duplicate credential/balance repository, and conditional browser/SSE delivery remain appropriate. No vendor, cloud, numeric SLA, new broker, or additional banking feature was mandated by this review.

## 5. Outstanding approvals and required evidence

Suggested owners are roles requiring assignment, not people who have already agreed.

| Gate                                      | Suggested owner                      | Evidence required before sign-off                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Balance and eligibility definitions       | Product owner and banking operations | Approved balance type, hold/overdraft semantics, currencies, eligible-account and joint/delegated-access rules; OQ-01/OQ-03/OQ-07.                                                  |
| Source consistency and change integration | Core banking / integration owner     | Documented snapshot/version/cursor guarantees, continuity/reset behavior, feed-health contract or reconciliation capability, and entitlement-change propagation; DR-02/DR-03/DR-05. |
| Identity and session policy               | Identity and security owners         | Supported login integration, MFA/attempt policy, session activity/expiry rules, cross-replica invalidation contract, and approved revocation bound; OQ-05.                          |
| Capacity and service levels               | Architecture and operations owners   | Freshness/latency measurement boundaries and percentiles, concurrency/update/reconnect workload, downstream budgets, availability/maintenance/recovery objectives; OQ-02/OQ-04.     |
| Failure presentation and clients          | Product owner and UX                 | Approved stale-balance retention/hiding behavior, target channels, accessibility standard, and compatibility matrix; OQ-06/OQ-07.                                                   |
| Compliance and operational records        | Compliance and security owners       | Jurisdiction-specific controls, audit scope, retention/access/redaction policy, and sensitive-data protection requirements; OQ-08/NFR-04/NFR-09.                                    |

## 6. Validation plan

At the time of this design review, these required validation scenarios were planned but had not been executed. Later local prototype checks do not substitute for bank integration, distributed-operation, or production acceptance evidence.

| Validation group            | Required checks                                                                                                                                                     | Closure criterion                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Core acceptance             | AT-01 through AT-05; approved AT-06 through AT-10.                                                                                                                  | Valid/invalid login and correct authorized savings/checking display; real-time delay meets the approved target.       |
| Update consistency          | Snapshot/subscription races; lagging snapshots; duplicate/out-of-order events; non-consecutive versions; missing events; resets; expired cursors; capture overflow. | No regression or silent gap; uncertain continuity explicitly resynchronizes.                                          |
| Freshness and failures      | Unchanged account with healthy verification; stalled source with live transport; one-account refresh failure; feed-wide outage and reconnection.                    | Currentness is truthfully represented; no failure becomes a zero/current balance.                                     |
| Session and entitlements    | Quiet-stream expiry; cross-replica logout/revocation; queued updates; old callbacks after logout/different login; failed logout; session/entitlement-store outage.  | Protected dispatch stops under the agreed validity contract; cleared views are not repopulated by obsolete responses. |
| Multi-account completeness  | Multiple eligible accounts with one failed source read; entitlement-resolution failure; genuine no-accounts result.                                                 | Initial incomplete/error results cannot masquerade as complete or empty success.                                      |
| Scale and recovery          | Customers on different replicas; fan-out delivery; replica draining/loss; slow clients; reconnect storm; bounded retries/reconciliation.                            | Delivery, recovery, memory use, and downstream load remain within approved budgets.                                   |
| Presentation and operations | Exact decimals/currencies, negative/zero balances, accessibility, supported clients, response caching, log redaction, and operational alerts.                       | Approved NFR checks pass with recorded evidence.                                                                      |

## 7. Changes made and final review status

Updated [architecture.md](./architecture.md) in:

- Section 1: User-agreed review baseline and approval boundary.
- Sections 5.1 through 5.3: Complete initial snapshots, source-consistent synchronization, freshness verification, fan-out/recovery, revocation/expiry, cookie ownership, and response generations.
- Sections 6 and 7: Explicit synchronization/freshness metadata and downstream capacity responsibilities.
- Sections 8 and 9: Integration/approval gates and targeted validation scenarios.

**Final status:** Design corrections are documented and user-agreed. Production implementation remains gated on the outstanding source/policy/quality decisions; delivery readiness requires implementation and test evidence. This was a document-based review, not runtime, load, compliance, or production security validation.
