# GPT Online handoff: R4.3.3 Audit Controller

Generated 2026-09-22 from persisted coordination notes and a read-only runtime snapshot. The report writer changed this coordination file only; it did not start or stop services, authenticate a browser, or modify the registry.

## Objective

Restore unattended R4.3.3 audit execution for the finalized population of 65,720 cases while preserving permanent ownership (`int(stable_id, 16) % 6`), one coordinator page, two reusable reviewer slots, at most two live generations, verified registry writes, bounded recovery, and reboot recovery.

The live acceptance gate remains open because no new verified audit result has been written and read back.

## Repository and commit chain

- Repository: `/home/<user>/source-summary-pipeline/Automation-controller-recovery`
- Current repository HEAD: `ccdad96b368496192dc1352e7e2ed51834a528c8`
- Current working tree: clean.
- Recovery work started from the authoritative implementation at `fe3ad67` (`Repair unattended R4.3.3 controller recovery`).
- Relevant commits, in order:
  - `783e7b2` conservative B5 reconciliation and auth readiness.
  - `68ad7d7` owned browser recovery after readiness timeout.
  - `74df86c` explicit persistent browser profile modes.
  - `b9bf7d8` preserve source browser locks during bounded recovery.
  - `70faed8`, `a2266fb`, `3e00e6b`, `343d267` committed/local bootstrap sentinels and CDP attach recovery.
  - `835f45e` bounded persistent browser recovery.
  - `3038bbc` bounded Firefox fallback.
  - `e15aa12` Firefox BiDi transport and stale profile-marker recovery.
  - `2d41696` deterministic spawned-browser fallback startup.
  - `e39e512` extended bounded browser spawn grace.
  - `ccdad96` classify browser challenges as human authentication-required.

### Runtime build mismatch

The repository is at `ccdad96`, but the long-running controller status fingerprint still reports:

- `gitSha`: `e15aa12`.
- `loadedSourceHash`: the hash belonging to the older loaded source.
- `diskSourceHash`: a different hash for the current on-disk source.
- Controller PID: `111246`, started at `2026-09-22T04:55:50Z`.

The current service has not loaded the latest committed classifier change. A controlled deployment/restart is required before treating current HEAD as live.

## Implemented fixes

- Explicit bucket, typed-hold, action, reviewer, browser-slot, and source-pack recovery state machines.
- Scheduler occupancy based on credible live generation evidence; stale reservations do not consume reviewer capacity.
- Two reusable reviewer slots, bounded reviewer rollover, and a hard three-page automation budget.
- Action-aware response reconciliation using action identity plus response identity.
- Setup acknowledgement transitions exactly once into substantive work.
- Invalid, missing, or unproven cursors enter explicit reconciliation; no implicit pack zero.
- Safe durable state writes, restart reconciliation, stale RUNNING detection, PID/heartbeat/build fingerprint, and bounded watchdog recovery.
- Exact source-pack continuation prompts require connected Drive, shard-folder enumeration, exact JSONL filename, terminal-ID skipping, and readback verification.
- Completion remains gated on the configured population and full-corpus reconciliation; pack exhaustion alone cannot complete a bucket.
- Browser attach/startup has bounded timeouts, existing-CDP-first behavior, supported-browser fallback, profile ownership checks, bootstrap sentinels, bounded cleanup, and preserved source-profile locks.
- Firefox persistent fallback uses Playwright BiDi with `headless: false`; Chromium fallback remains separately configured.
- Dashboard and Linux user-level systemd units are present.

## Registry migration audit

The 1,473 ownership corrections were physical row moves between deterministic bucket tabs. Destination rows were copied and read back across all 26 columns before source rows were cleared; substantive fields were preserved. The migration changed row location/ownership placement only. Stable IDs, classifications, rationale/evidence, timestamps, terminal status, reviewer output, and readback fields were not changed.

Post-migration evidence recorded:

- Terminal row count remained 50,355 nonblank-ID rows.
- Cross-bucket duplicates: 0.
- Ownership mismatches after migration: 0.
- No new duplicate rows were created and no existing duplicate rows were deleted.
- The migration did not alter the 34 conflicting duplicate groups.
- New audit writes during recovery: 0.

### Duplicate and malformed-row analysis

The strict registry accounting is:

- 50,355 nonblank-ID terminal rows.
- 50,352 strict 32-hex stable-ID rows.
- 49,830 strict unique valid stable IDs.
- The older loose count of 49,833 included three malformed nonblank ID strings.
- MASTER also contains one blank-ID terminal row, explaining the 50,356 raw terminal-record display.
- 522 extra rows across 522 repeated-ID groups; all remain untouched.
- 488 repeated-ID groups have the same classification. Two of those groups are exact full-row copies; 486 have differences in other row fields and were not deduplicated.
- 34 repeated-ID groups contain conflicting classifications and remain protected for evidence-based reconciliation.
- Three malformed nonblank IDs and one blank-ID row are structurally invalid for stable-ID accounting; none was rewritten.

