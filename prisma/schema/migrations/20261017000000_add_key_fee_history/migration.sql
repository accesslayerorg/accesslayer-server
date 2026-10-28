-- Fee tier change history indexed from FeeAdjusted contract events.
CREATE TABLE "key_fee_history" (
    "id"                 TEXT NOT NULL,
    "key_id"             TEXT NOT NULL,
    "fee_bps"            INTEGER NOT NULL,
    "previous_fee_bps"   INTEGER,
    "volume_bracket"     TEXT,
    "rolling_24h_volume" TEXT,
    "ledger"             INTEGER NOT NULL,
    "tx_hash"            TEXT NOT NULL,
    "event_index"        INTEGER NOT NULL,
    "timestamp"          TIMESTAMP(3) NOT NULL,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_fee_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "key_fee_history_tx_hash_event_index_key" ON "key_fee_history"("tx_hash", "event_index");

-- CreateIndex
CREATE INDEX "key_fee_history_key_id_timestamp_idx" ON "key_fee_history"("key_id", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "key_fee_history_key_id_idx" ON "key_fee_history"("key_id");
