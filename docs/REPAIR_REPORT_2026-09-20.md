# R4.3.3 controller repair

## Requested outcome

Keep the existing audit controller to two concurrent reviewer generations and a five-chat rotation, require the highest selectable model at High reasoning effort for case-review sends, expose policy and verification in the dashboard, and publish a reviewable source snapshot.

## Changes

- Verify GPT-5.6 Sol and High reasoning before each send. If the UI cannot confirm both, hold the bucket and send nothing.
- Wait for the model selector on newly opened pages before verification. A missing or locked selector still fails closed.
- Limit controller-managed bucket conversations to five. Preserve retired conversation URLs in history and close their tracked tabs before replacement; unrelated tabs are not matched or closed.
- Persist new-chat creation reservations. Preserve ambiguous tabs and disable automatic retry, including for migrated legacy retry states.
- Show model policy, per-bucket verification, chat allocation, and unresolved chat-creation status on the dashboard.
- Recognize the bounded `ROWS_<start>_<end>_WRITE_ISSUED_READBACK_UNVERIFIED` footer as eligible for the existing `WRITE_RECOVERY` flow. That flow reconciles only uncertain writes and forbids new case reviews; unrecognized blockers still fail closed.
- Publish the runnable controller, dashboard, launcher and watchdog scripts, regression tests, and sanitized documentation. Exclude private configuration, chat and registry IDs, source-shard IDs and offsets, case/source data, browser profile, and runtime state.

## Operational boundary

An action already in flight completed at Instant before this repair. Its existing verified writes and terminal rows were preserved. This repair does not retroactively rewrite or re-audit that action.

## Live validation

At `2026-09-20T02:58:39Z`, the controller was RUNNING and connected with five managed chats and one live generation under the two-generation cap. Five tracked pages were previously read back at GPT-5.6 Sol / High, the highest tier selectable in the connected UI; the retired tab was closed before replacement. The fresh B3 audit was sent at High. A later partial-write footer entered HOLD; the bounded B3 `WRITE_RECOVERY` was then sent at High, the flagged registry range was read back with reviewed records present, and the controller resumed normal B3 `CONTINUE` at High. Recovery made no new case writes. The local dashboard returned HTTP 200 and displays the required policy and per-bucket model checks.

Validated implementation commit: `de2f39ef5a8b65ef653e6c0223cf00de89409c14`.

At capture, B1 was waiting after its exact source pack was unavailable and B2 remained stalled for no recent audit progress. One live reviewer was active. Their stored source state was preserved.

## Validation

The local application suite passed 152 tests. The sanitized GitHub snapshot passed 157 tests. JavaScript syntax, dashboard script parsing, PowerShell parsing, live model readback, five-chat allocation, bounded write recovery, case-review dispatch, and dashboard availability are recorded in the sanitized evidence JSON.
