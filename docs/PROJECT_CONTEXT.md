# Recovered Project Context

This document records project facts recoverable from the prior R4.3.3 Automation work. Dated operational states are snapshots, not assumptions about the present runtime.

## Project

- Name: **R4.3.3 Audit Controller**
- Local root: `C:\\Users\\javi_\\.codex\\Apps\\R433AuditController`
- Local UI: `http://127.0.0.1:9350/`
- Audit population: **65,720 finalized summaries**
- Permanent ownership: `int(stable_id, 16) % 6`
- Buckets: `B0`–`B5`
- Maximum simultaneous reviewer generations: **2**
- Controller model: a local orchestrator coordinates ordinary ChatGPT reviewer chats; reviewers use connected Google Drive access for exact source packs and the canonical Google Sheets registry for durable terminal results.

## Canonical registry

Google Sheet ID: `1N1JyWple9cs3-P-lWdGBIeZEUD0SlEsLNYC60AEvKuw`

| Bucket | Ownership | Tab | sheetId |
|---|---|---|---:|
| B0 | `int(stable_id,16)%6 == 0` | `R433_AUDIT_SHARD_0` | 2074776203 |
| B1 | `int(stable_id,16)%6 == 1` | `R433_AUDIT_SHARD_1` | 1364935991 |
| B2 | `int(stable_id,16)%6 == 2` | `R433_AUDIT_SHARD_2` | 1230691417 |
| B3 | `int(stable_id,16)%6 == 3` | `R433_AUDIT_SHARD_3` | 1702779998 |
| B4 | `int(stable_id,16)%6 == 4` | `R433_AUDIT_SHARD_4` | 1695624695 |
| B5 | `int(stable_id,16)%6 == 5` | `R433_AUDIT_SHARD_5` | 1400921643 |

Historical backup spreadsheet reference: `https://docs.google.com/spreadsheets/d/1DqKQ_izLuAHISWbTgg_2133eFHdfk69aBsKTn30tP8k/edit`. Do not confuse it with the canonical registry above.

## Source-pack Drive shards

| Bucket | Historical configured start pack | Drive folder ID |
|---|---:|---|
| B0 | 51 | `1RcH8RlsKfuU_Az0HQZF6fTpzi_zM9P3t` |
| B1 | 50 | `1Iuk_HValMXjtkEMjLSX1qf0J-e8u0jTH` |
| B2 | 49 | `1bJw77Eog_l6DdHbrPeuREnzX7QtjR5y_` |
| B3 | 53 | `1IT8g_IwIvoGkhFuyNoKVYYQ5wpxhk8by` |
| B4 | 18 | `1gUp74kctnt4QTce7Uucs9omc5ze9PFPO` |
| B5 | 8 | `1d7ajaUPfnq9ntVXJotSn8oNjiSP1_EYE` |

Historical Drive root `R4.3.3 GPT Online Audit Packs`: `12U6uVYHyWzwD6fAV24r0v6LAaCDb1RO4`. Historical `UPLOAD_READY`: `1zAkFwQzWePNpLjja5JcIzbRMoX4pdfZx`.

## Terminal taxonomy

`PASS`, `MINOR`, `FAIL`, `SOURCE_UNAVAILABLE`, `TECHNICAL_REVIEW_FAILURE`.

Observed failure families include S3/S4/S5/S6, party/court/date/ID, omission, hallucination, contradiction, overstatement, and understatement. Systematic flags were documented at same FAIL family >=3 or same MINOR/FAIL family >=5 within a shard.

## Controller/UI behavior

UI controls observed: `STOP AUTOMATION`, `RESTART AUTOMATION`, `Refresh`. Status concepts included operating/scheduled/held reviewers, verified/live terminal counts, live remaining, substantive verified, progress/rate/ETA, and per-bucket action/source-pack state.

## Known local files

```
src/controller.mjs
src/protocol.mjs
src/operations.mjs
dashboard.html
config.json
package.json
Start-Controller.ps1
Stop-Controller.ps1
data/status.json
data/state.json
data/control.json
tests/...
```

High-value symbols previously observed: `rebalanceExistingReviewerSlots`, `fillReviewerSlots`, `selectPendingBuckets`, `selectReviewerSlotCandidates`, `bucketHasGenerationReservation`, `turnStallReason`, `stageReviewerStallRecovery`, `recoverStaleAwaitingReviewers`, `recoverRetryableExactPackHolds`, `recoverAdvisoryCoordinatorHolds`, `recoverRetryablePartialWriteHolds`.

## Completion rule

Pack-local exhaustion is not completion. `STATUS: COMPLETE` requires full-population reconciliation against all 65,720 finalized summaries, zero owned pending IDs, and no unresolved writes.
