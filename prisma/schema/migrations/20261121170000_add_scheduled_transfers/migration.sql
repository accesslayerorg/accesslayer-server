CREATE TABLE "scheduled_transfers" (
    "id" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "release_ledger" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scheduled_ledger" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scheduled_transfers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "scheduled_transfers_status_check" CHECK ("status" IN ('pending', 'claimed', 'cancelled')),
    CONSTRAINT "scheduled_transfers_release_check" CHECK ("release_ledger" >= "scheduled_ledger")
);
CREATE INDEX "scheduled_transfers_sender_scheduled_ledger_id_idx" ON "scheduled_transfers"("sender", "scheduled_ledger", "id");
CREATE INDEX "scheduled_transfers_recipient_scheduled_ledger_id_idx" ON "scheduled_transfers"("recipient", "scheduled_ledger", "id");
CREATE INDEX "scheduled_transfers_key_id_idx" ON "scheduled_transfers"("key_id");
CREATE INDEX "scheduled_transfers_status_release_ledger_idx" ON "scheduled_transfers"("status", "release_ledger");

CREATE TABLE "scheduled_transfer_events" (
    "id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "event_index" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scheduled_transfer_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "scheduled_transfer_events_status_check" CHECK ("status" IN ('pending', 'claimed', 'cancelled'))
);
CREATE UNIQUE INDEX "scheduled_transfer_events_tx_hash_event_index_key" ON "scheduled_transfer_events"("tx_hash", "event_index");
CREATE INDEX "scheduled_transfer_events_transfer_id_ledger_event_index_idx" ON "scheduled_transfer_events"("transfer_id", "ledger", "event_index");
