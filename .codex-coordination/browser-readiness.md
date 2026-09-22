# Browser readiness (live worker)

Updated: 2026-09-22T01:54Z

STATUS: VISIBLE_BRAVE_ATTACHED

FINDINGS:
- No pre-existing browser process/CDP was present when checked.
- Brave 152.1.94.119 launched once visibly on X display :10.0 using the existing persistent profile `/home/<user>/.config/BraveSoftware/Brave-Browser`, Default profile, CDP `127.0.0.1:9333`.
- CDP is listening; `/json/version` reports Chrome/152.0.7977.76; `/json/list` has one ChatGPT page target plus Codex extension service worker.
- CUA now detects Brave Browser, Personal profile, one visible tab titled `ChatGPT: Chat, Work, Create & Code with AI`, URL `https://chatgpt.com/`.
- Profile metadata/history has no prior ChatGPT/OpenAI history and only four Cloudflare cookies; no retained authenticated ChatGPT session is evidenced.
- No prompts or audit actions were sent.

NEXT CHECK:
- Use bounded CDP/Playwright readiness probe on the live page and classify visible state. If Cloudflare/login is shown, leave this persistent visible browser open as HUMAN_AUTH_REQUIRED; do not relaunch or clone.

LIVE_PROBE (2026-09-22T01:58Z):
- Bounded Playwright/CDP probe eventually attached successfully (20s connect allowance) to the existing page; document readyState=complete.
- Visible body is normal ChatGPT landing UI with “Log in to get answers…”, “Log in”, “Sign up for free”, “Chat with ChatGPT”, and `Ask ChatGPT` textarea. Cloudflare markers are absent.
- This is a stable unauthenticated login state, so controller must expose HUMAN_AUTH_REQUIRED/BROWSER_AUTH_REQUIRED and keep browser open. No login credentials or form data were entered.
- Controller's prior attach attempt used 5s and timed out; current status remains BROWSER_UNAVAILABLE. A bounded larger attach timeout may be needed for this visible Brave session; do not relaunch.

FINAL BOUNDED CHECK (2026-09-22T02:01Z):
- CDP `/json/list`: exactly 3 page targets (one `about:blank`, two `https://chatgpt.com/` landing pages) plus one Codex extension service worker. This meets the three page target cap, though no authenticated conversation is usable.
- Controller systemd user service is active, PID 18176; heartbeat advanced through 02:00:57Z.
- Controller is `DEGRADED`, `RECONCILIATION_ONLY`; dispatch disabled; 0 live generations.
- Dashboard status reports `coordinatorTabPresent=true`, `reviewerTabCount=2`, `automationTabCount=3`, CDP endpoint `http://127.0.0.1:9333`, but `browserConnected=false`, `browserState=CHATGPT_NOT_READY`, blocker `BROWSER_NOT_READY`; this is a status/classifier inconsistency because CDP and page topology are present.
- The live page body is an unauthenticated ChatGPT landing page with visible Log in/Sign up UI; no Cloudflare challenge was present. HUMAN_AUTH_REQUIRED is the correct operational state, but current classifier reports UNREACHABLE/BROWSER_NOT_READY.
- Runtime config was locally set to bounded `browserConnectTimeoutMs=20000`, `browserStartupTimeoutMs=30000` after proving the prior 5s CDP attach timed out; no source code or registry was changed by this worker. Browser was launched once only and remains open; no prompts or login data were entered.

