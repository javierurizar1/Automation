# Automation — R4.3.3 Audit Controller

This repository is the project handoff and recovery base for the **R4.3.3 Audit Controller** used to coordinate audit review of **65,720 finalized summaries**.

## Canonical project identity

- Local project root: `C:\Users\javi_\.codex\Apps\R433AuditController`
- Controller UI: `http://127.0.0.1:9350/`
- Canonical registry: Google Sheet ID `1N1JyWple9cs3-P-lWdGBIeZEUD0SlEsLNYC60AEvKuw`
- Permanent ownership rule: `bucket = int(stable_id, 16) % 6`
- Buckets: `B0` through `B5`
- Maximum concurrent reviewer generations: **2**
- Terminal classifications:
  - `PASS`
  - `MINOR`
  - `FAIL`
  - `SOURCE_UNAVAILABLE`
  - `TECHNICAL_REVIEW_FAILURE`

## Core invariants

1. A `stable_id` belongs to exactly one bucket forever: `int(stable_id,16) % 6`.
2. Exactly one terminal registry result is allowed per `stable_id` in its owning shard tab.
3. Existing valid terminal rows are preserved and skipped; they are not re-audited merely to reconcile controller state.
4. Every new registry write must be read back and verified.
5. Pack-local exhaustion is **not** corpus completion.
6. `STATUS: COMPLETE` is allowed only after full-population reconciliation against all **65,720** finalized summaries proves zero owned pending IDs and no unresolved writes.
7. Reviewer source retrieval must use the exact connected Google Drive shard and exact requested JSONL pack. A failed exact-name Drive search is not proof of absence; the shard folder must be listed/paginated until the pack is found or the listing is exhausted.
8. Do not substitute another pack and do not infer source content from prior context.
9. Only `.jsonl` source packs are substantive audit inputs; README/manifests/metadata/archive material is not a substitute for source text.

## Repository contents

- `docs/PROJECT_CONTEXT.md` — architecture, mappings, registry IDs, controller behavior.
- `docs/AUDIT_PROTOCOL.md` — reviewer-side protocol, ownership, write verification, completion semantics.
- `docs/KNOWN_INCIDENTS.md` — diagnosed controller/scheduler incidents and unresolved blockers.
- `docs/RECOVERY_STATUS.md` — latest recoverable operational state and important pack/action references.
- `docs/CODE_RECOVERY_GAPS.md` — which original local source bodies were not recoverable from chat history.
- `config/recovered-config.json` — machine-readable recovered project constants.
- `src/recovered-invariants.mjs` — reconstructed helper code containing only documented project invariants; it is **not** represented as the original controller source.
- `tools/publish-local-project.ps1` — explicit script for importing the real local project tree into this repository from the known Windows project path.

## Important source-code note

The GitHub repository was empty when this handoff was created. The prior conversation record preserved architecture, identifiers, state transitions, symbol names, tests/fixes, and incident details, but not complete literal bodies for the local files such as `src/controller.mjs`, `src/protocol.mjs`, `src/operations.mjs`, `dashboard.html`, or the full test suite.

Accordingly, this repository distinguishes:

- **Recovered authoritative context**: facts and constraints carried forward from the live project.
- **Reconstructed helper code**: code derived directly from those documented invariants.
- **Original local implementation**: still located at the known local project path and should be imported verbatim with the provided publishing script rather than reconstructed from memory.

## Current high-value controller symbols previously observed

`rebalanceExistingReviewerSlots`, `fillReviewerSlots`, `selectPendingBuckets`, `selectReviewerSlotCandidates`, `bucketHasGenerationReservation`, `turnStallReason`, `stageReviewerStallRecovery`, `recoverStaleAwaitingReviewers`, `recoverRetryableExactPackHolds`, `recoverAdvisoryCoordinatorHolds`, and `recoverRetryablePartialWriteHolds`.

See the docs for the diagnosed behaviors around `processedHash`, `responseHash`, `SOURCE_PACK_CONTINUE`, setup ACK delivery, source-pack progression, slot accounting, and reviewer-stall rollover.
