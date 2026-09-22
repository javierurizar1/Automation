# Live deployment checkpoint

Updated: 2026-09-22T02:29:20Z

STATUS: DEPLOYED_RECONCILIATION_ONLY

- Repository HEAD: 783e7b210f1e1820aaa41f0e19fe6ea1663435c4
- Pre-restart controller: PID 24279, loaded fe3ad67, DEGRADED/RECONCILIATION_ONLY, browser disconnected, 3 CDP page targets, no dispatch.
- Restart: systemctl --user restart r433-audit-controller.service at 2026-09-22T02:25 CST; no direct browser/login/registry action.
- Current controller: PID 33311, loaded/disk/source SHA 783e7b2 (source hash 4b546674e67bf5c0af2a32137123b3bc03b12641a54fcba3ac0dcc163753aff2), heartbeat 2026-09-22T02:28:01.933Z, service active.
- Dashboard: active on http://127.0.0.1:9350.
- Watchdog timer: enabled; prior state DEGRADED with recovery-limit reached for BROWSER_DISCONNECTED; controller remains reconciliation-only.
- CDP: 127.0.0.1:9333 listening, Brave PID 33378. `/json/list` shows 3 page targets. Initial Playwright/CDP attach failed because ChatGPT target navigation hung; direct bounded CDP `Page.stopLoading` restored page responsiveness, and a direct read-only Playwright connect then succeeded with 3 about:blank pages.
- Controller has not yet retried after its bounded 120s backoff, so status remains browserConnected=false / BROWSER_UNAVAILABLE, coordinatorTabPresent=false, reviewerTabCount=0, automationTabCount=0, dispatchEnabled=false, no prompts or registry writes.
- B5 projection: PENDING, target/next pack_000033.jsonl, lastConsumed pack_000032.jsonl, scheduler exclusion null and eligible true once pre-dispatch is ready.
- B0-B4: protected INTEGRITY hold SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED.
- No registry writes or audit writes performed.

NEXT: allow controller bounded retry to attach to now-responsive CDP without restarting browser; verify resulting topology/auth classifier. Keep dispatch disabled unless authenticated ChatGPT + explicit RUNNING control + all reconciliation gates pass.
