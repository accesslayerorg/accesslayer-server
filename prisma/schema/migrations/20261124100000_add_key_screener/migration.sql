-- CreateTable
CREATE TABLE "saved_screens" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "sort" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_screens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_screens_wallet_createdAt_idx" ON "saved_screens"("wallet", "createdAt" DESC);

-- CreateMaterializedView: key_metrics (#1312)
CREATE MATERIALIZED VIEW IF NOT EXISTS key_metrics AS
WITH volume_24h AS (
    SELECT
        a."creatorId" AS key_id,
        COALESCE(SUM(NULLIF(a.payload->>'amount', '')::numeric), 0) AS volume
    FROM "Activity" a
    WHERE a."creatorId" IS NOT NULL
      AND a.type IN ('KEY_BOUGHT', 'KEY_SOLD')
      AND a."createdAt" >= NOW() - INTERVAL '24 hours'
    GROUP BY a."creatorId"
),
holder_stats AS (
    SELECT
        ko."creatorId" AS key_id,
        COUNT(*) FILTER (WHERE ko.balance > 0)::integer AS holders,
        COALESCE(SUM(ko.balance) FILTER (WHERE ko.balance > 0), 0) AS total_balance
    FROM "KeyOwnership" ko
    GROUP BY ko."creatorId"
),
top10_holders AS (
    SELECT
        ranked.key_id,
        COALESCE(SUM(ranked.balance), 0) AS top10_balance
    FROM (
        SELECT
            ko."creatorId" AS key_id,
            ko.balance,
            ROW_NUMBER() OVER (PARTITION BY ko."creatorId" ORDER BY ko.balance DESC) AS rn
        FROM "KeyOwnership" ko
        WHERE ko.balance > 0
    ) ranked
    WHERE ranked.rn <= 10
    GROUP BY ranked.key_id
)
SELECT
    cp.id AS key_id,
    cp.handle AS handle,
    cp."displayName" AS display_name,
    COALESCE(cps."currentPrice", 0)::numeric AS price,
    CASE
        WHEN COALESCE(cps."price24hAgo", 0) > 0
            THEN ((COALESCE(cps."currentPrice", 0) - cps."price24hAgo")::numeric / cps."price24hAgo"::numeric) * 100
        ELSE 0::numeric
    END AS change,
    COALESCE(v.volume, 0)::numeric AS volume,
    COALESCE(hs.holders, 0)::integer AS holders,
    CASE
        WHEN COALESCE(hs.total_balance, 0) > 0
            THEN (COALESCE(t10.top10_balance, 0)::numeric / hs.total_balance::numeric) * 100
        ELSE 0::numeric
    END AS top10_share
FROM "CreatorProfile" cp
LEFT JOIN creator_price_snapshots cps ON cps."creatorId" = cp.id
LEFT JOIN volume_24h v ON v.key_id = cp.id
LEFT JOIN holder_stats hs ON hs.key_id = cp.id
LEFT JOIN top10_holders t10 ON t10.key_id = cp.id;

CREATE UNIQUE INDEX IF NOT EXISTS key_metrics_key_id_idx ON key_metrics (key_id);
