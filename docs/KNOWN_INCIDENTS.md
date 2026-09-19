# Known Controller Incidents and Diagnoses

These are dated engineering findings from September 2026 debugging.

## 1. Action-insensitive response-hash deadlock

Observed on B1/B3. A new action could target a different pack, but reconciliation was suppressed when logic effectively treated `processedHash === responseHash` as sufficient proof the response was already handled. Identical source-pack-unavailable text across different actions could therefore deadlock progress.

Examples: B1 `A-a99ac408f013af1f` targeting `SOURCE_PACK_CONTINUE pack_000217.jsonl`; B3 `A-a4f47e47b6e06f68` targeting `pack_000054.jsonl`.

Required property: response deduplication must be action-aware (action ID/epoch + response hash), never response-body/hash-only.

## 2. B0 setup-ACK -> INITIAL_AUDIT deadlock

B0 could record protocol setup acknowledgement while a guard prevented dispatch of the first substantive action. A documented blocked action was `A-61fb08872ac58d9c`, targeting `pack_000052.jsonl`.

Required property: setup acknowledgement advances exactly once into the first substantive audit action and cannot be blocked by stale response/action state.

## 3. Missing-pack retry storm

When an exact source pack was unavailable/unverified, the controller could immediately resend the same-pack request without meaningful backoff. Combined with response-hash dedup, this produced no-progress loops. Historical examples: B1 pack 217 and B3 pack 54.

Required property: durable retry state, bounded/backed-off retries, action-aware reconciliation, and coordinator escalation.

## 4. Reviewer stall rollover

Recovered logic used `postGenerationStallMinutes || 90`, so a generation could be considered stalled after **90 minutes**. Expected recovery path: `turnStallReason()` -> `REVIEWER_STALL` -> `stageReviewerStallRecovery()` / `recoverStaleAwaitingReviewers` -> new reviewer chat rollover.

A generation reservation was associated with state such as `awaitingResponseAt` or a `lastAction` beginning with a generating phase.

## 5. Slot accounting / scheduler starvation

Earlier scheduler logic could confuse logical phase with actual browser/CDP occupancy. Repairs moved toward live slot accounting and rebalancing up to the hard maximum of **2** concurrent reviewer generations.

Relevant symbols: `rebalanceExistingReviewerSlots`, `fillReviewerSlots`, `selectPendingBuckets`, `selectReviewerSlotCandidates`, `bucketHasGenerationReservation`.

## 6. Source-pack cursor and boundary progression

Repairs addressed cursor validation, pack-0/default coercion, source-pack boundary progression, and phase-independent reconciliation. The controller must never silently coerce a missing/invalid cursor to `pack_000000.jsonl`.

Historical progression included B3 pack 53 -> 54 and correction of B1 from an erroneous pack-0/default path to its intended later pack sequence.

## 7. Watchdog stale-status failures

Repeated `WATCHDOG_FAILURE` events were observed when `data/status.json` became stale. Recovery must preserve durable registry state and distinguish a genuinely stalled controller from delayed status publication.

## 8. Operations dashboard

An operations dashboard was added. Observed controls: `STOP AUTOMATION`, `RESTART AUTOMATION`, `Refresh`, plus reviewer occupancy/progress information.

## 9. Test status

After the September 17 repair series, the recovered record reports **106/106 tests passing**. The exact test file bodies were not retained in retrievable chat context.

## 10. Registry preservation during anomalies

Preserve every valid existing terminal row exactly as-is. Do not overwrite, relabel, or re-audit a terminalized case merely to reconcile an isolated anomaly. Continue from the next eligible pending owned ID whenever the anomaly does not actually prevent later work.
