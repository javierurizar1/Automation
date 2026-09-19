# R433 Audit Controller repair report — 2026-09-19

## Root cause

The ChatGPT UI changed its composer and conversation DOM. The controller only recognized the retired #prompt-textarea and old message-role attributes. A later parser found user prompts but treated a wrapper containing both user and assistant content as one user message. Assistant setup acknowledgments and reviewer responses were missed, causing false setup timeouts and idle reviewer slots.

## Repair

- Composer detection supports the visible contenteditable textbox and retains the legacy selector as a fallback.
- Message extraction reads current user (.bg-user-message) and assistant (.group.flex.min-w-0.flex-col) messages separately, preserving action-marker attribution and legacy fallbacks.
- The already-visible Bucket 1 action was reconciled from its marker; it was not resent.
- The official controller and watchdog were restarted.

## Verified operation

At 09/19/2026 23:09:13 the controller was **RUNNING** with 1 of 2 reviewer generations live and productive (Buckets 3). The previous five minutes showed **460 new cases** and **460 verified writes**. Watchdog heartbeat: 09/19/2026 23:09:15.

Bucket 1's exact target pack 217 is unavailable and in persisted retry backoff until 2026-09-19 23:59 UTC. Bucket 2's next source pack is unresolved at its current boundary. Neither consumes a live reviewer slot; Buckets 3 and 4 continue processing.

## Validation

- 
ode.exe --check src/controller.mjs: passed.
- Read-only CDP inspection confirmed exact assistant setup acknowledgments attributed to actions in Buckets 2–4 and separate user/assistant messages in Bucket 1.
- Live status confirmed concurrent productive reviews and readback-verified writes.
- Automated test suite not run.

## Artifacts

- source/R433AuditController/src/controller.mjs: exact current controller snapshot.
- source/R433AuditController/test/controller-state-machine-static.test.mjs: current static test snapshot (not executed).
- vidence/R433AuditController-live-status-20260919.json: curated operational snapshot and SHA-256 hashes.

The running app remains at C:\Users\javi_\.codex\Apps\R433AuditController; runtime state, browser data, configuration IDs, and case contents are excluded from this public evidence repository.