-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'daily',
    "events" TEXT[],
    "verifiedAt" TIMESTAMP(3),
    "lastDigestAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_wallet_key" ON "notification_preferences"("wallet");

-- CreateIndex
CREATE INDEX "notification_preferences_verifiedAt_unsubscribedAt_frequency_idx" ON "notification_preferences"("verifiedAt", "unsubscribedAt", "frequency");

-- CreateIndex
CREATE INDEX "notification_preferences_wallet_idx" ON "notification_preferences"("wallet");
