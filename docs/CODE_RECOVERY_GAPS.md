# Source and recovery boundary

The runnable controller and dashboard source are now included in src/, dashboard.html, the launcher and watchdog scripts, and tests/. The source was copied from the local project and validated as part of this repair.

The public repository intentionally excludes the local config.json, conversation and registry identifiers, browser profile, cookies, case/source data, runtime databases, and logs. Source-shard folder IDs and start offsets are replaced with placeholders in the public review copy. Use the redacted config/recovered-config.json only as a shape reference; the local app retains the real mappings.

src/recovered-invariants.mjs is a historical helper, not the production controller. src/controller.mjs and src/reviewer-model.mjs contain the current runtime behavior.
