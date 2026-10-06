-- Portfolio unrealised P&L endpoint (#897): persist lifetime realised P&L per position.
ALTER TABLE "KeyOwnership" ADD COLUMN "realisedPnl" DECIMAL(65,30) DEFAULT 0;
