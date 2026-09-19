# R4.3.3 Audit Protocol

## Ownership and authoritative state

For every case: `bucket = int(stable_id, 16) % 6`.

The canonical registry is authoritative for terminalization. Before review, reconcile `stable_id` against its owning `R433_AUDIT_SHARD_N` tab.

- Skip every valid terminalized `stable_id`.
- Preserve existing terminal rows exactly unless a targeted recovery proves the write itself is defective.
- Do not re-audit a terminalized case merely to make controller state consistent.
- One terminal row per `stable_id` in its owning tab.
- Every new write must be read back and verified.
- The live workflow used `reviewed` as the terminalization flag.

## Exact source requirements

1. Use connected Google Drive access.
2. Open the exact shard folder.
3. List/paginate until the exact requested `pack_NNNNNN.jsonl` is found or the folder listing is fully exhausted.
4. A failed exact-name Drive search alone is not proof that the raw JSONL file is absent.
5. Do not substitute another pack.
6. Do not infer source contents from prior context, READMEs, manifests, or metadata.
7. Only `.jsonl` files are substantive source inputs.
8. Review each eligible case using both `summary_text` and `source_text`; never summary-only.
9. Do not call Qwen, regenerate summaries, modify the production corpus, or rewrite source judgments.

## Terminal classifications

`PASS`, `MINOR`, `FAIL`, `SOURCE_UNAVAILABLE`, `TECHNICAL_REVIEW_FAILURE`.

## Continuation semantics

There is no voluntary per-turn case quota. Continue across case, pack, group, and run boundaries as long as the turn can safely proceed. If currently visible packs are exhausted while owned cases remain pending, use blocker `NEXT_SOURCE_PACKS_REQUIRED`; this is not completion.

## Strict six-line footer

```text
AUDIT_TURN_STATUS
STATUS: NORMAL / ERROR / COMPLETE
NEW_CASES: <number>
WRITES_VERIFIED: YES / NO / PARTIAL
BLOCKER: NONE or <brief blocker>
TRIGGER_COORDINATOR: YES / NO
```

Use one concrete value per line. Meaningful blockers include `NEXT_SOURCE_PACKS_REQUIRED`, `SOURCE_PACK_UNAVAILABLE_OR_UNVERIFIED`, or a specific unresolved write/reconciliation failure.

## COMPLETE semantics

`STATUS: COMPLETE` is permitted only after reconciliation against all **65,720** finalized summaries proves every owned ID is terminalized, `OWNED_PENDING_CASES: 0`, and no unresolved writes remain. Pack exhaustion alone is never enough.

Completion-candidate evidence immediately before the footer:

```text
FULL_CORPUS_RECONCILED: YES
FULL_CORPUS_AUDITABLE_POPULATION: 65720
OWNED_PENDING_CASES: 0
```

Corpus-wide reconciliation must also avoid duplicate reviewed IDs across shards and missing assigned IDs.

## Systematic-pattern rules

- same `FAIL` family >= 3 within a shard; or
- same `MINOR/FAIL` family >= 5 within a shard.

Known families include S3/S4/S5/S6, party/court/date/ID, omission, hallucination, contradiction, overstatement, and understatement.
