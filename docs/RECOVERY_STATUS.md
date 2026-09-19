# Recovery Status Snapshots

These are dated facts from prior project conversations, not a live query of the local controller.

## September 18, 2026

### Bucket 0

A full-corpus reconciliation reported:

```text
FULL_CORPUS_RECONCILED: YES
FULL_CORPUS_AUDITABLE_POPULATION: 65720
OWNED_PENDING_CASES: 0
```

Bucket 0 owned **11,046** finalized IDs and all were terminalized. Existing anomalous/disputed terminal rows were preserved rather than rewritten. This is the strongest recovered evidence that B0 was complete as of September 18.

### Bucket 1

The exact next-pack work repeatedly referenced `pack_000217.jsonl` in shard 1 (`1Iuk_HValMXjtkEMjLSX1qf0J-e8u0jTH`). The controller incident record also ties this pack to action `A-a99ac408f013af1f`. Treat pack 217 as the latest recoverable B1 target unless the live registry/controller state proves it has since advanced.

### Bucket 2

A recovery turn verified pack 111 rows 5860–5909 without repair. A subsequent continuation found `pack_000134.jsonl` partially terminalized and resumed at case 26.

### Bucket 3

Earlier controller debugging had been blocked around packs 53/54, but later September 18 project turns were requesting much later exact packs, including `pack_000177.jsonl`. Therefore the 53/54 incident is historical and must not be used as the latest B3 cursor.

### Bucket 4

Exact shard-4 packs 33 and 34 were located/verified; each yielded 50 owned cases with writes readback-verified. Further packs were still required afterward.

## September 17 controller engineering snapshot

- Controller process reported RUNNING; PID 53264.
- Hard maximum reviewer generations: 2.
- B2/B4/B5 were marked scheduling-blocked in that snapshot.
- Diagnosed B0 setup-ACK -> initial-audit transition failure.
- Diagnosed B1/B3 action-insensitive response-hash reconciliation deadlock.
- Diagnosed missing-pack rapid-retry behavior.

Historical action/source references:

- B0 `A-61fb08872ac58d9c` -> `pack_000052.jsonl`
- B1 `A-a99ac408f013af1f` -> `SOURCE_PACK_CONTINUE pack_000217.jsonl`
- B3 `A-a4f47e47b6e06f68` -> `pack_000054.jsonl`
- B0 coordinator delivery `INC-B0-2026-09-17T185708413Z-56afc710bba0a541`
- B1 protocol action reference `A-e09c6cb5a7304cfb`

These IDs are retained for forensic comparison with local state/logs if still present.

## Historical dashboard snapshot

```text
Verified terminal:        19627
Live terminal:            37842
Live remaining:           27878
Substantive verified:     19512
Progress:                 57.58%
Rate:                     ~351.8–352.6 cases/hour
ETA:                      ~4d 19h
```

These are historical metrics only.

## Reconciliation points when the local controller is resumed

Compare `config.json`, `data/status.json`, `data/state.json`, `data/control.json`, current reviewer/CDP tabs, canonical registry terminal counts, and the current exact pack cursor per bucket. The canonical registry outranks controller-local counters.
