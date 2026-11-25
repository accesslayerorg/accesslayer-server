-- Partition trades and ingested_events by month (#1333).
-- This migration preserves data. Run on a copy first and verify rollback procedure in docs/partitioning.md.

BEGIN;

-- ----------------------------
-- Trade: range partition by timestamp
-- ----------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname='Trade' AND c.relkind='r'
  ) THEN
    ALTER TABLE "Trade" RENAME TO "Trade_old";

    CREATE TABLE "Trade" (
      "id" TEXT NOT NULL,
      "buyer" TEXT NOT NULL,
      "creatorId" TEXT NOT NULL,
      "quantity" TEXT NOT NULL,
      "price" TEXT NOT NULL,
      "ledger" INTEGER NOT NULL,
      "txHash" TEXT NOT NULL,
      "timestamp" TIMESTAMP(3) NOT NULL,
      "paymentAsset" TEXT NOT NULL DEFAULT 'XLM',
      "type" TEXT NOT NULL DEFAULT 'single',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Trade_pkey" PRIMARY KEY ("id", "timestamp")
    ) PARTITION BY RANGE ("timestamp");

    CREATE TABLE "Trade_pre_2026" PARTITION OF "Trade"
      FOR VALUES FROM (MINVALUE) TO ('2026-01-01T00:00:00Z');
    CREATE TABLE "Trade_2026_01" PARTITION OF "Trade" FOR VALUES FROM ('2026-01-01T00:00:00Z') TO ('2026-02-01T00:00:00Z');
    CREATE TABLE "Trade_2026_02" PARTITION OF "Trade" FOR VALUES FROM ('2026-02-01T00:00:00Z') TO ('2026-03-01T00:00:00Z');
    CREATE TABLE "Trade_2026_03" PARTITION OF "Trade" FOR VALUES FROM ('2026-03-01T00:00:00Z') TO ('2026-04-01T00:00:00Z');
    CREATE TABLE "Trade_2026_04" PARTITION OF "Trade" FOR VALUES FROM ('2026-04-01T00:00:00Z') TO ('2026-05-01T00:00:00Z');
    CREATE TABLE "Trade_2026_05" PARTITION OF "Trade" FOR VALUES FROM ('2026-05-01T00:00:00Z') TO ('2026-06-01T00:00:00Z');
    CREATE TABLE "Trade_2026_06" PARTITION OF "Trade" FOR VALUES FROM ('2026-06-01T00:00:00Z') TO ('2026-07-01T00:00:00Z');
    CREATE TABLE "Trade_2026_07" PARTITION OF "Trade" FOR VALUES FROM ('2026-07-01T00:00:00Z') TO ('2026-08-01T00:00:00Z');
    CREATE TABLE "Trade_2026_08" PARTITION OF "Trade" FOR VALUES FROM ('2026-08-01T00:00:00Z') TO ('2026-09-01T00:00:00Z');
    CREATE TABLE "Trade_2026_09" PARTITION OF "Trade" FOR VALUES FROM ('2026-09-01T00:00:00Z') TO ('2026-10-01T00:00:00Z');
    CREATE TABLE "Trade_2026_10" PARTITION OF "Trade" FOR VALUES FROM ('2026-10-01T00:00:00Z') TO ('2026-11-01T00:00:00Z');
    CREATE TABLE "Trade_2026_11" PARTITION OF "Trade" FOR VALUES FROM ('2026-11-01T00:00:00Z') TO ('2026-12-01T00:00:00Z');
    CREATE TABLE "Trade_2026_12" PARTITION OF "Trade" FOR VALUES FROM ('2026-12-01T00:00:00Z') TO ('2027-01-01T00:00:00Z');
    CREATE TABLE "Trade_2027_01" PARTITION OF "Trade" FOR VALUES FROM ('2027-01-01T00:00:00Z') TO ('2027-02-01T00:00:00Z');
    CREATE TABLE "Trade_2027_02" PARTITION OF "Trade" FOR VALUES FROM ('2027-02-01T00:00:00Z') TO ('2027-03-01T00:00:00Z');
    CREATE TABLE "Trade_future" PARTITION OF "Trade" FOR VALUES FROM ('2027-03-01T00:00:00Z') TO (MAXVALUE);

    INSERT INTO "Trade" (
      "id","buyer","creatorId","quantity","price","ledger","txHash","timestamp","paymentAsset","type","createdAt"
    )
    SELECT
      "id","buyer","creatorId","quantity","price","ledger","txHash","timestamp","paymentAsset","type","createdAt"
    FROM "Trade_old";

    DROP TABLE "Trade_old";
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "Trade_ledger_txHash_timestamp_key" ON "Trade" ("ledger","txHash","timestamp");
CREATE INDEX IF NOT EXISTS "Trade_creatorId_idx" ON "Trade" ("creatorId");
CREATE INDEX IF NOT EXISTS "Trade_buyer_idx" ON "Trade" ("buyer");
CREATE INDEX IF NOT EXISTS "Trade_ledger_idx" ON "Trade" ("ledger");
CREATE INDEX IF NOT EXISTS "Trade_paymentAsset_idx" ON "Trade" ("paymentAsset");
CREATE INDEX IF NOT EXISTS "Trade_creatorId_paymentAsset_idx" ON "Trade" ("creatorId","paymentAsset");
CREATE INDEX IF NOT EXISTS "Trade_buyer_creatorId_timestamp_idx" ON "Trade" ("buyer","creatorId","timestamp");
CREATE INDEX IF NOT EXISTS "Trade_creatorId_timestamp_idx" ON "Trade" ("creatorId","timestamp");
CREATE INDEX IF NOT EXISTS "Trade_timestamp_idx" ON "Trade" ("timestamp");