AUTH CLASSIFICATION FIX (2026-09-22T02:06Z):
- Patched `src/reviewer-tabs.mjs`: explicit ChatGPT landing-page markers (`Log in to get answers`, `Sign up for free`, etc.) with no conversation composer now return `AUTH_REQUIRED`, reason `HUMAN_AUTH_REQUIRED`, and evidence `authenticationRequired=true`.
- Patched `src/browser-runtime.mjs` profile-use guard so a live unrelated browser does not falsely mark temporary/non-default profiles busy; implicit default-profile detection now uses the browser process environment. This was required to run tests while the authorized visible Brave session stayed open.
- Added focused regression test in `tests/browser-runtime.test.mjs`.
- Targeted browser tests: 12/12 pass.
- Full suite: 188/188 pass.
- Reloaded controller once; no browser restart. Current status: service active PID 24279, `DEGRADED` + `RECONCILIATION_ONLY`, `AUTH_REQUIRED`, error `HUMAN_AUTH_REQUIRED: visible ChatGPT landing page requires authentication`, blocker `BROWSER_AUTH_REQUIRED`, dispatch disabled, 0 live generations.
- CDP still has exactly 3 page targets: one about:blank and two ChatGPT landing pages. Coordinator and two reviewer slots are present. No login, prompts, registry writes, or audit dispatch.

RUNTIME CHECK (2026-09-22T02:35Z, read-only):
- Commit `783e7b2`; controller PID 33311 active, heartbeat 02:35:03Z; watchdog timer active (last service inactive/dead by timer design).
- B5 is the only scheduler-pending bucket; desired reviewer count 1; B0-B4 remain cursor integrity holds. Dispatch is disabled because browser is unavailable.
- CDP 9333 is listening, but it belongs to a controller-launched Brave process group: wrapper PID 33366, browser PID 33378, automation profile `data/browser-profile/brave-automation`, display `:0`, not the prior visible authenticated profile. CUA sees exactly three `about:blank` pages.
- Automation profile lock is not stale: `SingletonLock -> TC-33378`, PID 33378 is alive. `Default/LOCK` is regular empty file. No safe lock deletion is justified.
- Bounded Playwright attach to the existing CDP endpoint timed out at 20 seconds after WebSocket connected; `/json/version`, `/json/list`, and `/json/protocol` remain responsive. Browser main process is alive (~12.7% CPU), but Playwright protocol initialization is not completing.
- Controller logs prove the sequence: page navigation to `https://chatgpt.com/` timed out, controller marked browser connection lost, then retained the launched browser process. Subsequent retries timed out attaching and then hit `BROWSER_PROFILE_IN_USE` because the still-running owned browser holds the automation lock. This is an owned-browser cleanup/reconnect deadlock, not a stale lock.
- No browser was launched/killed/recloned by this check; no login or audit prompt was sent. No current HUMAN_AUTH_REQUIRED evidence is available because the active pages are blank.

OWNED-RECOVERY PATCH IN PROGRESS (2026-09-22T02:45Z):
- Added `terminateOwnedBrowserProcessGroup()` in `src/browser-runtime.mjs`: verifies Linux process command line contains the exact controller-owned `--user-data-dir`, verifies detached process group, optionally verifies CDP port, sends bounded TERM/KILL only to that group, waits for exit, then removes destination ephemeral locks.
- Controller catch path now invokes this helper only when `ownedBrowserProfile.launched` is true after a browser/readiness failure; external CDP attachments (`launched=false`) cannot be killed.
- Coordinator navigation timeout now performs a bounded health probe. If the page DOM already shows `AUTH_REQUIRED`, it preserves the visible owned browser and continues status generation instead of entering cleanup.
- Syntax checks pass. Targeted/full tests are next; no live browser lifecycle action has been performed.

OWNED-BROWSER RECOVERY COMPLETE (2026-09-22T02:52Z):
- Commit `68ad7d7f1abb4d78d255d6fbe096ee87c0136a76`.
- Added ownership-verified `terminateOwnedBrowserProcessGroup()`: exact user-data-dir + CDP port + detached process-group checks, bounded TERM/KILL, wait for exit, destination-only ephemeral lock cleanup. External CDP attachments cannot enter this path.
- Controller now invokes cleanup after bounded readiness/browser failures only when `ownedBrowserProfile.launched=true`.
- Coordinator navigation timeout probes the page for `AUTH_REQUIRED`; a normal login landing page is preserved and never killed.
- Added cleanup/retry and ownership refusal tests plus auth-preservation static coverage.
- Targeted browser/static tests: 61/61 pass. Full suite: 194/194 pass. `git diff --check` clean.
- No live browser/controller lifecycle action was performed after diagnosis; no audit prompts or registry writes.

