-- CreateTable
CREATE TABLE "invoice_protocol_cursor" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "ledger" INTEGER NOT NULL,
    "cursor" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_protocol_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_protocol_events" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "transactionIndex" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "entityKey" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "invoice_protocol_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issuer_scores" (
    "wallet" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "tier" TEXT NOT NULL,
    "lastEventId" TEXT NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issuer_scores_pkey" PRIMARY KEY ("wallet")
);

-- CreateTable
CREATE TABLE "fraud_reports" (
    "reportId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "reporter" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL,
    "resolution" TEXT,
    "resolutionNotes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "fraud_reports_pkey" PRIMARY KEY ("invoiceId","reportId")
);

-- CreateTable
CREATE TABLE "timelock_changes" (
    "proposalId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "function" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "eta" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "outcome" TEXT,
    "proposedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "timelock_changes_pkey" PRIMARY KEY ("proposalId")
);

-- CreateTable
CREATE TABLE "transfer_restriction_events" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "fromWallet" TEXT NOT NULL,
    "toWallet" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "restrictionType" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transfer_restriction_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_limit_orders" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "fromWallet" TEXT NOT NULL,
    "buyerWallet" TEXT NOT NULL,
    "limitPrice" TEXT NOT NULL,
    "transactionXdr" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_limit_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_protocol_events_entityKey_ledger_transactionIndex_e_idx" ON "invoice_protocol_events"("entityKey", "ledger", "transactionIndex", "eventIndex");

-- CreateIndex
CREATE INDEX "invoice_protocol_events_eventType_entityKey_timestamp_idx" ON "invoice_protocol_events"("eventType", "entityKey", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_protocol_events_contractId_txHash_eventIndex_key" ON "invoice_protocol_events"("contractId", "txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "fraud_reports_invoiceId_submittedAt_reportId_idx" ON "fraud_reports"("invoiceId", "submittedAt", "reportId");

-- CreateIndex
CREATE INDEX "fraud_reports_invoiceId_status_idx" ON "fraud_reports"("invoiceId", "status");

-- CreateIndex
CREATE INDEX "timelock_changes_status_proposedAt_proposalId_idx" ON "timelock_changes"("status", "proposedAt", "proposalId");

-- CreateIndex
CREATE INDEX "transfer_restriction_events_invoiceId_timestamp_id_idx" ON "transfer_restriction_events"("invoiceId", "timestamp", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_limit_orders_txHash_key" ON "invoice_limit_orders"("txHash");

-- CreateIndex
CREATE INDEX "invoice_limit_orders_invoiceId_status_createdAt_idx" ON "invoice_limit_orders"("invoiceId", "status", "createdAt");
