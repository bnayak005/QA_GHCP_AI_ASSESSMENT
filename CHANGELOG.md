# Changelog

## [Unreleased]

### Added

- Local React/TypeScript and Express banking prototype for synthetic login and savings/checking available balances.
- Server-managed sessions, ownership checks, authoritative SSE snapshots, freshness indicators, and demo failure/revocation controls.
- Unit, integration, real-browser regression, coverage, strict typing, lint, formatting, and document-quality gates.
- Requirements, reviewed architecture, agreed design decisions, dependency-ordered implementation plan, prototype decisions, and measured verification report.
- Pinned Windows GitHub Actions verification and an unchecked pull-request reviewer checklist.
- LF text checkouts for consistent Windows formatting, with intentional Markdown hard breaks preserved.

### Fixed

- Malformed initial API responses no longer crash the balance view.
- Superseded reconnects cannot leak duplicate event streams or overwrite newer authentication state.
- Action errors remain visible through background balance updates.
- Document traceability checks accept formatter-aligned Markdown table padding.

### Changed

- Preserve the repository's original README content and add reproducible setup and verification instructions.
- Package planning documents under `docs/`; verification defaults to that folder while rejecting invalid explicit overrides.

### Limitations

- Local, single-process, memory-only, synthetic-data prototype. No production bank integration, durable distributed state, public hosting, or compliance certification.
- Bank-specific specifications, entitlements, service budgets, and production approval gates remain unresolved; prototype verification does not close them.
