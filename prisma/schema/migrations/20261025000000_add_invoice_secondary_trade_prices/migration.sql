CREATE TABLE "invoice_secondary_trade_prices" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "price" DECIMAL(65,30) NOT NULL,
  "amount" DECIMAL(65,30) NOT NULL,
  "tradedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "txHash" TEXT,
  CONSTRAINT "invoice_secondary_trade_prices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "invoice_secondary_trade_prices_invoiceId_tradedAt_idx" ON "invoice_secondary_trade_prices"("invoiceId", "tradedAt" DESC);
ALTER TABLE "invoice_secondary_trade_prices" ADD CONSTRAINT "invoice_secondary_trade_prices_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
