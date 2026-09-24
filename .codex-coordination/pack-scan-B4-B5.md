# B4/B5 source-pack content scan

**Mode:** read-only Drive and registry scan; no controller, runtime, or registry writes.
**Timestamp:** 2026-09-21 UTC.
**Scope:** authoritative `UPLOAD_READY/shard_4` and `UPLOAD_READY/shard_5` folders; all available JSONL packs.
**Registry comparison:** live `R433_AUDIT_SHARD_4` and `R433_AUDIT_SHARD_5` ranges, using only valid stable IDs with an allowed terminal classification (`PASS`, `MINOR`, `FAIL`, `SOURCE_UNAVAILABLE`, `TECHNICAL_REVIEW_FAILURE`). Raw IDs and source text were not retained.

## Aggregate result

| Bucket | Packs | Records | Valid records | Unique valid IDs | Terminal in owner shard | Missing/nonterminal | Malformed | Duplicate rows | Wrong-owner rows | Bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B4 | 196 (18–213) | 9,795 | 9,795 | 9,795 | 2,750 | 7,045 | 0 | 0 | 0 | 402,174,112 |
| B5 | 199 (8–206) | 9,910 | 9,910 | 9,910 | 1,250 | 8,660 | 0 | 0 | 0 | 404,453,000 |

Cross-pack duplicate rows: **0** for both buckets. Every valid record had a 32-hex stable ID, parsed as JSON, matched its folder’s bucket by `int(stable_id, 16) % 6`, and carried the expected source `bucket` field.

## Per-pack compressed coverage

The following ranges have identical per-pack counts; this is the complete per-pack result compressed by contiguous equal metrics.

| Bucket / packs | Records | Valid | Terminal | Missing/nonterminal | Malformed | Duplicate | Wrong-owner |
|---|---:|---:|---:|---:|---:|---:|---:|
| B4 packs 18–72 | 50 each | 50 each | 50 each | 0 each | 0 | 0 | 0 |
| B4 packs 73–212 | 50 each | 50 each | 0 each | 50 each | 0 | 0 | 0 |
| B4 pack 213 | 45 | 45 | 0 | 45 | 0 | 0 | 0 |
| B5 packs 8–32 | 50 each | 50 each | 50 each | 0 each | 0 | 0 | 0 |
| B5 packs 33–205 | 50 each | 50 each | 0 each | 50 each | 0 | 0 | 0 |
| B5 pack 206 | 10 | 10 | 0 | 10 | 0 | 0 | 0 |

## Boundary findings

- **B4:** earliest pending/missing pack **73**; latest all-terminal contiguous prefix **18–72**. Packs 73–213 contain 7,045 valid, formula-owned records not present as terminal rows in the B4 owner shard.
- **B5:** earliest pending/missing pack **33**; latest all-terminal contiguous prefix **8–32**. Packs 33–206 contain 8,660 valid, formula-owned records not present as terminal rows in the B5 owner shard.
- There were no malformed lines, duplicate stable IDs within a pack, cross-pack duplicate IDs, or ownership mismatches in either bucket.
- The all-terminal prefixes establish source/registry coverage for those ranges. They do **not** by themselves prove controller consumption, action identity, response reconciliation, or a durable cursor checkpoint.
- The later-pack results provide a conservative content boundary: any resume point at or before B4 pack 73 / B5 pack 33 would encounter valid pending records; replay must still use terminal-row skipping and verified writes.

## Safety conclusion

The blanket integrity holds cannot be released solely from this scan because action-to-response-to-readback provenance and full-corpus completion evidence remain absent. However, B4 and B5 now have independently established content boundaries: B4 terminal prefix ends at pack 72 and B5 terminal prefix ends at pack 32. No evidence supports skipping directly beyond those boundaries. No registry rows were changed.
