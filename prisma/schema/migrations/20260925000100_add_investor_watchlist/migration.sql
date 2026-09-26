-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "sellerWallet" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USDC',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rate" DECIMAL(65,30),
    "maturityDate" TIMESTAMP(3),
    "riskRating" TEXT,
    "fundingProgress" DECIMAL(65,30) DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investor_watchlists" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "investor_watchlists_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invoice_sellerWallet_idx" ON "Invoice"("sellerWallet");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "investor_watchlists_walletAddress_idx" ON "investor_watchlists"("walletAddress");

-- CreateIndex
CREATE INDEX "investor_watchlists_invoiceId_idx" ON "investor_watchlists"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "investor_watchlists_walletAddress_invoiceId_key" ON "investor_watchlists"("walletAddress", "invoiceId");

-- AddForeignKey
ALTER TABLE "investor_watchlists" ADD CONSTRAINT "investor_watchlists_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
