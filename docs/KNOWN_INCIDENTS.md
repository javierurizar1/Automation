# Known incidents

## Lower-tier reviewer selected

The controller previously sent actions without verifying the selected model or reasoning effort. This allowed a completed turn to run at Instant. The repair enforces GPT-5.6 Sol with High reasoning immediately before each send and records the verified selection on the dashboard. Model-selection failure holds the bucket and does not trigger an automatic coordinator retry.

One action already in flight completed at Instant before the repair. Its verified writes and terminal rows were preserved; this repair did not retroactively rewrite or re-audit them.

## Duplicate or unrelated chats after uncertain setup

An earlier creation path could retry after setup delivery or conversation-ID discovery was ambiguous. That could leave a paused conversation behind and open another. The repair persists creation reservations, preserves the tab, holds the bucket, and disables automatic retry for ambiguous outcomes. Legacy retry states are migrated to this hold.

## Capacity

The scheduler permits two live reviewer generations and five managed bucket conversations. The dashboard reports both limits and the current managed-chat count.