For scheduler purposes, a structurally valid terminal result remains terminal. Conflicting groups remain an integrity concern and are not silently resolved.

## Per-bucket reconciliation and current state

Per-bucket full populations are not proven by the available evidence. The authoritative audit population remains 65,720. No bucket is marked COMPLETE.

| Bucket | Retained evidence | Current state | Cursor/resume | Scheduler |
|---|---|---|---|---|
| B0 | Available folder range begins at pack 51; earlier prefix lacks a complete finalized-ID manifest. | `HOLD / INTEGRITY` | No proven cursor; no current/last/target pack. | Excluded: `SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED` |
| B1 | Available folder range begins at pack 50; earlier prefix is not fully proven. | `HOLD / INTEGRITY` | No proven cursor; no current/last/target pack. | Excluded: `SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED` |
| B2 | Available folder range begins at pack 49; retained evidence does not content-scan the unresolved earlier prefix. | `HOLD / INTEGRITY` | No proven cursor; no current/last/target pack. | Excluded: `SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED` |
| B3 | Available folder range begins at pack 53; known cursor/history discrepancy remains unresolved. | `HOLD / INTEGRITY` | No safe action-aware boundary proven. | Excluded: `SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED` |
| B4 | Packs 18–72 are terminal-covered. Indexed packs 1–17 contain a nine-ID gap in pack 5, so the earlier prefix cannot be skipped. | `HOLD / INTEGRITY` | Conservative resume cannot skip the pack-5 gap. | Excluded: `SOURCE_PACK_CURSOR_RECONCILIATION_REQUIRED` |
| B5 | Packs 8–32 are terminal-covered; packs 33 onward contain pending owned records. | `PENDING` | Conservative target `pack_000033.jsonl`; consumed through pack 32. | Eligible once browser/pre-dispatch gates pass |

### B5 proof

`config/reconciliation-evidence.json` records a conservative, case-level boundary only:

- contiguous terminal prefix through pack 32;
- exact next target `pack_000033.jsonl`;
- registry terminal set authoritative for skipping already-terminal IDs;
- zero terminal-row or substantive-field changes in the proof;
- terminal rows must not be overwritten;
- every new write must be read back and verified;
- boundary monotonicity required;
- full-corpus reconciliation is false;
- action-aware durable cursor proof is false.

Current runtime projection matches that evidence: B5 is eligible, `sourcePackResumePending=true`, `sourcePackAccessVerified=false`, and the blocker is `source-pack-continuation-pending` until a reviewer can access the exact pack.

## Browser attempts and topology

| Browser | Version | Mode/port | Result |
|---|---|---|---|
| Brave | 152.1.94.119 (Chromium 152.0.7977.76 observed) | Visible persistent source profile; CDP 9333 in earlier deployment | Cloudflare challenge/HTTP 403 and later attach/navigation timeouts. Source profile was preserved; no credentials or prompts entered. |
| Chrome | 153.0.8010.52 | Dedicated fallback service, CDP 9334, display `:10.0`, local bootstrap page | Installed, but fallback service is currently inactive and no endpoint is listening. Earlier runtime discovery/attach attempts failed within bounded deadlines. |
| Firefox | 153.0.4 | Persistent Playwright BiDi, ephemeral remote-debugging port; dedicated fallback profile | Process is alive and connected through the controller, but ChatGPT UI is unreachable/not ready. No Chromium `/json/*` endpoint is expected for this transport. |

Current status reports `browserConnected=true`, `browserTransport=persistent-firefox`, coordinator present, two reviewer slots, and three logical automation pages. It reports `chatgptReady=false`, coordinator `UNREACHABLE`, `composer=false`, and reviewer pages at `about:blank`.

### Why the Firefox window appeared absent

Firefox is not headless. The controller-owned process is PID `132055`, launched with `--foreground`, `DISPLAY=:0`, and the X authority for the active X11 session. X11 root inspection shows four viewable Firefox top-level windows owned by that PID; one is titled `chatgpt.com | 502: Bad gateway — Mozilla Firefox`, and the others have generic Firefox titles. The focused window is viewable.

The apparent absence came from tooling: CUA has no native Firefox connector, and the three Playwright page slots are represented as separate top-level windows/blank placeholders rather than CUA browser tabs. The visible Firefox session therefore exists, but its ChatGPT page is a 502/unreachable page and does not expose a usable conversation composer.

## Current controller, watchdog, dashboard, and systemd state

