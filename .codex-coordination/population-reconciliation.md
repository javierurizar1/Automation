# R4.3.3 population and pack-prefix reconciliation

**Status:** READ_ONLY_ANALYSIS_COMPLETE
**Timestamp:** 2026-09-22 UTC
**Registry:** `[REDACTED_PRIVATE_REGISTRY_ID]`
**Scope:** live Google Sheets reads, bounded Drive folder listings, existing B4/B5 content scan; no registry, controller, runtime, or source-pack writes.

## Population authority

- `MASTER` reports **65,720** total finalized population and 50,356 terminal records.
- `CONFIG` reports **65,792** production population, **65,720** finalized summaries, and **72** provider-terminal failures. The arithmetic reconciles exactly: `65,720 + 72 = 65,792`.
- The controller audit population must therefore remain **65,720 finalized summaries**. The 65,792 value is the broader production input and includes 72 cases outside the finalized-summary audit population.
- `CONFIG` explicitly says per-bucket population is not verified from a full stable-ID manifest. `MASTER` shows every bucket population as `UNVERIFIED` and completion as `N/A`.
- A Drive file titled `R433 derived canonical terminal ID manifest 2026-09-14` exists, but contains only **12,236 unique IDs**; it is a partial terminal manifest and cannot establish the 65,720-case universe or per-bucket populations.
- **Authoritative total:** 65,720 finalized-summary IDs by the registry’s own MASTER/CONFIG authority. **Authoritative per-bucket populations:** unavailable from current evidence.

## Current registry ID accounting

The six shard tabs were read in bounded `A:F` chunks and checked using the permanent `int(stable_id, 16) % 6` rule.

- 50,355 nonblank-ID terminal rows exist in the six shard tabs.
- 50,352 rows contain a strict 32-hex stable ID.
- Three additional terminal rows contain malformed 31-character IDs: one each in B0, B3, and B5. They are not valid stable IDs and must not be counted in the authoritative ID universe.
- Strict valid unique IDs: **49,830**.
- If malformed nonblank strings are counted as ID-like keys, the loose count is **49,833**, which explains the earlier project report. This is not the strict valid-ID count.
- The six shard tabs also contain one blank-ID terminal row in B3, matching MASTER’s 50,356 terminal-record total.
- Strict valid duplicate accounting: **522 extra rows across 522 repeated-ID groups**; 488 groups have one classification, 34 groups have conflicting classifications. Two same-class groups are exact full-row copies; the remaining same-class groups differ in other row fields. Cross-shard duplicate groups: 0. Ownership mismatches: 0.

| Bucket | Strict valid rows | Strict unique IDs | Extra duplicate rows | Conflict groups | Malformed nonblank IDs |
|---|---:|---:|---:|---:|---:|
| B0 | 11,446 | 11,330 | 116 | 7 | 1 |
| B1 | 11,366 | 11,366 | 0 | 0 | 0 |
| B2 | 9,997 | 9,997 | 0 | 0 | 0 |
| B3 | 10,897 | 10,504 | 393 | 27 | 1 |
| B4 | 4,144 | 4,131 | 13 | 0 | 0 |
| B5 | 2,502 | 2,502 | 0 | 0 | 1 |
| **Total** | **50,352** | **49,830** | **522** | **34** | **3** |

These are observed terminal-set counts, not full owned-population counts. The 34 classification conflicts and malformed rows remain untouched.

## B4/B5 source-pack coverage

Direct Drive folder listings are complete and gap-free over the currently available ranges:

| Bucket | JSONL packs | Available range | Records scanned | Terminal in owner registry | Missing/nonterminal | First pending pack |
|---|---:|---|---:|---:|---:|---:|
| B4 | 196 | 18–213 | 9,795 | 2,750 | 7,045 | 73 |
| B5 | 199 | 8–206 | 9,910 | 1,250 | 8,660 | 33 |

The existing bounded content scan found zero malformed lines, duplicate IDs, cross-pack duplicates, or ownership mismatches. B4 packs 18–72 are all terminal-covered; packs 73–213 contain 7,045 valid records not present as terminal rows. B5 packs 8–32 are all terminal-covered; packs 33–206 contain 8,660 valid records not present as terminal rows.

Earlier indexed prefixes were checked against the current registry:

- **B4 packs 1–17:** PACK_INDEX contains 850 IDs. 841 are present as exact valid registry IDs; **9 are missing**, all from pack 5. None of those 9 appears in REVIEW_QUEUE or RECONCILIATION_ARCHIVE. Therefore B4’s earlier prefix is **not fully exhausted**; the first unresolved evidence is pack 5.
- **B5 packs 1–7:** PACK_INDEX contains 350 IDs, and all 350 are present as exact valid registry IDs in B5. Together with the all-terminal scan of packs 8–32, B5’s case-level terminal coverage reaches pack 32; the first currently pending source evidence is pack 33.

The prefix checks establish case-level registry coverage only. They do not prove reviewer action identity, response reconciliation, or a durable controller cursor.

## Other bucket prefix status

- B0 available folder range is 51–221; B1 is 50–216; B2 is 49–217; B3 is 53–223. The available ranges have no filename gaps.
- PACK_INDEX provides complete stable-ID lists only for B0 packs 1–13 and B1–B3 packs 1–20. DRIVE_PACK_INDEX lists wider earlier prefixes, but most entries are `LISTED_NOT_YET_PARSED` and do not provide complete per-case ID evidence.
- B0/B1 available ranges were content-scanned and all scanned records matched terminal registry IDs, but their missing earlier prefixes are not fully represented by a complete stable-ID manifest.
- B2/B3 available ranges were not content-scanned in the retained evidence. Their missing earlier prefixes therefore remain unresolved; B3 also retains the known unresolved cursor/history issue.
- No bucket’s durable action-aware cursor is proven by this analysis. No bucket should be marked COMPLETE from pack exhaustion or filename availability alone.

## Decision

- Preserve the controller’s 65,720 audit population.
- Treat per-bucket full populations as **UNKNOWN** until a complete finalized stable-ID manifest or equivalent full-corpus reconciliation is available.
- B5 has a conservative case-level boundary through pack 32 and can resume at pack 33 only after the controller’s browser/action/readback gates are satisfied; its durable cursor is still unproven.
- B4 cannot skip its indexed pack-5 gap; the nine missing IDs require reconciliation before declaring the earlier prefix exhausted.
- B0–B3 earlier prefixes remain unresolved under the evidence above.
- No registry or runtime records were modified.
