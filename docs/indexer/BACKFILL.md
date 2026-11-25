# Indexer Backfill Runbook

`scripts/backfill.ts` reprocesses a historical ledger range in parallel. Use it after a schema change
or an outage, when the live indexer would take days to catch up. It applies the same domain writers as
the live indexer, but it never moves the live cursor.

## Command

```bash
pnpm exec ts-node --transpile-only scripts/backfill.ts \
  --contract C… --from 1000000 --to 2000000 --shards 16 \
  --concurrency 4 --rps 5 --page-size 200 \
  --source-url https://<indexer-worker>/export --verify
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--contract` | required | Soroban contract id to backfill |
| `--from`, `--to` | required | Inclusive ledger range |
| `--shards` | required | Number of contiguous ledger ranges, 1 to 1024 |
| `--concurrency` | `4` | Shards processed at once |
| `--rps` | `5` | Maximum source requests per second. Keeps the RPC pool free for the live indexer |
| `--page-size` | `200` | Events requested per page |
| `--source-url` | `BACKFILL_EVENT_SOURCE_URL` | Export endpoint of the indexer worker |
| `--verify` | off | Run the verification pass after the backfill |
| `--dry-run` | off | Print the run key and shard ranges, then exit |
| `--allow-live-range` | off | Permit `--to` above the live cursor. Only use this when the range is final |

Use `--dry-run` first. It prints the run key and every shard range, and it does not touch the database.

## Event source

Raw Soroban events are decoded by the external indexer worker, not by this server. The backfill reads
decoded events from the worker's export endpoint:

```
GET {source-url}?contractId=C…&fromLedger=n&toLedger=m&limit=200[&cursor=…]
200 OK  { "events": [ { "txHash", "eventIndex", "ledger", "eventType", … } ], "nextCursor": "…" | null }
```

Each event must carry `txHash`, `eventIndex`, `ledger` and `eventType`, and its ledger must be inside the
requested range. A response that breaks these rules fails the shard, so bad data is never half-applied.

## How it stays safe

- **Resume.** Each shard has a row in `backfill_jobs`. The run key is a hash of contract, range and shard
  count, so re-running the same command skips COMPLETED shards.
- **No duplicates.** Each event is claimed in `ingested_events` on `(txHash, eventIndex)` before it is
  applied. Overlapping ranges and retried shards lose the claim race and skip the event.
- **Failure containment.** A failing event releases its claim and fails only its shard. Other shards
  keep going. Re-run the command to retry the failed shards.
- **Live cursor untouched.** The batch is applied with `advanceCursor: false`.
- **Finalised history only.** Without `--allow-live-range`, the command refuses a `--to` above the live
  cursor (`indexed_ledgers`), because the reorg guard owns ledgers that are not yet final.

### Known limit

The claim and the apply are two steps. A process killed between them leaves an event claimed but not
applied. A re-run skips it. Closing this window needs the domain writers to run inside the claim's
transaction. Until then, check the `--verify` report after any crash.

## Verification

`--verify` runs two checks per shard:

1. Every shard is `COMPLETED`.
2. Every fetched event is accounted for (`inserted + duplicate = fetched`), and the inserted rows are
   still in `ingested_events` for that ledger range.

Balance checks against on-chain contract state are not wired into the CLI yet. The CLI prints this
limit next to the report. Treat a clean verification as "every event was applied once", not as "the
balances match the chain".

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every shard completed and verification (if requested) found nothing |
| `1` | At least one shard failed, a verification mismatch was found, or the live-cursor guard fired |
| `2` | Bad arguments |

## Design notes

- Shards run as concurrent async tasks, not `worker_threads`. The work is I/O bound, and sharing one
  Prisma client avoids a connection pool per thread.
- `ingested_events.ledgerHash` is set to an empty string for backfilled events when the worker does not
  send a hash. Nothing in the reorg guard relies on it for finalised ledgers.

## Related

- [Indexer architecture](./ARCHITECTURE.md)
- [Recovery](./RECOVERY.md)
- [Contributor expectations](./CONTRIBUTOR_EXPECTATIONS.md)