## 2026-09-21 source-profile mode implementation in progress
- Browser-only code work is bounded to explicit `browserProfileMode` support.
- Source mode will be the default production mode, attach existing CDP first, validate the configured persistent profile without cloning, and preserve source locks/cookies.
- Clone bootstrap remains available only when mode is explicitly `clone`.
- No live browser lifecycle action, audit prompt, or registry write has been performed.

## 2026-09-21 source-profile mode implementation complete
- Added explicit `browserProfileMode` (`source` or `clone`) with `source` default.
- `connectOrLaunchBrowser` still attaches to existing CDP first; source mode validates and launches the configured persistent profile directly, while clone bootstrap runs only for explicit `clone`.
- Source mode fails closed on active/unknown Linux ownership and does not create directories or remove source locks/cookies. Owned-browser cleanup accepts `cleanupEphemeral:false` for source mode.
- Controller propagates profile mode and never cleans source profile locks during recovery. Local ignored `config.json` now explicitly uses `browserProfileMode: source`, `browserProfileName: Default`.
- Added source launch, active ownership, source preservation, mode validation, config shape, and controller propagation regressions.
- Targeted browser/controller tests: 67/67. Full `npm test`: 200/200. Syntax checks and `git diff --check` pass.
- No live browser lifecycle action, audit prompt, or registry write performed.

## 2026-09-22 read-only Firefox/UI diagnosis
- CUA `getState()` returned `apps:[]`, `browsers:[]`; no CUA browser surface is exposed for this native Firefox session.
- X11 is real and visible: systemd manager/controller/Firefox all have `DISPLAY=:0`, `XDG_SESSION_TYPE=x11`, `XAUTHORITY=/home/<user>/.Xauthority`; no `MOZ_HEADLESS`, `HEADLESS`, Wayland, or headless flag was present.
- Firefox PID 132055 is a child of controller PID 111246: `/usr/bin/firefox --remote-debugging-port=0 --foreground --profile /home/<user>/.config/R433-Firefox-Fallback`; it has no fixed CDP endpoint. It listens on BiDi port 42587. `/json/version`, `/json/list`, `/status` return 404; WebSocket `/session` returns BiDi 101 but `session.status` says `Session already started`, and a new `browsingContext.getTree` is rejected because the controller's session is private.
- X11 root inventory shows four viewable Firefox top-level windows, all `WM_CLASS Navigator/firefox`: three titled `Mozilla Firefox`, one `chatgpt.com | 502: Bad gateway — Mozilla Firefox`; focused window is viewable. Thus the Firefox process is not headless or absent. CUA simply cannot inventory native Firefox here.
- `data/status.json` currently reports `browserConnected:true`, `browserTransport:persistent-firefox`, `browserExecutable:/usr/bin/firefox`, `cdpEndpoint:null`, `coordinatorTabPresent:true`, `reviewerTabCount:2`, `automationTabCount:3`, but `chatgptReady:false`, coordinator `UNREACHABLE` with `composer:false`, both reviewer pages `about:blank`, `activeReviewers:0`, controller `DEGRADED`.
- Root cause of the apparent “no Firefox tabs”: the three-tab count is Playwright logical page slots, not a CUA/native-tab inventory; Firefox persistent Playwright pages are represented as separate top-level windows/blank placeholders, while CUA has no Firefox connector. One visible window is a real ChatGPT 502 page, and the controller has no CDP endpoint; browser readiness failed on unreachable ChatGPT UI.
- Safe next action: keep the visible Firefox process/profile intact and diagnose network/ChatGPT 502 plus the controller's persistent Firefox page mapping/session. Do not use Chromium `/json/*` probes or attempt a second Firefox launch. A bounded Firefox-specific diagnostic should inspect the existing Playwright context/page URLs and close only proven stale extra pages after readiness recovery; no audit dispatch until `chatgptReady` and page topology are verified.
