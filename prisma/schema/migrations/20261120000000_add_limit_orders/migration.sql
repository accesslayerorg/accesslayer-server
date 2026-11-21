-- #1220: Off-chain limit order storage and price-trigger matching.
-- Orders live in this table until the order matcher flags them EXECUTABLE
-- (price condition met) or EXPIRED (past expiresAt).

CREATE TABLE "limit_orders" (
   "id" TEXT NOT NULL,
   "wallet" TEXT NOT NULL,
   "keyId" TEXT NOT NULL,
   "side" TEXT NOT NULL,
   "targetPrice" DECIMAL(20, 7) NOT NULL,
   "quantity" DECIMAL(20, 7) NOT NULL,
   "status" TEXT NOT NULL DEFAULT 'OPEN',
   "expiresAt" TIMESTAMP(3),
   "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
   "updatedAt" TIMESTAMP(3) NOT NULL,

   CONSTRAINT "limit_orders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "limit_orders_wallet_idx"
   ON "limit_orders" ("wallet");

CREATE INDEX IF NOT EXISTS "limit_orders_keyId_status_idx"
   ON "limit_orders" ("keyId", "status");

CREATE INDEX IF NOT EXISTS "limit_orders_status_createdAt_idx"
   ON "limit_orders" ("status", "createdAt");
