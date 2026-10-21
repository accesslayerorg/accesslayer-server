-- AlterTable
ALTER TABLE "key_tips" ADD COLUMN "anonymous" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "instalment_payments" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "instalmentNumber" INTEGER NOT NULL,
    "totalInstalments" INTEGER,
    "amount" DECIMAL(30,7) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "payer" TEXT,
    "txHash" TEXT,
    "eventIndex" INTEGER,
    "ledger" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instalment_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instalment_payments_invoiceId_instalmentNumber_key" ON "instalment_payments"("invoiceId", "instalmentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "instalment_payments_txHash_eventIndex_key" ON "instalment_payments"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "instalment_payments_invoiceId_dueDate_idx" ON "instalment_payments"("invoiceId", "dueDate" ASC);

-- CreateIndex
CREATE INDEX "instalment_payments_invoiceId_instalmentNumber_idx" ON "instalment_payments"("invoiceId", "instalmentNumber" ASC);
