# Audit protocol

## Ownership and scheduling

- Assign each stable record identifier to one permanent bucket using its hexadecimal value modulo six.
- Permit at most two simultaneous reviewer generations.
- Keep at most five managed bucket conversations in the rotation.
- Treat each source pack as an input boundary, not proof that a bucket or the full population is complete.

## Review and writes

Review only the exact source record supplied for the current action. Do not infer missing source material or substitute another pack. Write at most one terminal result for a stable identifier in its owning registry area. Preserve an existing valid terminal result rather than re-auditing or overwriting it.

Verify each new registry write by reading it back. Completion requires explicit full-population reconciliation, no owned records pending, and no unresolved writes. The expected population is private runtime configuration and is not embedded in this public handoff.

## Response footer

Each completed turn ends with the strict six-line footer:

AUDIT_TURN_STATUS
STATUS: NORMAL | ERROR | COMPLETE
NEW_CASES: non-negative integer
WRITES_VERIFIED: YES | NO | PARTIAL
BLOCKER: non-empty text
TRIGGER_COORDINATOR: YES | NO

A COMPLETE response also requires separate full-reconciliation evidence immediately before the footer. Pack exhaustion alone is insufficient.

## Reviewer model

Every controller send verifies GPT-5.6 Sol and High reasoning effort. This was the highest selectable option in the connected account at the time of the repair. If the selector cannot confirm that exact policy, the action is not sent and the bucket enters HOLD.
