# Recovery status

The local repair adds send-time model verification, a five-conversation managed rotation limit, closure of tracked retired tabs before replacement, and fail-closed recovery for ambiguous new-chat creation. The dashboard exposes the required model policy, per-bucket model verification, chat-creation holds, and current allocation count.

The controller was resumed on the repaired code and verified a fresh `INITIAL_AUDIT` at GPT-5.6 Sol / High. A full Drive listing later confirmed all 1,073 generated packs are present across the six shard folders with no filename gaps, matching the uploaded-pack manifest. Per-shard inventory bounds remain in local runtime data. The controller now reconciles the full corpus when a cursor advances beyond that verified inventory, instead of retrying a nonexistent pack. A legacy boundary can recover to the configured first pack only when no source-pack delivery was recorded; historical `casesReported` totals are not used as a cursor.

Chat IDs, registry identifiers, case totals, source-folder IDs, exact shard boundaries, and runtime paths are excluded from this public file. If full-corpus reconciliation finds pending cases but no later exact pack exists, the bucket remains held with a visible incident rather than being marked complete or repeatedly retrying.

The one pre-fix action that completed at Instant is preserved as existing terminal work. No retroactive row rewrite was attempted. Exact readback and validation results are in `docs/evidence/model-tier-repair-20260920.json`.