-- ----------------------------
-- ingested_events: range partition by createdAt
-- ----------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname='ingested_events' AND c.relkind='r'
  ) THEN
    ALTER TABLE "ingested_events" RENAME TO "ingested_events_old";

    CREATE TABLE "ingested_events" (
      "id" TEXT NOT NULL,
      "ledgerSequence" INTEGER NOT NULL,
      "ledgerHash" TEXT NOT NULL,
      "txHash" TEXT NOT NULL,
      "eventIndex" INTEGER NOT NULL,
      "eventType" TEXT NOT NULL,
      "actor" TEXT,
      "creatorId" TEXT,
      "amount" TEXT,
      "priceStroops" TEXT,
      "tradeAt" TIMESTAMP(3),
      "status" "IngestedEventStatus" NOT NULL DEFAULT 'CONFIRMED',
      "reorgedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ingested_events_pkey" PRIMARY KEY ("id", "createdAt")
    ) PARTITION BY RANGE ("createdAt");

    CREATE TABLE "ingested_events_pre_2026" PARTITION OF "ingested_events"
      FOR VALUES FROM (MINVALUE) TO ('2026-01-01T00:00:00Z');
    CREATE TABLE "ingested_events_2026_01" PARTITION OF "ingested_events" FOR VALUES FROM ('2026-01-01T00:00:00Z') TO ('2026-02-01T00:00:00Z');
    CREATE TABLE "ingested_events_2026_02" PARTITION OF "ingested_events" FOR VALUES FROM ('2026-02-01T00:00:00Z') TO ('2026-03-01T00:00:00Z');
    CREATE TABLE "ingested_events_2026_03" PARTITION OF "ingested_events" FOR VALUES FROM ('2026-03-01T00:00:00Z') TO ('2026-04-01T00:00:00Z');
    CREATE TABLE "ingested_events_2026_04" PARTITION OF "ingested_events" FOR VALUES FROM ('2026-04-01T00:00:00Z') TO ('2026-05-01T00:00:00Z');
    CREATE TABLE "ingested_events_2026_05" PARTITION OF "ingested_events" FOR VALUES FROM ('2026-05-01T00:00:00Z') TO ('2026-06-01T00:00:00Z');
    CREATE TABLE "ingested_events_2026_06" PARTITION OF "ingested_events" FOR VALUES FROM ('2026-06-01T00:00:00Z') TO ('2026-07-01T00:00:00Z');
    CREATE TABLE "ingested_events_2026_07" PARTITION OF "ingested_events" FOR VALUES FROM ('2026-07-01T00:00:00Z') TO ('2026-08-01T00:00:00Z');
    CREATE TABLE "ingested_events_2026_08" PARTITION OF "ingested_events" FOR VALUES FROM ('2026-08-01T00:00:00Z') TO ('2026-09-01T00:00:00Z');
    CREATE TABLE "ingested_events_2026_09" PARTITION OF "ingested_events" FOR VALUES FROM ('2026-09-01T00:00:00Z') TO ('2026-10-01T00:00:00Z');
    CREATE TABLE "ingested_events_2026_10" PARTITION OF "ingested_events" FOR VALUES FROM ('2026-10-01T00:00:00Z') TO ('2026-11-01T00:00:00Z');
    CREATE TABLE "ingested_events_2026_11" PARTITION OF "ingested_events" FOR VALUES FROM ('2026-11-01T00:00:00Z') TO ('2026-12-01T00:00:00Z');
    CREATE TABLE "ingested_events_2026_12" PARTITION OF "ingested_events" FOR VALUES FROM ('2026-12-01T00:00:00Z') TO ('2027-01-01T00:00:00Z');
    CREATE TABLE "ingested_events_2027_01" PARTITION OF "ingested_events" FOR VALUES FROM ('2027-01-01T00:00:00Z') TO ('2027-02-01T00:00:00Z');
    CREATE TABLE "ingested_events_2027_02" PARTITION OF "ingested_events" FOR VALUES FROM ('2027-02-01T00:00:00Z') TO ('2027-03-01T00:00:00Z');
    CREATE TABLE "ingested_events_future" PARTITION OF "ingested_events" FOR VALUES FROM ('2027-03-01T00:00:00Z') TO (MAXVALUE);

    INSERT INTO "ingested_events" (
      "id","ledgerSequence","ledgerHash","txHash","eventIndex","eventType","actor","creatorId","amount","priceStroops","tradeAt","status","reorgedAt","createdAt"
    )
    SELECT
      "id","ledgerSequence","ledgerHash","txHash","eventIndex","eventType","actor","creatorId","amount","priceStroops","tradeAt","status","reorgedAt","createdAt"
    FROM "ingested_events_old";

    DROP TABLE "ingested_events_old";
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ingested_events_txHash_eventIndex_createdAt_key" ON "ingested_events" ("txHash","eventIndex","createdAt");
CREATE INDEX IF NOT EXISTS "ingested_events_ledgerSequence_idx" ON "ingested_events" ("ledgerSequence");
CREATE INDEX IF NOT EXISTS "ingested_events_status_idx" ON "ingested_events" ("status");
CREATE INDEX IF NOT EXISTS "ingested_events_creatorId_idx" ON "ingested_events" ("creatorId");
CREATE INDEX IF NOT EXISTS "ingested_events_creatorId_createdAt_idx" ON "ingested_events" ("creatorId","createdAt");
CREATE INDEX IF NOT EXISTS "ingested_events_createdAt_idx" ON "ingested_events" ("createdAt");

COMMIT;
