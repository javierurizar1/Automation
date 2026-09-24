# Project context

The R4.3.3 Audit Controller coordinates local ChatGPT reviewer conversations for a six-bucket audit. Bucket ownership is stable and derived from the stable record identifier modulo six. At most two generations may run concurrently; up to five bucket conversations are allocated and rotated.

## Components

- The controller connects to a dedicated local Chrome CDP session, reconciles each bucket conversation, and dispatches bounded review actions.
- The dashboard reads local status and shows scheduling, held buckets, chat allocation, and the model and effort verified before each send.
- The protocol module validates response footers and completion evidence.
- The operations module calculates local progress and reviewer-slot occupancy.
- The watchdog and coordinator scripts support local recovery and notification.

## Model policy

Every send must use GPT-5.6 Sol at High reasoning effort, the highest selectable model verified in the connected account during this repair. The controller checks the selector state before sending and holds the bucket if the model or effort is unavailable. No lower-tier fallback is allowed.

## Chat creation policy

A durable reservation is recorded before creating a new chat. If setup delivery or conversation-ID discovery is uncertain, the tab and reservation are preserved and the bucket is held. Legacy retry states migrate to the same hold. This prevents an ambiguous send from silently opening duplicate or unrelated conversations.

## Data boundary

The root config.json, registry and project identifiers, conversation IDs, source-shard folder IDs and start offsets, browser profile, case/source data, runtime state, and logs are local only. The committed config file is a redacted shape example. No live case or registry records are included here.
