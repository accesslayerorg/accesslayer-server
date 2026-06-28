# Price Alert Threshold Check Workflow

This document outlines the workflow and execution sequence for price alerts following a trade event. Contributors modifying the indexer or alert system must understand this sequence to ensure changes do not break the interaction between trade execution and alert processing.

## Execution Sequence

The price alert evaluation process follows a strict sequence:

1. **Trade Event Written**: A new trade event (buy/sell) is successfully indexed and written to the primary ledger/database.
2. **Price Snapshot Updated**: The system updates the underlying price snapshot for the given creator to reflect the latest trading activity.
3. **Alert Check Triggered**: Once the new price snapshot is finalized and committed, the system triggers the alert evaluation process.

## Synchronous vs. Queued Execution

The alert check process is **queued (asynchronous)**.
- It is intentionally decoupled from the main trade indexing transaction. This ensures that the evaluation of potentially thousands of alerts does not block or degrade the performance of core trade event ingestion.
- Once the trade is written and the price snapshot updated, a background job is enqueued to handle the alert processing.

## Multi-Alert Evaluation

To optimize performance, multiple alerts for the same creator are evaluated in a **single pass**.
- When the alert worker picks up the job, it retrieves all active price alerts configured across all users for that specific creator.
- The newly updated price snapshot is evaluated against all threshold conditions in memory simultaneously.
- Triggered alerts are batched together and dispatched to the notification service in bulk, minimizing database queries and network overhead.

## Failure Handling

Because the alert check is asynchronous, **a failure in the alert evaluation process does not impact or roll back the trade event.**
- If a trade event is successfully written but the subsequent alert check fails (e.g., due to a temporary worker crash or notification service downtime), the trade remains permanently indexed.
- The failed alert check job is governed by a retry policy. It will be re-attempted automatically.
- If the job exhausts its maximum retry attempts, it is routed to the Dead-Letter Queue (DLQ) for manual inspection, guaranteeing that the failure is recorded without compromising trade integrity.
