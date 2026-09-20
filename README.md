# R4.3.3 Audit Controller

This repository contains the runnable local audit controller, dashboard, regression tests, and review protocol. Runtime configuration, browser profiles, chat state, case data, and logs remain local and are excluded from version control.

## Operating limits

- At most two reviewer generations run at once.
- At most five managed bucket conversations are kept in rotation across six stable buckets.
- Before replacement, close tabs matching saved retired bucket conversations; leave unrelated tabs untouched.
- Each bucket owns records by the stable ID modulo six rule.
- Every new send verifies GPT-5.6 Sol with High reasoning effort before composing the action. The controller holds that bucket if it cannot confirm the required model and effort.
- Uncertain new-chat creation stays held. The controller preserves the existing tab and never retries automatically when a retry might create a duplicate conversation.
- Existing terminal registry results are preserved.

GPT-5.6 Sol was the highest selectable option verified in the connected account during this repair. Availability depends on that account. The controller does not claim an inaccessible upgrade option.

## Local setup

1. Install the pinned Node.js dependencies with npm ci.
2. Create a private root config.json using config/recovered-config.json as a shape reference. Supply the local project, registry, bucket, and conversation settings. Do not commit the completed config.
3. Start the controller with Start-Controller.ps1. It connects to the dedicated Chrome CDP session and serves the dashboard on the configured loopback port.
4. Open the dashboard locally. The default address is http://127.0.0.1:9350/.

The example config contains placeholders and is not runnable as-is. Never publish chat IDs, service identifiers, cookies, tokens, browser profiles, case data, or runtime state. This review copy also replaces private source-shard folder IDs and operational pack offsets with placeholders; it is not a production checkout.

## Validation

Run npm test for protocol parsing, bucket scheduling, new-chat recovery, model enforcement, operations, and watchdog coverage.

## Key files

- src/controller.mjs: scheduling, reconciliation, send gating, and safe chat creation.
- src/reviewer-model.mjs: required model and reasoning-effort selection with fail-closed verification.
- src/reviewer-tabs.mjs: match retired tracked tabs without selecting unrelated pages.
- dashboard.html and src/dashboard.mjs: local status and per-bucket model verification.
- src/protocol.mjs and src/operations.mjs: review protocol and dashboard metrics.
- tests/: controller and protocol regression coverage.
- docs/: sanitized project context, repair summary, and evidence.
