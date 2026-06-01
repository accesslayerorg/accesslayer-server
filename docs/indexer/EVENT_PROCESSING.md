# Chain Event Processing

The indexer processes events from the blockchain to update the read models and activity feeds. To ensure data consistency and prevent duplicate processing, the following strategies are employed.

## 1. Deduplication

Before processing a batch of events, they should be deduped based on their unique identifier on the chain: `transactionHash` and `eventIndex`.

The `dedupeChainEvents` helper in `src/utils/indexer-dedupe.utils.ts` provides this functionality.

### Example Usage:

```typescript
import { dedupeChainEvents } from '../utils/indexer-dedupe.utils';
import { processIndexerChainEvents } from '../utils/indexer-event-processor.utils';

const rawEvents = fetchEventsFromChain();
const uniqueEvents = dedupeChainEvents(rawEvents);

// Process each event with structured latency logging
await processIndexerChainEvents(uniqueEvents, async event => {
   await handleChainEvent(event);
});
```

## 2. Idempotency

Event handlers must be idempotent. This means that processing the same event multiple times should have the same effect as processing it once.

### Strategies for Idempotency:

- **Database Upserts**: Use Prisma's `upsert` or `update` with unique constraints where possible.
- **State Check**: Before applying a change (like incrementing a balance), verify if the event has already been accounted for (e.g. by checking a `lastProcessedLedger` or a specific event log).
- **Atomic Transactions**: Ensure that all changes related to an event are committed in a single database transaction.

## 4. Structured latency logging

Each processed chain event emits one info-level structured log via
`processIndexerChainEvent` in `src/utils/indexer-event-processor.utils.ts`.

The log includes:

| Field        | Description                                          |
| :----------- | :--------------------------------------------------- |
| `type`       | Always `indexer_event_processed`                     |
| `eventType`  | Domain event type (e.g. `CREATOR_REGISTERED`)        |
| `eventId`    | Stable identifier: `{txHash}:{eventIndex}`           |
| `txHash`     | Transaction hash                                     |
| `eventIndex` | Event index within the transaction                   |
| `ledger`     | Block/ledger number when available                   |
| `elapsedMs`  | Processing duration from handler start to completion |

Use `processIndexerChainEvents` to dedupe a batch and log once per unique event.

## 3. Error Handling

If an event fails to process after multiple retries, it is moved to the [Dead-Letter Queue (DLQ)](./DLQ_WORKFLOW.md) for manual investigation.
