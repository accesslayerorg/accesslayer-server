# Chain Event Processing

The indexer processes events from the blockchain to update the read models and activity feeds. To ensure data consistency and prevent duplicate processing, the following strategies are employed.

## 1. Deduplication

Before processing a batch of events, they should be deduped based on their unique identifier on the chain: `transactionHash` and `eventIndex`.

The `dedupeChainEvents` helper in `src/utils/indexer-dedupe.utils.ts` provides this functionality.

### Example Usage:

```typescript
import { dedupeChainEvents } from '../utils/indexer-dedupe.utils';

const rawEvents = fetchEventsFromChain();
const uniqueEvents = dedupeChainEvents(rawEvents);
// Proceed with processing uniqueEvents
```

## 2. Idempotency

Event handlers must be idempotent. This means that processing the same event multiple times should have the same effect as processing it once.

### Strategies for Idempotency:

- **Database Upserts**: Use Prisma's `upsert` or `update` with unique constraints where possible.
- **State Check**: Before applying a change (like incrementing a balance), verify if the event has already been accounted for (e.g. by checking a `lastProcessedLedger` or a specific event log).
- **Atomic Transactions**: Ensure that all changes related to an event are committed in a single database transaction.

## 3. Error Handling

If an event fails to process after multiple retries, it is moved to the [Dead-Letter Queue (DLQ)](./DLQ_WORKFLOW.md) for manual investigation.
