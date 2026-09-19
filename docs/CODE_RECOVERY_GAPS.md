# Code Recovery Boundaries

## Recoverable material

Prior project context preserves the local path, architecture, canonical identifiers, Drive mappings, controller symbol names, scheduler behavior, reviewer-stall threshold, source-pack progression semantics, response-hash/setup-ACK diagnoses, selected action IDs, test pass count, UI port/controls, and runtime state-file names.

## Literal source bodies not recoverable from chat context

```text
src/controller.mjs
src/protocol.mjs
src/operations.mjs
dashboard.html
config.json
package.json
Start-Controller.ps1
Stop-Controller.ps1
tests/*
data/state.json
data/status.json
data/control.json
```

Only fragments, symbol names, diagnostics, command traces, and behavioral descriptions were retained.

## Repository policy

Do not fabricate those original files and present them as historical source. `src/recovered-invariants.mjs` is intentionally labeled reconstructed and contains only behavior derived from documented invariants.

The original local tree should be imported verbatim from `C:\\Users\\javi_\\.codex\\Apps\\R433AuditController`.

## Security boundary

This repository is public. Do not commit authentication tokens, cookies/session storage, browser profiles, OAuth secrets, connector credentials, generated secrets, or private source/user data. Runtime state may be forensically useful but must be scrubbed before public publication if it contains private URLs, identifiers, tokens, cookies, or source material.