- Controller: `r433-audit-controller.service`, enabled and active/running, PID `111246`.
- Controller state: `DEGRADED`; run state: `RECONCILIATION_ONLY`.
- Heartbeat: advancing; latest observed snapshot was `2026-09-22T20:52Z`.
- Watchdog: `r433-audit-watchdog.timer` enabled and active/waiting; one-shot service is normally inactive between checks.
- Dashboard: `r433-audit-dashboard.service` active on `http://127.0.0.1:9350/` and returns HTTP 200.
- Dedicated Chrome fallback unit: enabled but inactive/dead.
- User-level systemd autostart is installed; controller startup is bounded and state reconciliation is performed before dispatch.
- Current control file requests `RECONCILIATION_ONLY`.

## Current blockers

1. The running controller is stale relative to repository HEAD; it must load `ccdad96` before the latest auth/challenge classification can be evaluated live.
2. The Firefox ChatGPT page is reachable at the browser layer but currently shows a 502/unusable conversation UI, so `chatgptReady=false` and pre-dispatch is blocked by `BROWSER_NOT_READY`.
3. Control remains `RECONCILIATION_ONLY`; no reviewer prompt can be dispatched.
4. B0–B4 require independent evidence-based cursor/action/readback reconciliation. Their holds must not be globally cleared.
5. B5 has only a conservative case-level target and still requires exact source-pack access, reviewer response reconciliation, and verified writes.
6. Current counters remain zero: processed cases 0, new cases 0, verified writes 0, active generations 0.
7. The current commit test run reports 212 tests with 212 passing. The bounded browser fallback regression was fixed by adding finite child startup grace and bounded low-budget cleanup.

## Files and coordination notes

Source/configuration files changed across recovery include `src/controller.mjs`, `src/protocol.mjs`, `src/browser-runtime.mjs`, `src/reviewer-tabs.mjs`, `src/dashboard.mjs`, `config/reconciliation-evidence.json`, `config/recovered-config.json`, systemd units, installation/bootstrap scripts, README/docs, and browser/controller/protocol tests. Runtime state, profiles, cookies, credentials, tokens, raw source packs, registry dumps, and Drive identifiers are not part of the committed handoff.

Relevant coordination notes:

- `b5-controller.md` — conservative B5 proof and projection.
- `browser-readiness.md` — Brave/Chrome/Firefox investigations and X11 Firefox diagnosis.
- `deploy-fix.md`, `deploy-live.md`, `deploy-source-status.md` — bounded deployment attempts and no-write evidence.
- `population-reconciliation.md` — population and per-bucket pack/registry evidence.
- `pack-scan-B4-B5.md` — B4/B5 content coverage and gaps.
- `integration-review.md` — prior integration and secret-safety review.

## Tests and verification

- Current HEAD syntax checks: `src/controller.mjs`, `src/protocol.mjs`, `src/browser-runtime.mjs`, and `src/reviewer-tabs.mjs` all pass `node --check`.
- Current HEAD `git diff --check`: pass.
- Current HEAD full `npm test`: 212 total, 212 pass, 0 fail.
- Prior bounded-browser integration at `e39e512`: 210/210 passing.
- Prior full suites recorded in coordination notes: 188/188, 194/194, and 200/200 at earlier recovery stages.
- Live acceptance has not passed: no verified new audit write, no active reviewer generation, and no throughput.

## Safe next actions

1. Keep the existing Firefox session/profile intact. Do not launch a second Firefox identity, delete profile markers, or use Chromium `/json/*` probes against BiDi.
2. In a controlled service deployment, load the current repository HEAD and verify the build fingerprint matches both loaded and on-disk source.
3. Inspect the focused visible Firefox window owned by PID 132055 and resolve the ChatGPT 502/network/auth state through the normal visible browser session. Preserve the controller's single BiDi session.
4. Set control to `RUNNING` only after the ChatGPT home/conversation UI exposes a usable composer and the controller reports `chatgptReady=true`.
5. Reconcile B0–B4 individually from durable evidence. Protect unresolved integrity holds; do not infer cursors from pack availability.
6. Allow B5 to continue at pack 33 only after pre-dispatch readiness. Verify one substantive generation, exact-pack access, terminal-ID skipping, readback-verified writes, and monotonic progression.
7. Fix the remaining browser fallback regression, rerun the full suite, and perform a fresh independent live verifier pass.

## Acceptance checklist

- [ ] Running build fingerprint equals current committed HEAD.
- [ ] ChatGPT UI is ready and authenticated in the persistent visible browser.
- [ ] Exactly one coordinator and two reusable reviewer pages are present.
- [ ] At most two actual reviewer generations are active.
- [ ] Control is `RUNNING`; pre-dispatch is ready.
- [ ] B5 dispatches from `pack_000033.jsonl` with terminal skipping and verified writes.
- [ ] No duplicate action or registry write occurs.
- [ ] At least one new result is written and read back successfully.
- [ ] Throughput continues across multiple scheduler cycles.
- [ ] B0–B4 remain protected or are released only by evidence-based individual reconciliation.
- [ ] Watchdog, dashboard, and systemd autostart remain healthy.
- [ ] Final independent verifier confirms live progress and browser topology.
