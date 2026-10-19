-- CreateTable
CREATE TABLE "curve_updates" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "outcome" TEXT,
    "proposed_params" JSONB,
    "eta" TIMESTAMP(3),
    "proposer" TEXT,
    "executor" TEXT,
    "executed_at" TIMESTAMP(3),
    "ledger" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "event_index" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "curve_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "curve_updates_key_id_proposal_id_key" ON "curve_updates"("key_id", "proposal_id");

-- CreateIndex
CREATE INDEX "curve_updates_key_id_status_idx" ON "curve_updates"("key_id", "status");

-- CreateIndex
CREATE INDEX "curve_updates_key_id_created_at_idx" ON "curve_updates"("key_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "curve_updates_ledger_idx" ON "curve_updates"("ledger");
