# Social Metadata Sync

How on-chain `SocialMetadataUpdated` events from the social metadata extension
contract are indexed into the API read model and served to clients.

## Overview

Creators publish their social profile (display name, bio, avatar, links) via
the **social metadata extension contract**. Each change emits a
`SocialMetadataUpdated` event. The indexer pipeline consumes those events and
keeps a per-creator read model in sync so API responses reflect the latest
on-chain state within the freshness budget.

Key properties:

- **Separate read model.** Social data lives in `CreatorSocialMetadata`, keyed
  by creator. It never overwrites the off-chain `CreatorProfile` fields
  (`displayName`/`bio`/`avatarUrl`) maintained by `PUT /creators/:id/profile`.
- **Attribute-value only.** The sync is additive: absent fields in an event are
  preserved, not cleared.
- **< 60s freshness.** Every indexed event synchronously invalidates creator
  caches, and the social route sets `Cache-Control: public, max-age=60`.

## Data Model

See [`prisma/schema/social-metadata.prisma`](../prisma/schema/social-metadata.prisma).

### `CreatorSocialMetadata` (read model, one row per creator)

| Column             | Notes                                               |
| ------------------ | --------------------------------------------------- |
| `creatorId`        | Unique key                                          |
| `displayName`      | Latest synced value (nullable)                      |
| `bio`              | Latest synced value (nullable)                      |
| `avatarCid`        | Normalized IPFS CID (nullable)                      |
| `avatarUrl`        | Resolved Pinata gateway URL (nullable)              |
| `socialLinks`      | JSON array of `{ label, url }` (nullable)           |
| `sourceLedger`     | Ledger of the event that produced the current state |
| `sourceTxHash`     | Tx hash of the source event                         |
| `sourceEventIndex` | Event index within the tx                           |
| `socialUpdatedAt`  | Off-chain update timestamp carried by the event     |

### `SocialMetadataEvent` (append-only history)

Raw event stream, deduplicated by the `@@unique([txHash, eventIndex])`
constraint and indexed by `creatorId`. Used for auditing and replays.

## Event Shape

Decoded events arrive with `eventType: 'SOCIAL_METADATA_UPDATED'` and the
following optional profile fields:

```json
{
   "eventType": "SOCIAL_METADATA_UPDATED",
   "txHash": "tx-social-1",
   "eventIndex": 0,
   "ledger": 500,
   "creatorId": "creator-1",
   "actor": "GARTISTWALLET",
   "displayName": "Ada Artist",
   "bio": "On-chain bio",
   "avatarCid": "ipfs://bafybeigdyrzt",
   "avatarUrl": "https://cdn.example/avatar.png",
   "socialLinks": [{ "label": "X", "url": "https://x.com/ada?ref=timeline" }],
   "socialUpdatedAt": "2026-10-17T10:00:00.000Z"
}
```

## Processing

`processSocialMetadataUpdatedEvent` in
[`src/modules/indexer/social-metadata-indexer.service.ts`](../src/modules/indexer/social-metadata-indexer.service.ts)
runs per event:

1. **Validate** — skip with a warning when `creatorId` is missing.
2. **Dedupe** — skip when `(txHash, eventIndex)` is already indexed, including
   a `P2002` unique-constraint race on insert.
3. **Normalize** — resolve the avatar CID to a Pinata gateway URL (falling back
   to an explicit `avatarUrl`) and normalize link URLs (`normalizeSocialLinkUrl`
   strips tracking params, lowercases hosts, trims trailing slashes).
4. **Record** — append the raw event to `SocialMetadataEvent`.
5. **Upsert** — write the read model, skipping stale events (older ledger or
   `socialUpdatedAt` than the synced snapshot) so out-of-order replay cannot
   roll state backwards.
6. **Invalidate** — call `invalidateCreatorSocialMetadataCache` synchronously.

`processSocialMetadataEvents` batches events through the shared
`processIndexerChainEvents` engine (dedupe + error isolation) and ignores
non-social event types.

## Pipeline Dispatch

`processIndexerEvents` in
[`src/modules/indexer/indexer-pipeline.service.ts`](../src/modules/indexer/indexer-pipeline.service.ts)
splits each batch:

- social events → `processSocialMetadataEvents`
- trade events → `processTradeEvents(events, { advanceCursor: false })`
- then advances the ledger cursor **once** for the whole batch
  (`advanceIndexerCursorForBatch`, deduped to the max ledger).

This keeps a mixed batch from advancing the cursor more than once.

## HTTP API

### `GET /api/v1/creators/:wallet/social`

`:wallet` accepts a wallet address, creator id, or handle. The response
includes a top-level `social` block with `synced`, `links`, and `source`
metadata. Creators with no indexed event return `200` with `synced: false` and
empty fields. The route sets `Cache-Control: public, max-age=60`.

The creator profile response (`GET /api/v1/creators/:creatorId/profile`) also
embeds the same `social` block and surfaces `social.links` at the top-level
`links` field, while leaving the off-chain profile fields untouched.

## Configuration

| Variable             | Default                             | Purpose                      |
| -------------------- | ----------------------------------- | ---------------------------- |
| `PINATA_GATEWAY_URL` | `https://gateway.pinata.cloud/ipfs` | Base gateway for avatar CIDs |

## Cache Invalidation

Every processed event (even a stale one that does not rewrite the read model)
calls `invalidateCreatorSocialMetadataCache`, which logs
`creator_social_cache_invalidated` and resets the creator list cache. Combined
with the 60-second `max-age`, clients observe updates within the freshness
budget.

## Migrations

The schema is added by
`prisma/schema/migrations/20261017140000_add_social_metadata`. See
[database-migrations.md](./database-migrations.md) for naming and workflow.

## Tests

- `src/utils/pinata-gateway.utils.test.ts` — CID normalization / gateway URLs.
- `src/modules/indexer/social-metadata-indexer.integration.test.ts` — handler
  behavior (dedupe, stale guard, partial updates, normalization).
- `src/modules/indexer/indexer-pipeline-dispatch.integration.test.ts` —
  routing and single cursor advance per batch.
- `src/modules/creators/creator-social.integration.test.ts` — HTTP route.
- `src/modules/creator/creator-profile-social.integration.test.ts` — profile
  `social`/`links` inclusion.
