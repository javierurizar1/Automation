# R4.3.3 controller repair

## Requested outcome

Keep the existing audit controller to two concurrent reviewer generations and a five-chat rotation, require the highest selectable model at High reasoning effort for case-review sends, expose policy and verification in the dashboard, and publish a reviewable source snapshot.

## Changes

- Verify GPT-5.6 Sol and High reasoning before each send. If the UI cannot confirm both, hold the bucket and send nothing.
- Wait for the model selector on newly opened pages before verification. A missing or locked selector still fails closed.
- Limit controller-managed bucket conversations to five. Preserve retired conversation URLs in history and close their tracked tabs before replacement; unrelated tabs are not matched or closed.
- Persist new-chat creation reservations. Preserve ambiguous tabs and disable automatic retry, including for migrated legacy retry states.
- Show model policy, per-bucket verification, chat allocation, and unresolved chat-creation status on the dashboard.
- Publish the runnable controller, dashboard, launcher and watchdog scripts, regression tests, and sanitized documentation. Exclude private configuration, chat and registry IDs, source-shard IDs and offsets, case/source data, browser profile, and runtime state.

## Operational boundary

An action already in flight completed at Instant before this repair. Its existing verified writes and terminal rows were preserved. This repair does not retroactively rewrite or re-audit that action.

## Live validation

The controller is RUNNING and connected. It holds the two-generation and five-managed-chat limits. Five tracked reviewer pages were read back at GPT-5.6 Sol / High; the retired tab was closed before replacement. The fresh B3 `INITIAL_AUDIT` was verified at that model and reasoning effort, and one generation was active at capture. The local dashboard returned HTTP 200 and displays the required policy and per-bucket model checks.

One pre-existing source-pack boundary still prevents using the second live slot. This repair does not claim two simultaneous reviews or alter that source state.

## Validation

The local application suite passed 152 tests. The sanitized GitHub snapshot passed 157 tests. JavaScript syntax, dashboard script parsing, PowerShell parsing, live model readback, new-chat allocation, case-review dispatch, and dashboard availability are recorded in the sanitized evidence JSON.
