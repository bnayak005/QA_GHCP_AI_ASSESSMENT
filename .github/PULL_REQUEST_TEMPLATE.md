## Summary

Provide a two- or three-sentence overview of what was built and why.

## Changes Made

- List every added or modified file and its reason.

## Test Evidence

Paste actual test output or link to CI results. Distinguish local verification from CI and state the measured coverage scope.

## Known Limitations

List unresolved specifications, items marked "Not Found", production gates, and excluded functionality. Do not treat mock success as production approval.

## Reviewer Checklist

- [ ] Requirements and all five acceptance criteria are traced to implementation and tests.
- [ ] Human-approved design decisions and the local-prototype boundary are preserved.
- [ ] Authentication, session lifecycle, authorization, snapshots, freshness, and errors behave correctly.
- [ ] The three peer-review defects have passing regression coverage.
- [ ] Strict types, lint, formatting, build, unit/integration coverage, browser checks, document checks, and dependency audit pass.
- [ ] PR CI is green and its logs have been reviewed.
- [ ] No secrets, real banking data, dependencies, build output, or generated reports are committed.
- [ ] Every changed file, the changelog, test evidence, and limitations are accurately documented.
- [ ] Production bank prerequisites remain explicitly blocked or out of scope.
